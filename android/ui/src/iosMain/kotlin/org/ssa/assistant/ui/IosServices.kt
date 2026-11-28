package org.ssa.assistant.ui

import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.app.CaptureBuffer
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.core.store.Crypto
import org.ssa.assistant.core.store.FileStore
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.core.app.PdfFillService
import org.ssa.assistant.core.pdf.PdfReadPort
import platform.Foundation.NSDate
import platform.Foundation.NSTimeZone
import platform.Foundation.dateWithTimeIntervalSince1970
import platform.Foundation.localTimeZone

/**
 * Everything the Swift shell supplies to the shared UI (plan, Phase B2/B3).
 *
 * Every member is either a Kotlin interface Swift implements with callback
 * methods only (`Crypto`, `PdfFillService`, `PdfReadPort`, `FileStore`) or a
 * small callback interface declared here for the same reason: a Swift class
 * cannot implement a Kotlin `suspend` function, so Kotlin wraps each callback
 * with `suspendCancellableCoroutine` (see [IosSpeechPort]).
 */
interface IosServices {
    /** `CoreCrypto` in ios/CoreCrypto: PBKDF2 and AES-256-GCM. */
    val crypto: Crypto

    /** `SsaPdf`'s `PdfWriter`: the JS writer in JavaScriptCore. */
    val pdfFill: PdfFillService

    /** `SsaPdf`'s `CgPdfReadPort`: the self-check's reader. */
    val pdfRead: PdfReadPort

    /** `AVSpeechSynthesizer`, waiting for VoiceOver to finish first. */
    val speech: IosSpeech

    /** `AVAudioEngine` capture, converted to 16 kHz mono float32. */
    val audio: IosAudioCapture

    /** The `SessionStore` file, in Application Support with complete protection. */
    val files: FileStore

    /** `UIAccessibility.post(notification: .announcement, ...)`. */
    fun announce(text: String)

    /** The share sheet, or the document picker when the user saves. */
    fun share(bytes: ByteArray, fileName: String)

    /**
     * An absolute path to a bundled resource, or null. [name] is a path under
     * the app's resource folder, for example
     * `"models/whisper-base.en/tokenizer.json"`.
     */
    fun resourcePath(name: String): String?
}

/** `AVSpeechSynthesizer` behind a callback: `done` runs when speech has finished. */
interface IosSpeech {
    /**
     * Speak [text] with an on-device en-US voice. [done] is called after the
     * utterance and any VoiceOver announcement in progress have finished.
     */
    fun speak(text: String, interrupt: Boolean, lang: String, done: () -> Unit)

    fun cancel()

    /** True while an utterance or an announcement is playing. */
    fun isSpeaking(): Boolean
}

/** What one finished capture measured (the samples go to [CaptureBuffer]). */
class IosCaptureInfo(val durationMs: Int, val hadSpeech: Boolean, val peak: Double)

/**
 * `AVAudioEngine` capture.
 *
 * Kotlin creates the [CaptureBuffer] and hands it over with [attach]; every
 * finished capture is written into it, 16 kHz mono float32.
 *
 * An interruption pauses the engine and reports a capture with no samples.
 * `core`'s `sendAudio` rejects an empty blob with `REASK.nothingHeard` before
 * the transcriber runs, so today an interruption still says "I did not hear
 * anything" — not what plan C3 asks. Changing that needs a `src/turn.js` path
 * first (TODO.md, and the Progress entry); this adapter cannot do it alone.
 */
interface IosAudioCapture {
    fun attach(buffer: CaptureBuffer)

    /** False when the microphone could not be opened (the shell switches to typing). */
    fun start(): Boolean

    fun stop(): IosCaptureInfo

    fun cancel()

    fun isRecording(): Boolean

    fun release()
}

// -- Kotlin adapters over the callbacks ------------------------------------------

/** `TurnController.SpeechPort` over [IosSpeech]: the callback becomes a suspension. */
class IosSpeechPort(private val speech: IosSpeech) : TurnController.SpeechPort {
    override suspend fun speak(text: String, interrupt: Boolean, lang: String) {
        suspendCancellableCoroutine<Unit> { cont ->
            var answered = false
            speech.speak(text, interrupt, lang) {
                if (!answered) {
                    answered = true
                    cont.resume(Unit)
                }
            }
        }
    }

    override fun cancel() = speech.cancel()
}

/**
 * `TurnController.AudioPort` over [IosAudioCapture].
 *
 * The half-duplex rule lives here as well as in `core`: speech is cancelled
 * before the microphone opens, so the phone never records while it plays.
 */
class IosAudioPort(
    private val capture: IosAudioCapture,
    private val speech: IosSpeech,
    private val buffer: CaptureBuffer,
) : TurnController.AudioPort {
    private var started = false
    private var last = IosCaptureInfo(0, false, 0.0)

    override suspend fun startRecording(options: Json.Obj) {
        if (speech.isSpeaking()) speech.cancel()
        buffer.clear()
        started = capture.start()
    }

    override suspend fun stopRecording(): TurnController.Blob {
        if (!started) return TurnController.Blob(0, null)
        started = false
        last = capture.stop()
        // `sendAudio` rejects a blob smaller than 800, and on the web that
        // number is the recording's *size in bytes* (`src/turn.js:429`), not a
        // duration. The samples are 16 kHz mono float32, so four bytes each.
        // The real duration gate is `lastCaptureDurationMs() >= MIN_CAPTURE_MS`.
        return TurnController.Blob(buffer.size * 4, null)
    }

    override fun cancelRecording() {
        started = false
        capture.cancel()
        buffer.clear()
    }

    override fun isRecording(): Boolean = capture.isRecording()
    override fun lastCaptureDurationMs(): Int = last.durationMs
    override fun lastCaptureHadSpeech(): Boolean = last.hadSpeech
    override fun lastCapturePeak(): Double = last.peak
    override fun releaseMic() = capture.release()
    override fun earcon(name: String) {}
}

/**
 * `TurnController.TimersPort` over `dispatch_after` on the main queue. The
 * controller's idle lock and hands-free pause are the only users.
 */
class IosTimers : TurnController.TimersPort {
    private val scope: CoroutineScope = MainScope()
    private val cancelled = mutableSetOf<String>()
    private var next = 1

    override fun setTimeout(fn: suspend () -> Unit, ms: Long): String {
        val id = "ios-${next++}"
        val whenNs = maxOf(0L, ms) * 1_000_000L
        platform.darwin.dispatch_after(
            platform.darwin.dispatch_time(platform.darwin.DISPATCH_TIME_NOW, whenNs),
            platform.darwin.dispatch_get_main_queue(),
        ) {
            if (id in cancelled) {
                cancelled.remove(id)
                return@dispatch_after
            }
            scope.launch { fn() }
        }
        return id
    }

    override fun clearTimeout(id: String?) {
        if (id != null) cancelled.add(id)
    }
}

/** Builds the transcriber once, on a background dispatcher, on first use. */
class LazyTranscriber(private val build: () -> Transcriber) : Transcriber {
    private var delegate: Transcriber? = null

    override suspend fun transcribe(samples: FloatArray, lang: String): String {
        val transcriber = delegate ?: withContext(Dispatchers.Default) { build() }.also { delegate = it }
        return transcriber.transcribe(samples, lang)
    }
}

/** The device's local calendar date at [epochMs], through NSTimeZone's offset. */
fun localDateAt(epochMs: Long): CivilDate {
    val date = NSDate.dateWithTimeIntervalSince1970(epochMs / 1000.0)
    val offsetSeconds = NSTimeZone.localTimeZone.secondsFromGMTForDate(date)
    return CivilDate.ofEpochMillis(epochMs, offsetSeconds * 1000L)
}
