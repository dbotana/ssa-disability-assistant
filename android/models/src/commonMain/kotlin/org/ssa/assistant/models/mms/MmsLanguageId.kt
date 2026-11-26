package org.ssa.assistant.models.mms

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.ssa.assistant.core.model.LanguageId
import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.OnnxSession
import kotlin.math.exp
import kotlin.time.Duration
import kotlin.time.TimeSource

/** One language-ID run on the first [MmsLanguageId.windowSamples] samples of a clip. */
class MmsLanguageIdResult(
    /** The graph's logits over every label, in label order. */
    val logits: FloatArray,
    /** The label of the largest logit over all labels (the first on a tie). */
    val topLabel: String,
    /** The softmax over all labels, for each candidate label (`lin`, `fra`, `eng`), in candidate order. */
    val probabilities: Map<String, Double>,
    /** The candidate label with the highest probability (the first on a tie). */
    val bestLabel: String,
    val bestProbability: Double,
    /** What [MmsLanguageId.detect] returns: [bestLabel]'s code, or null below `minProbability`. */
    val code: String?,
    /** How many samples the graph saw: the window, or the whole clip when it is shorter. */
    val samples: Int,
    val features: Duration,
    val model: Duration,
)

/**
 * `facebook/mms-lid-126` behind `:core`'s [LanguageId] port (Decision 6):
 *  - the first [windowSamples] samples (3 s at 16 kHz), or the whole clip when it is shorter,
 *    normalized on their own with [features] (feature_extraction_wav2vec2.py:98, as for ASR);
 *  - the graph's `logits` `[1, labels]` (`input_values` `[1, n]` in, as the ASR graphs);
 *  - the softmax over ALL labels, as transformers' audio-classification pipeline takes it
 *    (pipelines/audio_classification.py:227-228, which does it in float32 torch; here and in the
 *    golden it is computed in Double from the float32 logits, with the maximum subtracted);
 *  - then only [candidates] count (`lin`, `fra`, `eng`, mapped to `ln`, `fr`, `en`), and the code
 *    is null when the best of them is below [minProbability]. There are no Lingala recordings to
 *    set it from yet (4.4), so it has no default.
 *
 * The session opens on the first detection and stays open until [close]. Inference runs on
 * [dispatcher], and [detect] holds a lock, as [MmsTranscriber.transcribe] does.
 */
class MmsLanguageId(
    private val open: () -> OnnxSession,
    val labels: List<String>,
    private val features: Wav2Vec2Features,
    val minProbability: Double,
    val windowSamples: Int = 48_000,
    val candidates: Map<String, String> = mapOf("lin" to "ln", "fra" to "fr", "eng" to "en"),
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : LanguageId {
    private val lock = Mutex()
    private var session: OnnxSession? = null
    private val candidateIndices: Map<String, Int>

    init {
        require(labels.isNotEmpty()) { "MmsLanguageId needs the graph's labels" }
        require(labels.toSet().size == labels.size) { "the language-ID labels are not distinct" }
        require(candidates.isNotEmpty()) { "MmsLanguageId needs at least one candidate label" }
        require(!minProbability.isNaN() && minProbability in 0.0..1.0) {
            "minProbability must be a probability, got $minProbability"
        }
        require(windowSamples > 0) { "windowSamples must be positive, got $windowSamples" }
        candidateIndices = candidates.keys.associateWith { label ->
            val index = labels.indexOf(label)
            require(index >= 0) { "the candidate label $label is not one of the graph's ${labels.size} labels" }
            index
        }
    }

    /** True while the graph's session is open. */
    val isOpen: Boolean get() = session != null

    fun detectDetailed(samples: FloatArray): MmsLanguageIdResult {
        require(samples.isNotEmpty()) { "language ID needs at least one sample" }
        val window = if (samples.size > windowSamples) samples.copyOf(windowSamples) else samples

        val featureStart = TimeSource.Monotonic.markNow()
        val inputValues = features.compute(window)
        val featureTime = featureStart.elapsedNow()

        val session = session()
        val modelStart = TimeSource.Monotonic.markNow()
        val result = session.run(
            mapOf(MmsTranscriber.INPUT to FloatTensor(inputValues, longArrayOf(1L, inputValues.size.toLong()))),
            listOf(MmsTranscriber.OUTPUT),
        )
        val modelTime = modelStart.elapsedNow()
        val logitsTensor = result[MmsTranscriber.OUTPUT] as? FloatTensor
            ?: throw IllegalStateException("the language-ID graph produced no float32 ${MmsTranscriber.OUTPUT}")
        val shape = logitsTensor.shape
        check(shape.size == 2 && shape[0] == 1L && shape[1] == labels.size.toLong()) {
            "the language-ID graph's ${MmsTranscriber.OUTPUT} must be [1, ${labels.size}], got ${shape.contentToString()}"
        }
        val logits = logitsTensor.data

        val probabilities = softmax(logits)
        val byCandidate = LinkedHashMap<String, Double>()
        var bestLabel: String? = null
        var bestProbability = Double.NaN
        for ((label, index) in candidateIndices) {
            val p = probabilities[index]
            byCandidate[label] = p
            if (bestLabel == null || p > bestProbability) {
                bestLabel = label
                bestProbability = p
            }
        }
        val best = bestLabel ?: throw IllegalStateException("no candidate label")
        // A NaN probability (from a NaN logit) is never at or above the threshold.
        val code = if (bestProbability >= minProbability) candidates.getValue(best) else null

        return MmsLanguageIdResult(
            logits = logits,
            topLabel = labels[argmaxRow(logits, 0, logits.size)],
            probabilities = byCandidate,
            bestLabel = best,
            bestProbability = bestProbability,
            code = code,
            samples = window.size,
            features = featureTime,
            model = modelTime,
        )
    }

    /** The best of `ln`, `fr` and `en`, or null when unsure; Lingala is the caller's fallback (4.4). */
    override suspend fun detect(samples: FloatArray): String? =
        lock.withLock { withContext(dispatcher) { detectDetailed(samples).code } }

    /** Closes the session, if open. The next detection opens it again. */
    fun close() {
        val open = session
        session = null
        open?.close()
    }

    private fun session(): OnnxSession {
        session?.let { return it }
        val opened = open()
        try {
            requireMmsSession(opened, "the language-ID graph")
        } catch (e: Throwable) {
            opened.close()
            throw e
        }
        session = opened
        return opened
    }
}

/** Softmax in Double over float32 logits, the maximum subtracted first; all NaN if one is NaN. */
internal fun softmax(logits: FloatArray): DoubleArray {
    var max = Double.NEGATIVE_INFINITY
    for (value in logits) {
        if (value.isNaN()) return DoubleArray(logits.size) { Double.NaN }
        if (value > max) max = value.toDouble()
    }
    val out = DoubleArray(logits.size) { exp(logits[it].toDouble() - max) }
    var sum = 0.0
    for (value in out) sum += value
    for (i in out.indices) out[i] /= sum
    return out
}
