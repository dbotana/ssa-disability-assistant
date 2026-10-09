package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.parse.Correct
import org.ssa.assistant.core.parse.matchChoice
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.schema.findQuestion
import org.ssa.assistant.core.schema.flatten
import org.ssa.assistant.core.schema.optionsFromSchema

/**
 * The `choice` golden: matchChoice on every option's own labels and aliases,
 * plus the correction, addition and deletion resolvers over the answer
 * fixtures.
 */
class ChoiceGoldenTest {

    private val schema = SchemaLoader.load()
    private val golden = Golden.load("choice")
    private val correct = Correct(schema)

    private fun fixture(key: String): Json.Obj =
        golden.asObject()!!.get("fixtures")!!.asObject()!!.get(key)!!.asObject()!!

    @Test
    fun matchChoice() {
        val choices = golden.asObject()!!.get("choices")!!.asArray()!!.items
        check(choices.size > 500) { "only ${choices.size} choice cases" }
        for ((i, raw) in choices.withIndex()) {
            val c = raw.asObject()!!
            val id = c["id"]!!.asString()!!
            val input = c["input"]!!.asString()!!
            val expected = c["value"]?.asString()

            // A renamed id must fail here, not silently empty the test.
            val q = findQuestion(id, schema.sections) ?: error("choices[$i]: no question $id in the schema")
            val hit = matchChoice(optionsFromSchema(q["options"]), input)
            check(hit?.value == expected) {
                "choices[$i] $id ${input}: expected $expected got ${hit?.value}"
            }
        }
    }

    /** A resolution in the golden's shape: a target, or a reason and its candidates. */
    private fun resolutionTree(r: Correct.Resolution): Json = Json.Obj().also { o ->
        val str = { v: String? -> if (v == null) Json.Null else Json.Str(v) }
        when (r) {
            is Correct.Resolution.Ok -> o["target"] = Json.Obj().also { t ->
                t["id"] = Json.Str(r.target.id)
                t["loopId"] = str(r.target.loopId)
                t["loopIndex"] = r.target.loopIndex?.let { Json.Num(it.toDouble()) } ?: Json.Null
                t["label"] = Json.Str(r.target.label)
            }
            is Correct.Resolution.None -> {
                o["reason"] = Json.Str(r.reason)
                o["candidates"] = Json.Arr()
            }
            is Correct.Resolution.Ambiguous -> {
                o["reason"] = Json.Str("ambiguous")
                o["candidates"] = Json.Arr(r.candidates.mapTo(mutableListOf()) { c ->
                    Json.Obj().also { t ->
                        t["id"] = Json.Str(c.id)
                        t["loopId"] = str(c.loopId)
                        t["label"] = Json.Str(c.label)
                    }
                })
            }
        }
    }

    @Test
    fun resolveTarget() {
        val cases = golden.asObject()!!.get("correct")!!.asArray()!!.items
        for ((i, raw) in cases.withIndex()) {
            val c = raw.asObject()!!
            val phrase = c["phrase"]!!.asString()!!
            val forms = c["forms"]!!.asString()!!
            Golden.assertTree("choice", "correct[$i] \"$phrase\"",
                resolutionTree(correct.resolveTarget(phrase, fixture(forms))), c["result"]!!)
        }
    }

    @Test
    fun additions() {
        val cases = golden.asObject()!!.get("additions")!!.asArray()!!.items
        val answers = fixture("both")
        for ((i, raw) in cases.withIndex()) {
            val c = raw.asObject()!!
            val phrase = c["phrase"]!!.asString()!!
            val expected = c["result"]!!.asObject()!!
            val r = correct.resolveAddition(phrase, answers)

            if (expected["reason"]?.asString() == "none") {
                check(r is Correct.AdditionResult.None) { "additions[$i] ${phrase}: expected none" }
            } else {
                check(r !is Correct.AdditionResult.None) { "additions[$i] ${phrase}: expected a loop" }
                if (r is Correct.AdditionResult.Ok) {
                    check(r.loopId == expected["loopId"]?.asString()) {
                        "additions[$i] ${phrase}: expected ${expected["loopId"]?.asString()} got ${r.loopId}"
                    }
                    check(r.nextNumber == (expected["nextNumber"]?.asDouble() ?: 0.0).toInt()) {
                        "additions[$i] ${phrase}: nextNumber mismatch"
                    }
                }
            }
        }
    }

    @Test
    fun deletions() {
        val cases = golden.asObject()!!.get("deletions")!!.asArray()!!.items
        val answers = fixture("both")
        for ((i, raw) in cases.withIndex()) {
            val c = raw.asObject()!!
            val phrase = c["phrase"]!!.asString()!!
            val expected = c["result"]!!.asObject()!!
            val r = correct.resolveDeletion(phrase, answers)

            if (expected["reason"]?.asString() == "none") {
                check(r is Correct.DeletionResult.None) { "deletions[$i] ${phrase}: expected none, got $r" }
            } else {
                val reason = expected["reason"]?.asString()   // absent for a clean hit
                when (r) {
                    is Correct.DeletionResult.Ok -> {
                        check(reason == null) { "deletions[$i] ${phrase}: expected ok, got $r" }
                        check(r.loopId == expected["loopId"]?.asString()) { "deletions[$i] ${phrase}: loopId" }
                        check(r.loopIndex == (expected["loopIndex"]?.asDouble() ?: 0.0).toInt()) { "deletions[$i] ${phrase}: loopIndex" }
                        check(r.number == (expected["number"]?.asDouble() ?: 0.0).toInt()) { "deletions[$i] ${phrase}: number" }
                    }
                    is Correct.DeletionResult.Empty -> check(reason == "empty") { "deletions[$i] ${phrase}: expected empty" }
                    is Correct.DeletionResult.Ambiguous -> check(reason == "ambiguous") { "deletions[$i] ${phrase}: expected ambiguous" }
                    is Correct.DeletionResult.None -> check(false) { "deletions[$i] ${phrase}: expected $reason got none" }
                }
            }
        }
    }
}
