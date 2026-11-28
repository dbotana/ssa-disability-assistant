package org.ssa.assistant.ui

import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.window.ComposeUIViewController
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.IosResources
import org.ssa.assistant.core.LanguageSettings
import org.ssa.assistant.core.app.AppController
import org.ssa.assistant.core.app.AppPorts
import org.ssa.assistant.core.app.BufferedStt
import org.ssa.assistant.core.app.CaptureBuffer
import org.ssa.assistant.core.app.ExportJob
import org.ssa.assistant.core.app.PlatformServices
import org.ssa.assistant.core.app.SessionException
import org.ssa.assistant.core.app.SessionGate
import org.ssa.assistant.core.app.Summary
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.core.pdf.FormVersions
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.store.SessionStore
import org.ssa.assistant.core.store.StoreException
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.models.onnx.openOnnxSession
import org.ssa.assistant.models.whisper.WhisperConfig
import org.ssa.assistant.models.whisper.WhisperFeatures
import org.ssa.assistant.models.whisper.WhisperTokenizer
import org.ssa.assistant.models.whisper.WhisperTranscriber
import platform.Foundation.NSData
import platform.Foundation.NSDate
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.dataWithContentsOfFile
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.timeIntervalSince1970
import platform.UIKit.UIViewController

/**
 * The iOS entry point: one Compose Multiplatform view controller over the
 * shared screens, with the Swift shell's adapters behind [IosServices]
 * (plan, Phase B2/B3).
 *
 * Everything that decides something is `core`'s: this class only builds the
 * production wiring ([AppPorts], [SessionStore], [SessionGate], [ExportJob],
 * the `WhisperTranscriber`) from the callbacks, and reports state changes by
 * bumping the UI revision.
 */
fun MainViewController(services: IosServices): UIViewController = ShellApp(services).viewController

/**
 * The shared app plus the two commands the Swift shell sends from VoiceOver
 * gestures (plan, Phase C2): Magic Tap toggles the talk button, and the escape
 * gesture closes a read-back or goes back one question.
 */
/**
 * The shared app plus the two commands the Swift shell sends from VoiceOver
 * gestures (plan, Phase C2): Magic Tap toggles the talk button, and the escape
 * gesture closes a read-back or goes back one question.
 */
class ShellApp(services: IosServices) {
    /**
     * The bundle's resource folder must be set before anything loads the
     * schema: `IosBridge`'s initializer runs `SchemaLoader.load()`, which
     * reads `<bundle>/schema.json`, while the shell stages it under
     * `SsaResources/`. This `init` runs before the `bridge` initializer below.
     */
    init {
        services.resourcePath("schema.json")?.let { schemaPath ->
            IosResources.roots = listOf(schemaPath.substringBeforeLast('/'))
        }
    }

    private val bridge = IosBridge(services)

    val viewController: UIViewController = ComposeUIViewController { UiRoot(bridge.controller, bridge) }

    /** False until Setup's Start, when the two gestures would have no session to act on. */
    fun isStarted(): Boolean = bridge.controller.isStarted()

    fun magicTap() = bridge.toggleTalk()

    fun escape() = bridge.escape()
}

private class SessionFailure(val message: String)

private class IosBridge(private val services: IosServices) : UiActions {

    private val schema: Schema = SchemaLoader.load()
    private val i18n = I18n(schema)
    private val scope: CoroutineScope = MainScope()
    private val buffer = CaptureBuffer()
    private val speech = IosSpeechPort(services.speech)
    private val audio = IosAudioPort(services.audio, services.speech, buffer)
    private val store = SessionStore(schema, services.crypto, services.files) { clockMs() / 1000.0 }
    private val gate = SessionGate(schema, store, i18n)
    private val transcriber: Transcriber = LazyTranscriber { buildWhisper() }
    private val stt = BufferedStt(buffer, transcriber)
    private val timers = IosTimers()

    private val revision = mutableStateOf(0)
    private val exportedState = mutableStateOf<List<ExportJob.Ready>>(emptyList())
    private val failedState = mutableStateOf<List<ExportJob.Failed>>(emptyList())

    init {
        services.audio.attach(buffer)
    }

    override val stateRevision: State<Int> get() = revision
    override val exported: State<List<ExportJob.Ready>> get() = exportedState
    override val exportFailed: State<List<ExportJob.Failed>> get() = failedState

    private fun clockMs(): Long = (NSDate().timeIntervalSince1970 * 1000.0).toLong()

    private fun today(): CivilDate = localDateAt(clockMs())

    private val platform: PlatformServices = object : PlatformServices {
        override val store: TurnController.StorePort get() = this@IosBridge.store
        override val speech: TurnController.SpeechPort get() = this@IosBridge.speech
        override val audio: TurnController.AudioPort get() = this@IosBridge.audio
        override val stt: TurnController.SttPort get() = this@IosBridge.stt
        override val timers: TurnController.TimersPort get() = this@IosBridge.timers
        override val clock: () -> Long = { clockMs() }
        override fun localDate(epochMs: Long): CivilDate = localDateAt(epochMs)
        override val announce: (String, Boolean) -> Unit = { text, _ -> services.announce(text) }
        override val onState: (Json.Obj) -> Unit = { revision.value = revision.value + 1 }
        override val onExport: suspend (List<String>, Json.Obj, LanguageSettings) -> Unit =
            { forms, answers, languages -> export(forms, answers, languages) }
        override val onReadBack: suspend (Json.Obj) -> Unit = { answers ->
            val lang = controller.state().languages.output
            // The spoken read-back is not masked: the user asked to hear their
            // own answers, exactly as on the web (src/summary.js).
            speech.speak(Summary.summaryText(schema, answers, lang, i18n), interrupt = true, lang = lang)
        }
    }

    val controller: AppController =
        AppController(schema, TurnController(AppPorts(schema, platform), schema))

    private suspend fun export(forms: List<String>, answers: Json.Obj, languages: LanguageSettings) {
        val job = ExportJob(
            schema = schema,
            today = today(),
            i18n = i18n,
            templateFor = { formId -> templateBytes(formId) },
            fill = services.pdfFill,
            read = services.pdfRead,
        )
        val outcome = job.export(
            forms = forms,
            answers = answers,
            overlay = FormVersions.Overlay(),
            lang = languages.fill,
        )
        exportedState.value = outcome.ready
        failedState.value = outcome.failed
        // Core speaks `downloaded` after this returns, or `pdf_failed` when it
        // throws: an export that produced nothing is a failure.
        if (outcome.ready.isEmpty()) throw IllegalStateException("no form could be exported")
    }

    private fun templateBytes(formId: String): ByteArray {
        val spec = schema.formSpecs[formId] ?: throw IllegalArgumentException("unknown form $formId")
        val path = services.resourcePath(spec.template)
            ?: throw IllegalStateException("no bundled template for $formId")
        return readFileBytes(path)
    }

    override fun openSession(
        resume: Boolean,
        pin: String,
        onProgress: (String) -> Unit,
        done: (TurnController.SavedSession?, String?) -> Unit,
    ) {
        scope.launch {
            // SessionStore derives the key synchronously (PBKDF2, 600,000
            // rounds, about half a second), so the gate runs off the main
            // thread as SessionStore's own comment asks. `onProgress` and
            // `done` are posted back to the main thread.
            val outcome: Any? = withContext(Dispatchers.Default) {
                try {
                    gate.open(
                        resume = resume,
                        pin = pin,
                        onProgress = { text -> scope.launch { onProgress(text) } },
                    ).saved
                } catch (e: SessionException) {
                    SessionFailure(SessionGate.messageFor(e, i18n))
                } catch (e: StoreException) {
                    SessionFailure(SessionGate.messageFor(e, i18n))
                } catch (e: Exception) {
                    SessionFailure(SessionGate.messageFor(e, i18n))
                }
            }
            if (outcome is SessionFailure) done(null, outcome.message)
            else done(outcome as TurnController.SavedSession?, null)
        }
    }

    override fun share(file: ExportJob.Ready) = services.share(file.bytes, file.fileName)

    override fun eraseEverything() {
        store.clearState()
        store.forgetKey()
        revision.value = revision.value + 1
    }

    override fun savedSessionAt(): Double? = store.savedSessionInfo()

    /** Magic Tap: start recording, or stop it. */
    fun toggleTalk() {
        // Before Setup's Start there is no engine, and every one of these
        // calls ends in `snapshot()`'s `engine!!`. An uncaught exception on
        // Kotlin/Native's main queue ends the process, so refuse here.
        if (!controller.isStarted()) return
        scope.launch {
            if (audio.isRecording()) controller.onTalkUp() else controller.onTalkDown()
        }
    }

    /** The escape gesture: close a read-back, or go back one question. */
    fun escape() {
        if (!controller.isStarted()) return
        scope.launch {
            if (controller.state().readbackOpen) controller.rejectReadBack()
            else controller.runCommand("back")
        }
    }

    // -- Whisper ------------------------------------------------------------------

    private fun readText(name: String): String {
        val path = services.resourcePath(name) ?: throw IllegalStateException("missing bundled resource $name")
        return NSString.stringWithContentsOfFile(path, NSUTF8StringEncoding, null)
            ?: throw IllegalStateException("unreadable bundled resource $name")
    }

    private fun buildWhisper(): Transcriber {
        fun path(name: String): String =
            services.resourcePath(name) ?: throw IllegalStateException("missing bundled resource $name")
        val encoder = openOnnxSession(path("models/whisper-base.en/onnx/encoder_model_quantized.onnx"))
        val decoder = openOnnxSession(path("models/whisper-base.en/onnx/decoder_model_merged_quantized.onnx"))
        val tokenizer = WhisperTokenizer.fromJson(
            readText("models/whisper-base.en/tokenizer.json"),
            readText("models/whisper-base.en/tokenizer_config.json"),
        )
        val config = WhisperConfig.fromJson(
            readText("models/whisper-base.en/config.json"),
            readText("models/whisper-base.en/generation_config.json"),
        )
        val features = WhisperFeatures.fromJson(readText("models/whisper-base.en/preprocessor_config.json"))
        return WhisperTranscriber(encoder, decoder, tokenizer, config, features)
    }
}

private fun readFileBytes(path: String): ByteArray {
    val data = NSData.dataWithContentsOfFile(path) ?: throw IllegalStateException("unreadable bundled file")
    val length = data.length.toInt()
    val pointer = data.bytes ?: return ByteArray(0)
    return pointer.reinterpret<ByteVar>().readBytes(length)
}
