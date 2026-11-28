package org.ssa.assistant.core.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.LanguageSettings
import org.ssa.assistant.core.golden.runTestBlocking
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.turn.TurnController

/**
 * Plan C5: a scripted interview through [AppController], with a scripted
 * transcriber — the app-level path, not the turn golden's harness.
 *
 * The speech-to-text side is the *production* wiring: a real [CaptureBuffer]
 * written by the audio port and read by [BufferedStt]. Only the capture and
 * the model are fakes. It runs on the JVM with `:core:jvmTest` and on the iOS
 * simulator with `:core:iosSimulatorArm64Test`.
 *
 * (A Swift-side copy would have to implement `Transcriber`, whose one function
 * is `suspend`, which the plan's "Swift implements only callback interfaces"
 * rule forbids.)
 */
class ScriptedInterviewTest {
    private val schema = SchemaLoader.load()

    /** Answers in order; the last one repeats. */
    private class ScriptedTranscriber(vararg answers: String) : Transcriber {
        private val list = answers.toMutableList()
        var calls = 0
        override suspend fun transcribe(samples: FloatArray, lang: String): String {
            calls += 1
            return if (list.size > 1) list.removeAt(0) else list.first()
        }
    }

    /** Every port the app needs, with only the capture and the model replaced. */
    private class Fakes(
        private val scope: CoroutineScope,
        private val buffer: CaptureBuffer,
        transcriber: Transcriber,
    ) : PlatformServices {
        val spoken = mutableListOf<String>()
        val announced = mutableListOf<String>()
        val snapshots = mutableListOf<Json.Obj>()
        var transcriptCalls = 0
        var hadSpeech = true
        var peak = 0.3
        var durationMs = 1200
        /** What the audio port reports as the blob size; 0 for an interrupted capture. */
        var blobSize = -1
        /** While true, each utterance waits in [held] until the test completes it. */
        var hold = false
        val held = mutableListOf<CompletableDeferred<Unit>>()
        var recording = false

        override val store: TurnController.StorePort = object : TurnController.StorePort {
            override fun saveState(state: Json.Obj): Boolean = false
            override suspend fun flush() {}
            override fun markWithheld(fields: List<Json.Obj>) {}
            override fun sensitiveAnswers(state: Json.Obj): List<Json.Obj> = emptyList()
            override fun isPersisting(): Boolean = false
            override fun clearState() {}
            override fun forgetKey() {}
        }
        override val speech: TurnController.SpeechPort = object : TurnController.SpeechPort {
            override suspend fun speak(text: String, interrupt: Boolean, lang: String) {
                spoken.add(text)
                if (hold) CompletableDeferred<Unit>().also { held.add(it) }.await()
            }
            override fun cancel() {}
        }
        override val audio: TurnController.AudioPort = object : TurnController.AudioPort {
            override suspend fun startRecording(options: Json.Obj) { recording = true }
            override suspend fun stopRecording(): TurnController.Blob {
                recording = false
                if (blobSize != 0) {
                    buffer.put(FloatArray(16_000) { 0.1f }, hadSpeech = hadSpeech, peak = peak)
                    if (blobSize < 0) blobSize = buffer.size * 4
                }
                return TurnController.Blob(blobSize, null)
            }
            override fun cancelRecording() { recording = false }
            override fun isRecording(): Boolean = recording
            override fun lastCaptureDurationMs(): Int = durationMs
            override fun lastCaptureHadSpeech(): Boolean = hadSpeech
            override fun lastCapturePeak(): Double = peak
            override fun releaseMic() {}
            override fun earcon(name: String) {}
        }
        override val stt: TurnController.SttPort = object : TurnController.SttPort {
            private val delegate = BufferedStt(buffer, transcriber)
            override suspend fun transcribe(blob: TurnController.Blob): String {
                transcriptCalls += 1
                return delegate.transcribe(blob)
            }
        }
        override val timers: TurnController.TimersPort = object : TurnController.TimersPort {
            override fun setTimeout(fn: suspend () -> Unit, ms: Long): String {
                if (ms < 1000) scope.launch { delay(ms); fn() }
                return "t"
            }
            override fun clearTimeout(id: String?) {}
        }
        override val clock: () -> Long = { 1_800_206_400_000L }
        override fun localDate(epochMs: Long): CivilDate = CivilDate.ofEpochMillis(epochMs)
        override val announce: (String, Boolean) -> Unit = { text, _ -> announced.add(text) }
        override val onState: (Json.Obj) -> Unit = { snapshots.add(it) }
        override val onExport: suspend (List<String>, Json.Obj, LanguageSettings) -> Unit = { _, _, _ -> }
        override val onReadBack: suspend (Json.Obj) -> Unit = {}
    }

    private fun app(fakes: Fakes): AppController =
        AppController(schema, TurnController(AppPorts(schema, fakes), schema))

    @Test
    fun oneTypedAndOneSpokenAnswerReachTheEngine() = runTestBlocking {
        val fakes = Fakes(this, CaptureBuffer(), ScriptedTranscriber("yes"))
        val app = app(fakes)

        assertFalse(app.isStarted(), "before start() there is no engine to snapshot")
        app.start(TurnController.StartOptions(mode = "voice", confirm = false))
        assertTrue(app.isStarted(), "start() builds the engine")
        assertTrue(app.state().questionText.contains("Which form"), app.state().questionText)

        // The first question is `forms`, a choice. Typing an option's alias
        // answers it, exactly as Submit sends it.
        app.submitTyped("both")
        assertEquals("both", app.state().answers["forms"]?.asString())

        // The next question is `for_self`, a yes/no. This one comes in by
        // voice: the audio port fills the buffer and BufferedStt transcribes.
        app.onTalkDown()
        app.onTalkUp()

        assertEquals(1, fakes.transcriptCalls, "the scripted transcriber ran once")
        assertEquals(Json.True, app.state().answers["for_self"])
        assertTrue(app.state().questionText.isNotEmpty(), "the interview moved to the next question")
        assertTrue(fakes.spoken.any { it.isNotEmpty() }, "the question was spoken")
    }

    @Test
    fun aTranscriberFailureIsAskedAgainAndDoesNotEscape() = runTestBlocking {
        val broken = object : Transcriber {
            override suspend fun transcribe(samples: FloatArray, lang: String): String =
                throw IllegalStateException("the model did not load")
        }
        val fakes = Fakes(this, CaptureBuffer(), broken)
        val app = app(fakes)
        app.start(TurnController.StartOptions(mode = "voice", confirm = false))
        app.submitTyped("both")
        val before = app.state().answers.writeJson()

        // The adapter turns the model failure into SttError("unknown"), which
        // the turn loop catches and speaks: nothing escapes to the caller.
        app.onTalkDown()
        app.onTalkUp()

        assertNull(app.state().answers["for_self"], "the form did not move on")
        assertEquals(before, app.state().answers.writeJson())
        assertTrue(fakes.announced.isNotEmpty(), "the loop announced its error line")
    }

    /**
     * The interview screen replaces Setup as soon as `start()` runs, with the
     * first question on it, and takes no input until that question has been
     * spoken: the snapshot's `starting`, as in `tests/start-screen.js`.
     */
    @Test
    fun theInterviewScreenIsUpWhileTheIntroIsSpoken() = runTestBlocking {
        val fakes = Fakes(this, CaptureBuffer(), ScriptedTranscriber("yes"))
        fakes.hold = true
        val app = app(fakes)
        val started = launch { app.start(TurnController.StartOptions(mode = "voice", confirm = true)) }
        while (fakes.held.isEmpty()) yield()

        assertEquals(1, fakes.spoken.size, "only the intro has been spoken: ${fakes.spoken}")
        assertTrue(fakes.snapshots.isNotEmpty(), "a snapshot is emitted before the intro ends")
        val during = app.state()
        assertEquals("interview", during.panel)
        assertTrue(during.starting, "the start is under way")
        assertTrue(during.questionText.contains("Which form"), during.questionText)
        assertFalse(during.controls.talk, "no Talk button during the intro")
        assertFalse(during.controls.text, "no text field during the intro")
        assertTrue(during.controls.options.isEmpty(), "no options during the intro")

        // Input during the intro is held, not raced against the first question.
        app.submitTyped("both")
        assertNull(app.state().answers["forms"], "a typed answer during the intro is not taken")
        assertNull(app.onKey("Space"), "a key during the intro does nothing")
        app.onTalkDown()
        assertFalse(fakes.recording, "Talk during the intro does not record")
        app.runCommand("skip")
        assertTrue(app.state().questionText.contains("Which form"), "a command during the intro does nothing")

        fakes.hold = false
        while (started.isActive) {
            val waiting = fakes.held.toList()
            fakes.held.clear()
            waiting.forEach { it.complete(Unit) }
            yield()
        }

        val after = app.state()
        assertFalse(after.starting, "after the first question the start is over")
        assertTrue(after.controls.talk && after.controls.text, "the controls are back")
        assertTrue(after.controls.options.isNotEmpty(), "the form options are back")
        assertTrue(fakes.spoken.last().contains("Which form"), "the question was spoken last: ${fakes.spoken}")
        app.submitTyped("both")
        assertEquals("both", app.state().answers["forms"]?.asString())
    }

    /**
     * The shell's two gestures (Magic Tap and escape) act only on a started
     * session. Both call `isStarted()` first and return, because every call
     * they would make ends in `snapshot()`'s `engine!!`; on Kotlin/Native an
     * uncaught exception there ends the process.
     */
    @Test
    fun thereIsNoSessionForTheGesturesBeforeStart() = runTestBlocking {
        val app = app(Fakes(this, CaptureBuffer(), ScriptedTranscriber("yes")))
        assertFalse(app.isStarted(), "Setup is shown first, and it has no engine")
        app.start(TurnController.StartOptions(mode = "voice", confirm = false))
        assertTrue(app.isStarted(), "after Start the gestures have a session to act on")
    }

    /**
     * An interrupted capture (no samples, full-scale peak) is reasked with
     * `REASK.nothingHeard`: `sendAudio` rejects the empty blob before the
     * transcriber runs. Plan C3 asks for "not 'nothing heard'"; this test
     * records what the code does today, so the change it needs is visible
     * rather than assumed (TODO.md, Progress entry).
     */
    @Test
    fun anInterruptedCaptureIsCurrentlyReaskedAsNothingHeard() = runTestBlocking {
        val fakes = Fakes(this, CaptureBuffer(), ScriptedTranscriber("yes"))
        fakes.blobSize = 0
        fakes.peak = 1.0
        val app = app(fakes)
        app.start(TurnController.StartOptions(mode = "voice", confirm = false))
        app.submitTyped("both")

        app.onTalkDown()
        app.onTalkUp()

        assertEquals(0, fakes.transcriptCalls, "nothing reached the model")
        assertNull(app.state().answers["for_self"])
        assertNotNull(fakes.snapshots.lastOrNull())
    }
}
