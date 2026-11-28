package org.ssa.assistant.core.app

import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.core.turn.TurnController

/** A capture that will not be transcribed. `kind` is "empty" or "too_long". */
class CaptureException(message: String, val kind: String) : Exception(message)

/**
 * The last capture, handed from the audio adapter to the speech-to-text
 * adapter (plan, Phase A5).
 *
 * [TurnController.Blob] carries no samples — it is a size and an optional
 * scripted text, so the state machine and its goldens never see audio. The
 * real path is this buffer: the platform's `AudioPort` writes the 16 kHz mono
 * float samples of the capture it just stopped into [put], and the platform's
 * `SttPort` reads them back with [transcribe].
 *
 * The 30-second limit is Whisper's (Run 8, Decision 6: `WhisperTranscriber`
 * rejects more than 30 s instead of chunking), and it is checked here too so
 * an over-long capture is refused before it reaches the model.
 *
 * Every method runs on the main thread, as all `core` calls do; the model
 * itself runs on a background dispatcher inside its own adapter.
 */
class CaptureBuffer(
    /** 16 kHz mono float32, the rate both `:models` and `tools/stt-eval.mjs` read. */
    val sampleRate: Int = 16_000,
) {
    private var samples: FloatArray = FloatArray(0)
    private var speech = false
    private var peak = 0.0

    /** The most samples Whisper accepts: 30 s at [sampleRate] (480,000 at 16 kHz). */
    val maxSamples: Int get() = sampleRate * MAX_SECONDS

    val size: Int get() = samples.size

    /** Whether the last capture was above the platform's speech threshold. */
    val hadSpeech: Boolean get() = speech

    /** The last capture's peak amplitude, as the platform measured it. */
    val lastPeak: Double get() = peak

    val durationMs: Int get() = if (sampleRate <= 0) 0 else (samples.size * 1000) / sampleRate

    /**
     * Store a finished capture. The array is copied, so the audio adapter may
     * reuse its conversion buffer.
     */
    fun put(samples: FloatArray, hadSpeech: Boolean, peak: Double) {
        this.samples = samples.copyOf()
        this.speech = hadSpeech
        this.peak = peak
    }

    /** Forget the last capture, for example after a cancellation. */
    fun clear() {
        samples = FloatArray(0)
        speech = false
        peak = 0.0
    }

    /** A copy of the last capture's samples. */
    fun take(): FloatArray = samples.copyOf()

    /**
     * Transcribe the last capture.
     *
     * @throws CaptureException "empty" when nothing was captured, "too_long"
     *   when the capture is longer than 30 s.
     */
    suspend fun transcribe(transcriber: Transcriber, lang: String = "en"): String {
        val clip = samples
        if (clip.isEmpty()) throw CaptureException("nothing was heard", "empty")
        if (clip.size > maxSamples) {
            throw CaptureException("the recording is longer than ${MAX_SECONDS} seconds", "too_long")
        }
        return transcriber.transcribe(clip.copyOf(), lang)
    }

    companion object {
        const val MAX_SECONDS = 30
    }
}

/**
 * `core`'s speech-to-text port over [CaptureBuffer] and a [Transcriber].
 *
 * The platform builds one with its `WhisperTranscriber` (on iOS, from `:models`
 * and the `models/whisper-base.en` files). [TurnController.Blob] is ignored
 * for the audio itself: the samples are in the buffer.
 *
 * Every failure is a [TurnController.SttError], never a bare exception: the
 * turn loop catches that kind and speaks the catalogue's `ERRORS` line, while
 * an escaped `CaptureException` or model-load failure would reach the UI's
 * coroutine and, on iOS, end the app. The message names no answer.
 */
class BufferedStt(
    private val buffer: CaptureBuffer,
    private val transcriber: Transcriber,
) : TurnController.SttPort {
    override suspend fun transcribe(blob: TurnController.Blob): String = try {
        buffer.transcribe(transcriber)
    } catch (e: CaptureException) {
        throw TurnController.SttError(if (e.kind == "empty") "empty" else "unknown")
    } catch (e: Exception) {
        // A model-load failure, an out-of-memory from ONNX Runtime, anything
        // else the adapter throws.
        throw TurnController.SttError("unknown")
    }
}
