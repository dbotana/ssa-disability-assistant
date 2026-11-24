package org.ssa.assistant.models.whisper

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.OnnxSession
import kotlin.time.Duration
import kotlin.time.TimeSource

/** One transcription, with the three phase timings kept separate for reporting. */
data class WhisperResult(
    val ids: LongArray,
    val text: String,
    val features: Duration,
    val encoder: Duration,
    val decoder: Duration,
)

/**
 * The Whisper base.en implementation of `:core`'s [Transcriber] port.
 *
 * The three ONNX steps are deterministic and take their own dispatcher so the
 * caller's audio callback is never blocked. Cleaning the returned raw text is
 * `:core`'s job (`cleanTranscript()`), not the model's.
 */
class WhisperTranscriber(
    private val encoder: OnnxSession,
    private val decoder: OnnxSession,
    private val tokenizer: WhisperTokenizer,
    private val config: WhisperConfig,
    private val features: WhisperFeatures = WhisperFeatures(),
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : Transcriber {
    private val decoderLoop = WhisperDecoder(decoder, config)

    /**
     * Runs the full pipeline and returns ids, raw text and phase timings.
     * [onStep] sees the sequence length before each generated token is appended
     * and that step's (possibly begin-suppressed) scores.
     */
    fun transcribeDetailed(
        samples: FloatArray,
        lang: String,
        onStep: ((Int, FloatArray) -> Unit)? = null,
    ): WhisperResult {
        require(lang == "en") {
            "whisper-base.en is English-only; transcribe was asked for language $lang"
        }
        require(samples.size <= features.nSamples) {
            "Whisper takes at most 30 s of audio (${features.nSamples} samples at " +
                "${features.samplingRate} Hz); this clip has ${samples.size} samples, " +
                "and chunking is not implemented"
        }

        val featureStart = TimeSource.Monotonic.markNow()
        val inputFeatures = features.compute(samples)
        val featureTime = featureStart.elapsedNow()

        val encoderStart = TimeSource.Monotonic.markNow()
        val encoderResult = encoder.run(
            mapOf(
                "input_features" to FloatTensor(
                    inputFeatures,
                    longArrayOf(1L, features.featureSize.toLong(), features.nbMaxFrames.toLong()),
                ),
            ),
            listOf("last_hidden_state"),
        )
        val hidden = encoderResult["last_hidden_state"] as? FloatTensor
            ?: throw IllegalStateException("the encoder produced no float32 last_hidden_state")
        val encoderTime = encoderStart.elapsedNow()

        val decoderStart = TimeSource.Monotonic.markNow()
        val ids = decoderLoop.generate(hidden, onStep)
        val decoderTime = decoderStart.elapsedNow()

        return WhisperResult(
            ids = ids,
            text = tokenizer.decode(ids),
            features = featureTime,
            encoder = encoderTime,
            decoder = decoderTime,
        )
    }

    /** Returns only the raw transcript; the caller cleans it with `cleanTranscript()`. */
    override suspend fun transcribe(samples: FloatArray, lang: String): String =
        withContext(dispatcher) { transcribeDetailed(samples, lang).text }
}
