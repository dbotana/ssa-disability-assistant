package org.ssa.assistant.core

import kotlin.test.Test
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.readTestResource
import org.ssa.assistant.core.golden.runTestBlocking
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.turn.TurnController

/**
 * The `turn` golden: the shared YAML scenarios run through the Kotlin
 * TurnController with fake ports — no DOM, no microphone, a fixed clock —
 * and the spoken transcript, the announced lines and the final answers
 * compared with the JS reference's. Everything the dialog layer says, in the
 * order it says it, is pinned here.
 */
class TurnGoldenTest {

    @Test
    fun turn() = runTestBlocking {
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
        // Listed from the pins copied beside them: inside the instrumented APK
        // the resources are zip entries, and a directory cannot be listed.
        fun read(path: String): String = readTestResource(path)
        val files = read("turn-scenarios/SHA256SUMS").lines()
            .filter { it.isNotBlank() }
            .map { it.trim().split(Regex("\\s+"), limit = 2)[1].removePrefix("*") }
        check(files.isNotEmpty()) { "turn-scenarios/SHA256SUMS lists no scenarios" }
        val out = LinkedHashMap<String, ScenarioDoc>()
        files.sorted().forEach { file ->
            val doc = yamlParse(read("turn-scenarios/$file"))
            val name = (doc["scenario"] as? String) ?: file
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

    // -- the steps ---------------------------------------------------------------

    private suspend fun runSteps(harness: TurnHarness, steps: List<Map<String, Any?>>) {
        val turn = harness.turn
        val chosen = LinkedHashMap<String, String>()

        fun startOpts(o: Any?): TurnController.StartOptions {
            val map = o as? Map<String, Any?> ?: emptyMap()
            val resume = map["resume"] as? Map<String, Any?>
            val saved = if (resume != null) {
                val fixture = resume["fixture"] as? String
                val answers = resume["answers"] as? Map<String, Any?> ?: emptyMap()
                val (state, withheld) = harness.savedSession(fixture, answers)
                TurnController.SavedSession(state, withheld)
            } else null
            val languages = (map["languages"] as? Map<*, *>)?.let { l ->
                LanguageSettings(
                    input = l["input"] as? String ?: "en",
                    output = l["output"] as? String ?: "en",
                    screen = l["screen"] as? String ?: "en",
                    fill = l["fill"] as? String ?: "en",
                )
            }
            val merged = if (chosen.isEmpty()) languages else {
                val base = languages ?: LanguageSettings()
                LanguageSettings(
                    input = chosen["input"] ?: base.input,
                    output = chosen["output"] ?: base.output,
                    screen = chosen["screen"] ?: base.screen,
                    fill = chosen["fill"] ?: base.fill,
                )
            }
            return TurnController.StartOptions(
                mode = (map["mode"] as? String) ?: "voice",
                confirm = (map["confirm"] as? Boolean) ?: true,
                saved = saved,
                languages = merged,
            )
        }

        for (step in steps) {
            yield()
            val start = step["start"]
            val startTwice = step["start-twice"]
            val choose = step["choose"]
            val option = step["option"]
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
                choose != null -> {
                    val c = choose as? Map<String, Any?>
                    c?.forEach { (k, v) -> chosen[k] = v.toString() }
                }
                option != null -> turn.submitTyped(option.toString())
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
