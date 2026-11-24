package org.ssa.assistant.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.turn.TurnController

/**
 * The `transcripts` golden (tools/golden/index.mjs): src/localstt.js's
 * cleanTranscript() and src/turn.js's isEmptyTranscript() over Whisper's
 * annotations, brackets, JS whitespace and the silence-filler words.
 */
class TranscriptsGoldenTest {
    private val golden = Golden.load("transcripts").asObject()!!
    private val cases = golden["cases"]!!.asArray()!!.items.map { it.asObject()!! }
    private fun show(s: String?) = if (s == null) "null" else Json.Str(s).writeJson()

    @Test
    fun everyTranscriptCleansAsInJs() {
        assertTrue(cases.size >= 60, "the golden looks truncated: ${cases.size} cases")
        val wrong = mutableListOf<String>()
        for (c in cases) {
            val input = c["input"]!!.asString()          // null where the golden holds null
            val want = c["clean"]!!.asString()!!
            val got = cleanTranscript(input)
            if (got != want) wrong.add("${show(input)} -> ${show(got)}, JS ${show(want)}")
        }
        assertEquals(emptyList<String>(), wrong, "${wrong.size} case(s) clean differently from JS")
    }

    @Test
    fun theFillerRuleMatchesJs() {
        val peaks = golden["peaks"]!!.asObject()!!
        val quiet = peaks["quiet"]!!.asDouble()!!
        val loud = peaks["loud"]!!.asDouble()!!
        val wrong = mutableListOf<String>()
        for (c in cases) {
            val clean = c["clean"]!!.asString()!!
            val empty = c["empty"]!!.asObject()!!
            val q = TurnController.isEmptyTranscript(clean, quiet)
            val l = TurnController.isEmptyTranscript(clean, loud)
            if (q != empty["quiet"]!!.asBoolean()) wrong.add("quiet ${show(clean)} -> $q")
            if (l != empty["loud"]!!.asBoolean()) wrong.add("loud ${show(clean)} -> $l")
        }
        assertEquals(emptyList<String>(), wrong, "${wrong.size} filler decision(s) differ from JS")
    }

    @Test
    fun theQuietPeakIsTheJsOne() {
        assertEquals(golden["quietPeak"]!!.asDouble()!!, TurnController.QUIET_PEAK)
    }
}
