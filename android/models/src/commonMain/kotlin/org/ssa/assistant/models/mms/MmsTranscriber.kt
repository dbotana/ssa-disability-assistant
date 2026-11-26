package org.ssa.assistant.models.mms

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.OnnxSession
import kotlin.time.Duration
import kotlin.time.TimeSource

/** One MMS transcription, with the three phase timings kept separate for reporting. */
class MmsResult(
    /** The argmax id of every frame, `T` of them. */
    val frameIds: IntArray,
    /** [frameIds] with repeats merged and blanks dropped ([CtcGreedy.collapse]). */
    val ids: IntArray,
    /** The raw text; cleaning it is `:core`'s job (`cleanTranscript()`). */
    val text: String,
    val features: Duration,
    val model: Duration,
    val decode: Duration,
)

/**
 * One exported MMS ASR graph (Decision 5): each export has its adapter baked in, so a language
 * is a graph. [code] is the app's language code (`ln`, `fr`, `en`); [open] opens the graph's
 * session (fp32 `model.onnx` or q8 `q8/model_quantized.onnx`) and is called only when the
 * transcriber switches to this graph; [tokenizer] is that folder's `vocab[target_lang]`.
 */
class MmsGraph(
    val code: String,
    val open: () -> OnnxSession,
    val tokenizer: CtcTokenizer,
)

/**
 * The MMS (`mms-1b-all`) implementation of `:core`'s [Transcriber] port: features, one ONNX run
 * and greedy CTC decoding, exactly as transformers 4.53.3's ASR pipeline for CTC (Decisions 3,
 * 4 and 7).
 *
 * At most one graph is open (Decision 5, "load one model at a time"): asking for another
 * language closes the open session before the new one is opened. The graph takes
 * `input_values` `[1, n]` float32 and gives `logits` `[1, T, V]`, and `V` must equal the
 * tokenizer's vocabulary size.
 *
 * Inference runs on [dispatcher], as `WhisperTranscriber`'s does, so the caller's thread (the
 * main thread, under the one-thread rule) is never blocked; [transcribe] also holds a lock, so
 * two calls never switch graphs under each other. [transcribeDetailed] is the same work without
 * the lock or the dispatcher, for tests, and [close] must not overlap a transcription.
 */
class MmsTranscriber(
    graphs: List<MmsGraph>,
    private val features: Wav2Vec2Features,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : Transcriber {
    private val graphs: Map<String, MmsGraph>
    private val lock = Mutex()
    private var current: MmsGraph? = null
    private var session: OnnxSession? = null

    init {
        require(graphs.isNotEmpty()) { "MmsTranscriber needs at least one graph" }
        val byCode = LinkedHashMap<String, MmsGraph>()
        for (graph in graphs) {
            require(byCode.put(graph.code, graph) == null) { "two MMS graphs are given for language ${graph.code}" }
        }
        this.graphs = byCode
    }

    /** The language codes this transcriber has a graph for, in the order given. */
    val languages: List<String> get() = graphs.keys.toList()

    /** The language whose graph is open now, or null when none is. */
    val openLanguage: String? get() = current?.code

    /**
     * Transcribes [samples] (16 kHz mono floats in [-1, 1]) with [lang]'s graph, switching graphs
     * if needed. [onLogits] sees the `logits` tensor before it is decoded.
     */
    fun transcribeDetailed(
        samples: FloatArray,
        lang: String,
        onLogits: ((FloatTensor) -> Unit)? = null,
    ): MmsResult {
        val graph = graphs[lang] ?: throw IllegalArgumentException(
            "MMS has no graph for language $lang; it has ${graphs.keys.joinToString()}",
        )
        require(samples.size <= MAX_SAMPLES) {
            "MMS takes at most 30 s of audio ($MAX_SAMPLES samples at ${features.samplingRate} Hz); " +
                "this clip has ${samples.size} samples, and chunking is not implemented"
        }
        require(samples.isNotEmpty()) { "MMS needs at least one sample to transcribe" }
        val session = sessionFor(graph)

        val featureStart = TimeSource.Monotonic.markNow()
        val inputValues = features.compute(samples)
        val featureTime = featureStart.elapsedNow()

        val modelStart = TimeSource.Monotonic.markNow()
        val result = session.run(
            mapOf(INPUT to FloatTensor(inputValues, longArrayOf(1L, inputValues.size.toLong()))),
            listOf(OUTPUT),
        )
        val modelTime = modelStart.elapsedNow()
        val logits = result[OUTPUT] as? FloatTensor
            ?: throw IllegalStateException("the $lang graph produced no float32 $OUTPUT")
        val shape = logits.shape
        check(shape.size == 3 && shape[0] == 1L) {
            "the $lang graph's $OUTPUT must be [1, frames, vocabulary], got ${shape.contentToString()}"
        }
        val frames = shape[1].toInt()
        val vocabulary = shape[2].toInt()
        check(vocabulary == graph.tokenizer.vocabSize) {
            "the $lang graph's $OUTPUT have $vocabulary values per frame, but its tokenizer's vocabulary " +
                "(${graph.tokenizer.targetLang}) has ${graph.tokenizer.vocabSize} ids"
        }
        onLogits?.invoke(logits)

        val decodeStart = TimeSource.Monotonic.markNow()
        val frameIds = CtcGreedy.argmax(logits.data, frames, vocabulary)
        val ids = CtcGreedy.collapse(frameIds, graph.tokenizer.blankId)
        val text = graph.tokenizer.decode(frameIds)
        val decodeTime = decodeStart.elapsedNow()

        return MmsResult(frameIds, ids, text, featureTime, modelTime, decodeTime)
    }

    /** Returns only the raw transcript; the caller cleans it with `cleanTranscript()`. */
    override suspend fun transcribe(samples: FloatArray, lang: String): String =
        lock.withLock { withContext(dispatcher) { transcribeDetailed(samples, lang).text } }

    /** Closes the open graph, if any. The next transcription opens its graph again. */
    fun close() {
        val open = session
        session = null
        current = null
        open?.close()
    }

    private fun sessionFor(graph: MmsGraph): OnnxSession {
        val open = session
        if (open != null && current === graph) return open
        // Decision 5: the old graph is closed before the new one is opened.
        close()
        val opened = graph.open()
        try {
            requireMmsSession(opened, "the ${graph.code} graph")
        } catch (e: Throwable) {
            opened.close()
            throw e
        }
        session = opened
        current = graph
        return opened
    }

    companion object {
        /** Decision 7: 30 s at 16 kHz. Longer clips are refused until chunking exists. */
        const val MAX_SAMPLES: Int = 480_000
        internal const val INPUT = "input_values"
        internal const val OUTPUT = "logits"
    }
}

/** An MMS graph takes only `input_values` and gives `logits`, as optimum exports them. */
internal fun requireMmsSession(session: OnnxSession, what: String) {
    require(session.inputNames == listOf(MmsTranscriber.INPUT)) {
        "$what takes ${session.inputNames}; MMS feeds only ${MmsTranscriber.INPUT}"
    }
    require(MmsTranscriber.OUTPUT in session.outputNames) {
        "$what has no ${MmsTranscriber.OUTPUT} output; it gives ${session.outputNames}"
    }
}
