package org.ssa.assistant.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.ssa.assistant.core.app.AppPorts
import org.ssa.assistant.core.app.PlatformServices
import org.ssa.assistant.core.engine.Engine
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.turn.TurnController

/**
 * Shared fake-port harness used by both TurnGoldenTest and AppControllerGoldenTest.
 * Provides a fixed clock, fake timers, recorded spoken/announced lines,
 * snapshots, exports, and the jsonOf helper.  The ports are held as a named
 * property so that callers can build a TurnController (or AppController) from
 * the same ports.
 */
class TurnHarness(val schema: Schema, val scope: CoroutineScope) {

    // -- fixed clock & fake timers -------------------------------------------

    val spoken = mutableListOf<String>()
    val announced = mutableListOf<String>()
    val recordSpoken = mutableListOf<String>()
    val recordAnnounced = mutableListOf<String>()
    var peak = 0.5
    var hadSpeech = true
    var durationMs = 1000
    var recording = false
    var savedWrote = 0
    val withheld = mutableListOf<String>()
    var nextTranscript = ""

    val snapshots = mutableListOf<Json.Obj>()
    val exports = mutableListOf<List<String>>()

    var nowMs: Long = SCENARIO_EPOCH_MS
    val fake = LinkedHashMap<String, Pair<Long, suspend () -> Unit>>()
    var nextTimer = 1

    // -- the named ports, so callers build their own controller from them ----
    //
    // The device-facing ports are fakes; the pure ports come from the
    // production AppPorts, so the turn goldens prove the real wiring and not a
    // test-only copy of it (plan, Phase A1).

    private val fakes: PlatformServices = object : PlatformServices {
        override val store: TurnController.StorePort = object : TurnController.StorePort {
            override fun saveState(state: Json.Obj): Boolean { savedWrote += 1; return true }
            override suspend fun flush() {}
            override fun markWithheld(fields: List<Json.Obj>) {
                withheld.addAll(fields.mapNotNull { it["id"]?.asString() })
            }
            override fun sensitiveAnswers(state: Json.Obj): List<Json.Obj> =
                Sensitive.sensitiveAnswers(schema, state)
            override fun isPersisting(): Boolean = true
            override fun clearState() {}
            override fun forgetKey() {}
        }
        override val speech: TurnController.SpeechPort = object : TurnController.SpeechPort {
            override suspend fun speak(text: String, interrupt: Boolean, lang: String) {
                spoken.add(text)
                recordSpoken.add(text)
            }
            override fun cancel() {}
        }
        override val audio: TurnController.AudioPort = object : TurnController.AudioPort {
            override suspend fun startRecording(options: Json.Obj) { recording = true }
            override suspend fun stopRecording(): TurnController.Blob {
                recording = false
                return TurnController.Blob(1000, null)
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
            override suspend fun transcribe(blob: TurnController.Blob): String =
                blob.text ?: nextTranscript ?: ""
        }
        override val timers: TurnController.TimersPort = object : TurnController.TimersPort {
            override fun setTimeout(fn: suspend () -> Unit, ms: Long): String {
                if (ms < FAKE_TIMER_MS) {
                    scope.launch { delay(ms); fn() }
                    return "real-${nextTimer++}"
                }
                val id = "fake-${nextTimer++}"
                fake[id] = nowMs + ms to fn
                return id
            }
            override fun clearTimeout(id: String?) {
                if (id != null && id.startsWith("fake-")) fake.remove(id)
            }
        }
        override val clock: () -> Long = { nowMs }
        // The JS golden generator pins TZ=UTC; the parser's "now" is the
        // clock's local date, so the device zone here is UTC too.
        override fun localDate(epochMs: Long) = CivilDate.ofEpochMillis(epochMs)
        override val announce: (String, Boolean) -> Unit = { text, _ ->
            announced.add(text)
            recordAnnounced.add(text)
        }
        override val onState: (Json.Obj) -> Unit = { snapshots.add(it) }
        override val onExport: suspend (List<String>, Json.Obj, LanguageSettings) -> Unit = { forms, _, _ ->
            exports.add(forms)
        }
        override val onReadBack: suspend (Json.Obj) -> Unit = {}
    }

    val ports: TurnController.Ports = AppPorts(schema, fakes)

    val turn: TurnController = TurnController(ports, schema)

    // -- timer operations ----------------------------------------------------

    /** Move the clock forward, running each fake timer that comes due, in order. */
    suspend fun advance(ms: Long) {
        val target = nowMs + ms
        while (true) {
            // Copy the due timer's id, time and callback before deleting it.
            // On Kotlin/Native a Map.Entry is not safe to read once its key
            // has been removed (it segfaulted on `next.value.second`), and
            // the JS reference copies the pair before `fake.delete` too.
            val next = fake.entries
                .filter { it.value.first <= target }
                .map { Triple(it.key, it.value.first, it.value.second) }
                .minByOrNull { it.second }
                ?: break
            fake.remove(next.first)
            nowMs = next.second
            scope.launch { next.third() }.join()
        }
        nowMs = target
    }

    /** Set the transcript for the current step. */
    fun setTranscript(t: String) { nextTranscript = t }

    /** Set quiet mode for the hands-free path. */
    fun setQuiet(q: Boolean) {
        hadSpeech = !q
        peak = if (q) 0.004 else 0.5
    }

    /** A saved session as store.js would hand it back: the answers walked
     *  to their first unanswered question, then redacted. */
    fun savedSession(fixture: String?, answers: Map<String, Any?>): Pair<Json.Obj, List<Json.Obj>> {
        val base = if (fixture != null) {
            org.ssa.assistant.core.golden.fixture(fixture)
        } else Json.Obj()
        val merged = Json.Obj(LinkedHashMap(base.entries))
        answers.forEach { (k, v) -> merged[k] = jsonOf(v) }
        val saved = Json.Obj().also { it["answers"] = merged }
        val engine = Engine(schema, saved) { SCENARIO_EPOCH_MS / 1000.0 }
        return Sensitive.redact(schema, engine.getState())
    }

    companion object {
        const val SCENARIO_EPOCH_MS = 1_800_206_400_000L   // Date.UTC(2026, 8, 19, 12, 0, 0)
        const val FAKE_TIMER_MS = 1000L

        /** Build a [Json] from any value (null, String, Double, Boolean, List, Map). */
        fun jsonOf(v: Any?): Json = when (v) {
            null -> Json.Null
            is String -> Json.Str(v)
            is Double -> Json.Num(v)
            is Boolean -> Json.bool(v)
            is List<*> -> Json.Arr(v.mapTo(mutableListOf()) { jsonOf(it) })
            is Map<*, *> -> Json.Obj(LinkedHashMap<String, Json>().also { m ->
                v.forEach { (k, vv) -> m[k.toString()] = jsonOf(vv) }
            })
            else -> Json.Str(v.toString())
        }
    }
}
