package org.ssa.assistant.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.TimeZone
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Test
import org.ssa.assistant.core.engine.Engine
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.parse.Correct
import org.ssa.assistant.core.parse.Parse
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.core.validate.Validate

/**
 * The `turn` golden: the shared YAML scenarios run through the Kotlin
 * TurnController with fake ports — no DOM, no microphone, a fixed clock —
 * and the spoken transcript, the announced lines and the final answers
 * compared with the JS reference's. Everything the dialog layer says, in the
 * order it says it, is pinned here.
 */
class TurnGoldenTest {

    companion object {
        const val SCENARIO_EPOCH_MS = 1_800_206_400_000L   // Date.UTC(2026, 8, 19, 12, 0, 0)
        private const val FAKE_TIMER_MS = 1000L

        init {
            // The JS golden generator pins TZ=UTC; the parser's "now" is the
            // clock's local date, so the JVM must agree.
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        }
    }

    @Test
    fun turn() = runBlocking {
        val schema = SchemaLoader.load()
        val golden = Golden.load("turn")
        val transcripts = golden.asObject()!!["transcripts"]!!.asArray()!!.items
            .map { it.asObject()!! }
        check(transcripts.isNotEmpty())

        // The scenario files drive both implementations; map golden scenario
        // names back to their files.
        val byName = loadScenarios()

        for (t in transcripts) {
            val name = t["scenario"]!!.asString()!!
            val doc = byName[name] ?: error("no scenario file for \"$name\"")
            val harness = TurnHarness(schema, this)
            runSteps(harness, doc.steps ?: emptyList())
            yield()

            val expectedSpoken = t["spoken"]!!.asArray()!!.items
            val actualSpoken = harness.recordSpoken
            check(actualSpoken.size == expectedSpoken.size) {
                "$name spoken: ${actualSpoken.size} utterances, golden has ${expectedSpoken.size}"
            }
            for (i in actualSpoken.indices) {
                check(actualSpoken[i] == expectedSpoken[i].asString()) {
                    "$name spoken[$i]:\n  actual:   ${actualSpoken[i]}\n  expected: ${expectedSpoken[i].asString()}"
                }
            }
            val expectedAnnounced = t["announced"]!!.asArray()!!.items
            val actualAnnounced = harness.recordAnnounced
            check(actualAnnounced.size == expectedAnnounced.size) {
                "$name announced: ${actualAnnounced.size}, golden has ${expectedAnnounced.size}"
            }
            for (i in actualAnnounced.indices) {
                check(actualAnnounced[i] == expectedAnnounced[i].asString()) {
                    "$name announced[$i]:\n  actual:   ${actualAnnounced[i]}\n  expected: ${expectedAnnounced[i].asString()}"
                }
            }
            val answers = harness.snapshots.last()["answers"]
                ?: error("$name: no snapshot")
            Golden.assertTree("turn", "$name answers", answers, t["answers"]!!)
        }
    }

    // -- YAML ------------------------------------------------------------------

    private class ScenarioDoc(val name: String, val steps: List<Map<String, Any?>>?)

    private fun loadScenarios(): Map<String, ScenarioDoc> {
        val dir = javaClass.classLoader.getResource("turn-scenarios")
            ?: error("no turn-scenarios resources")
        val out = LinkedHashMap<String, ScenarioDoc>()
        val url = dir.toURI()
        java.io.File(url).listFiles()!!.sortedBy { it.name }.forEach { file ->
            val doc = yamlParse(file.readText())
            val name = (doc["scenario"] as? String) ?: file.name
            out[name] = ScenarioDoc(name, doc["steps"] as? List<Map<String, Any?>>)
        }
        return out
    }

    /** The YAML subset tools/turn-runner.mjs parses: maps, lists of maps,
     *  scalars, one-line flow lists. */
    private fun yamlParse(text: String): Map<String, Any?> {
        val lines = text.split("\n").map { line ->
            val indent = line.indexOfFirst { !it.isWhitespace() }.let { if (it < 0) line.length else it }
            Triple(indent, line.trim(), line.trim())
        }.filter { (_, t) -> t.isNotEmpty() && !t.startsWith("#") }

        val root = LinkedHashMap<String, Any?>()
        class Frame(val obj: Any, val key: String?, val indent: Int, val value: Any)
        val stack = mutableListOf(Frame(root, null, -1, root))

        fun nextIsList(here: Int, index: Int): Boolean {
            for (j in index + 1 until lines.size) {
                if (lines[j].first <= here) return false
                return lines[j].third.startsWith("-")
            }
            return false
        }

        fun splitPair(line: String): Pair<String, String?> {
            val i = line.indexOf(':')
            if (i == -1) return line.trim() to null
            val key = line.substring(0, i).trim()
            val rest = line.substring(i + 1).trim()
            return key to if (rest.isEmpty()) null else rest
        }

        fun scalar(v: String): Any? {
            if (v == "[]") return emptyList<Any?>()
            if (v.startsWith("[") && v.endsWith("]")) {
                return v.substring(1, v.length - 1).split(",")
                    .map { scalar(it.trim()) }
                    .filter { it != null && it != "" }
            }
            if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
                return v.substring(1, v.length - 1)
            }
            if (v == "true") return true
            if (v == "false") return false
            if (v == "null") return null
            if (v.matches(Regex("-?\\d+"))) return v.toDouble()
            return v
        }

        for (li in lines.indices) {
            val (indent, _, line) = lines[li]
            val m = Regex("^-\\s*(.*)$").find(line)
            if (m != null) {
                while (stack.size > 1 && stack.last().indent >= indent) stack.removeAt(stack.size - 1)
                @Suppress("UNCHECKED_CAST")
                val list = stack.last().value as MutableList<Any?>
                val item = LinkedHashMap<String, Any?>()
                list.add(item)
                val rest = m.groupValues[1]
                if (rest.isNotEmpty()) {
                    val (k, v) = splitPair(rest)
                    if (v == null) {
                        val child: Any = if (nextIsList(indent, li)) mutableListOf<Any?>() else LinkedHashMap<String, Any?>()
                        item[k] = child
                        stack.add(Frame(child, k, indent, child))
                    } else {
                        item[k] = scalar(v)
                    }
                } else {
                    stack.add(Frame(item, null, indent, item))
                }
                continue
            }
            val (key, value) = splitPair(line)
            while (stack.size > 1 && stack.last().indent >= indent) stack.removeAt(stack.size - 1)
            val target = stack.last()
            if (value == null) {
                val child: Any = if (nextIsList(indent, li)) mutableListOf<Any?>() else LinkedHashMap<String, Any?>()
                @Suppress("UNCHECKED_CAST")
                (target.obj as MutableMap<String, Any?>)[key] = child
                stack.add(Frame(child, key, indent, child))
            } else {
                @Suppress("UNCHECKED_CAST")
                (target.obj as MutableMap<String, Any?>)[key] = scalar(value)
            }
        }
        return root
    }

    // -- the harness -------------------------------------------------------------

    private class TurnHarness(val schema: Schema, private val scope: CoroutineScope) {
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

        var nowMs = SCENARIO_EPOCH_MS
        private val fake = LinkedHashMap<String, Pair<Long, suspend () -> Unit>>()
        private var nextTimer = 1

        val turn: TurnController = TurnController(object : TurnController.Ports {
            override val say = Phrases(schema)
            override val correct = Correct(schema)
            override val store = object : TurnController.StorePort {
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
            override val speech = object : TurnController.SpeechPort {
                override suspend fun speak(text: String, interrupt: Boolean) {
                    spoken.add(text)
                    recordSpoken.add(text)
                }
                override fun cancel() {}
            }
            override val audio = object : TurnController.AudioPort {
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
            override val stt = object : TurnController.SttPort {
                override suspend fun transcribe(blob: TurnController.Blob): String =
                    blob.text ?: nextTranscript ?: ""
            }
            override val timers = object : TurnController.TimersPort {
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
            override val announce: (String, Boolean) -> Unit = { text, _ ->
                announced.add(text)
                recordAnnounced.add(text)
            }
            override val onState: (Json.Obj) -> Unit = { snapshots.add(it) }
            override val onExport: suspend (List<String>, Json.Obj) -> Unit = { forms, _ ->
                exports.add(forms)
            }
            override val onReadBack: suspend (Json.Obj) -> Unit = {}

            override fun createEngine(saved: Json.Obj?, now: () -> Double): Engine =
                Engine(schema, saved, now)

            override fun parseLocal(question: Question, transcript: String, typed: Boolean, now: LocalDate) =
                Parse.parseLocal(question, transcript, typed, now)

            override fun normalize(result: org.ssa.assistant.core.parse.ParsedValue?, question: Question) =
                Validate.normalize(result, question)

            override fun speakable(value: Any?, type: String, options: List<Option>?) =
                speakableValue(value, type, options)

            override fun formatTimeRemaining(sec: Int?) =
                org.ssa.assistant.core.formatTimeRemaining(sec)
        }, schema)

        fun setTranscript(t: String) { nextTranscript = t }

        fun setQuiet(q: Boolean) {
            hadSpeech = !q
            peak = if (q) 0.004 else 0.5
        }

        /** Move the clock forward, running each fake timer that comes due. */
        suspend fun advance(ms: Long) {
            val target = nowMs + ms
            while (true) {
                val next = fake.entries
                    .filter { it.value.first <= target }
                    .minByOrNull { it.value.first }
                    ?: break
                fake.remove(next.key)
                nowMs = next.value.first
                scope.launch { next.value.second() }.join()
            }
            nowMs = target
        }

        /** A saved session as store.js would hand it back: the answers walked
         *  to their first unanswered question, then redacted. */
        fun savedSession(fixture: String?, answers: Map<String, Any?>): Pair<Json.Obj, List<Json.Obj>> {
            val base = if (fixture != null) {
                val stream = javaClass.classLoader.getResourceAsStream("fixtures/answers/$fixture.json")
                    ?: error("no fixture $fixture")
                JsonParser.parse(stream.readBytes().toString(Charsets.UTF_8)).asObject()!!
            } else Json.Obj()
            val merged = Json.Obj(LinkedHashMap(base.entries))
            answers.forEach { (k, v) -> merged[k] = jsonOf(v) }
            val saved = Json.Obj().also { it["answers"] = merged }
            val engine = Engine(schema, saved) { SCENARIO_EPOCH_MS / 1000.0 }
            return Sensitive.redact(schema, engine.getState())
        }

        companion object {
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

    // -- the steps ---------------------------------------------------------------

    private suspend fun runSteps(harness: TurnHarness, steps: List<Map<String, Any?>>) {
        val turn = harness.turn

        fun startOpts(o: Any?): TurnController.StartOptions {
            val map = o as? Map<String, Any?> ?: emptyMap()
            val resume = map["resume"] as? Map<String, Any?>
            val saved = if (resume != null) {
                val fixture = resume["fixture"] as? String
                val answers = resume["answers"] as? Map<String, Any?> ?: emptyMap()
                val (state, withheld) = harness.savedSession(fixture, answers)
                TurnController.SavedSession(state, withheld)
            } else null
            return TurnController.StartOptions(
                mode = (map["mode"] as? String) ?: "voice",
                confirm = (map["confirm"] as? Boolean) ?: true,
                saved = saved
            )
        }

        for (step in steps) {
            yield()
            val start = step["start"]
            val startTwice = step["start-twice"]
            val advance = step["advance"]
            val type = step["type"]
            val say = step["say"]
            val sayQuiet = step["say-quiet"]
            val quiet = step["quiet"]
            val press = step["press"]
            val command = step["command"]
            val startReview = step["start-review"]
            val expect = step["expect"]

            when {
                start != null -> turn.start(startOpts(start))
                startTwice != null -> {
                    val opts = startOpts(startTwice)
                    val a = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.currentCoroutineContext()).launch { turn.start(opts) }
                    val b = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.currentCoroutineContext()).launch { turn.start(opts) }
                    a.join()
                    b.join()
                }
                advance != null -> harness.advance(((advance as Double) * 60 * 1000).toLong())
                type != null -> turn.submitTyped(type.toString())
                say != null -> {
                    harness.setTranscript(say.toString())
                    turn.sendAudio(TurnController.Blob(1000, say.toString()))
                }
                sayQuiet != null -> {
                    harness.setQuiet(true)
                    harness.setTranscript(sayQuiet.toString())
                    turn.sendAudio(TurnController.Blob(1000, sayQuiet.toString()))
                    harness.setQuiet(false)
                }
                quiet != null -> harness.setQuiet(quiet == true)
                press != null -> turn.onKey(press.toString(), typing = false)
                command != null -> turn.runCommand(command.toString())
                startReview != null -> turn.startReview()
                expect != null -> expectStep(harness, expect)
                step["finish"] != null -> turn.finishInterview()
            }
        }
    }

    private fun expectStep(harness: TurnHarness, raw: Any?) {
        val e = raw as? Map<String, Any?> ?: error("expect step is not a map")
        val s = harness.snapshots.last()
        val textOf = { key: String -> s[key]?.asString() ?: "" }

        (e["question"] as? String)?.let { pattern ->
            check(Regex(pattern).containsMatchIn(textOf("questionText"))) {
                "question /$pattern/ does not match ${textOf("questionText")}"
            }
        }
        (e["hint"] as? String)?.let { pattern ->
            check(Regex(pattern).containsMatchIn(textOf("hintText"))) {
                "hint /$pattern/ does not match ${textOf("hintText")}"
            }
        }
        (e["status"] as? String)?.let { pattern ->
            check(Regex(pattern).containsMatchIn(textOf("statusText"))) {
                "status /$pattern/ does not match ${textOf("statusText")}"
            }
        }
        (e["readback"] as? String)?.let { want ->
            val got = if (s["readbackOpen"]?.asObject() == null && s["readbackOpen"] !== Json.True) "closed" else "open"
            check(got == want) { "readback $got != $want" }
        }
        (e["panel"] as? String)?.let { want ->
            check(s["panel"]?.asString() == want) { "panel ${s["panel"]?.asString()} != $want" }
        }
        (e["spoken"] as? String)?.let { pattern ->
            val all = harness.spoken.joinToString(" ")
            check(Regex(pattern).containsMatchIn(all)) { "spoken /$pattern/ not in ${all.take(200)}" }
        }
        (e["unspoken"] as? String)?.let { pattern ->
            val all = harness.spoken.joinToString(" ")
            check(!Regex(pattern).containsMatchIn(all)) { "unspoken /$pattern/ matched ${all.take(200)}" }
        }
        (e["spokenOnce"] as? String)?.let { pattern ->
            val n = harness.spoken.count { Regex(pattern).containsMatchIn(it) }
            check(n == 1) { "spokenOnce /$pattern/: $n times" }
        }
        (e["withheld"] as? List<*>)?.let { want ->
            val got = harness.withheld.distinct().sorted()
            val expected = want.mapNotNull { it as? String }.distinct().sorted()
            check(got == expected) { "withheld $got != $expected" }
        }
        (e["announced"] as? String)?.let { pattern ->
            val all = harness.announced.joinToString(" ")
            check(Regex(pattern).containsMatchIn(all)) { "announced /$pattern/ not in ${all.take(200)}" }
        }
        (e["answers"] as? Map<String, Any?>)?.let { want ->
            val got = s["answers"]?.asObject() ?: Json.Obj()
            for ((k, v) in want) {
                val g = got[k]
                val same = if (v == null) (g == null || g === Json.Null)
                else g != null && g.treeEquals(TurnHarness.jsonOf(v))
                check(same) { "answer $k: ${g?.let { it } ?: "null"} != $v" }
            }
        }
        (e["missing"] as? String)?.let { pattern ->
            check(Regex(pattern).containsMatchIn(textOf("missing"))) {
                "missing /$pattern/ not in ${textOf("missing")}"
            }
        }
        harness.spoken.clear()
        harness.announced.clear()
    }
}
