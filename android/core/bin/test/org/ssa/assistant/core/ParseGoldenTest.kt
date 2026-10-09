package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.parse.Parse
import org.ssa.assistant.core.parse.ParsedValue
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.schema.findQuestion
import org.ssa.assistant.core.schema.flatten
import org.ssa.assistant.core.schema.optionsFromSchema
import org.ssa.assistant.core.schema.questionFromSchema
import org.ssa.assistant.core.validate.Validate
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The `parse` golden: every val/defer case from the shared corpus, the typed
 * cases, and the generated per-question corpus (every top-level question and
 * every loop field, plus the regex-dialect probes), run through the Kotlin
 * parser against the same "today" the JS generator used.
 */
class ParseGoldenTest {

    private val schema = SchemaLoader.load()
    private val golden = Golden.load("parse").asObject()!!

    /** The generator's fixed "today", which it pins in UTC. */
    private val now: LocalDate =
        Instant.parse(golden["now"]!!.asString()!!).atZone(ZoneOffset.UTC).toLocalDate()

    /** The question a corpus case ran against, built as caseQuestion() in index.mjs builds it. */
    private fun caseQuestion(c: Json.Obj): Question {
        val type = c["type"]!!.asString()!!
        c["questionKey"]?.asString()?.let { key ->
            val real = findQuestion(key, schema.sections) ?: error("corpus: no question $key")
            val q = questionFromSchema(real)
            check(q.type == type) { "corpus: $key is not a $type question" }
            return q
        }
        val options = c["optionsKey"]?.asString()?.let { key ->
            findQuestion(key, schema.sections)?.get("options") ?: error("corpus: no options on $key")
        }
        // A bare question of the type: no id, no prompt, as the generator's { type, options? }.
        return Question(id = "", prompt = "", type = type, options = optionsFromSchema(options))
    }

    private fun resultTree(parsed: ParsedValue?): Json = if (parsed == null) Json.Null else Json.Obj().also { o ->
        o["value"] = Json.of(parsed.value)
        o["confidence"] = Json.Num(parsed.confidence)
    }

    @Test
    fun parseCorpus() {
        val cases = golden["cases"]!!.asArray()!!.items
        check(cases.size > 200) { "corpus has only ${cases.size} cases" }
        for ((i, raw) in cases.withIndex()) {
            val c = raw.asObject()!!
            val input = c["input"]!!.asString()!!
            val actual = resultTree(Parse.parseLocal(caseQuestion(c), input, typed = false, now = now))
            val expected = c["result"] ?: Json.Null
            check(actual.treeEquals(expected)) {
                "case[$i] ${c["questionKey"]?.asString() ?: c["type"]!!.asString()} ${Json.Str(input).writeJson()}: " +
                    "expected ${expected.writeJson()} got ${actual.writeJson()}"
            }
        }
    }

    @Test
    fun typedCases() {
        val cases = golden["typed"]!!.asArray()!!.items
        check(cases.isNotEmpty())
        for ((i, raw) in cases.withIndex()) {
            val c = raw.asObject()!!
            val input = c["input"]!!.asString()!!
            val actual = resultTree(Parse.parseLocal(caseQuestion(c), input, typed = true, now = now))
            val expected = c["result"] ?: Json.Null
            check(actual.treeEquals(expected)) {
                "typed[$i] ${c["type"]!!.asString()} ${Json.Str(input).writeJson()}: expected ${expected.writeJson()} got ${actual.writeJson()}"
            }
        }
    }

    /** A schema question by id, scoped to its loop when it is a loop field. */
    private fun schemaQuestion(id: String, loopId: String?): Question {
        val nodes = flatten(schema.sections)
        if (loopId == null) {
            val node = nodes.firstOrNull { it.type != "loop" && it.id == id } ?: error("no question $id")
            return questionFromSchema(node.raw)
        }
        val loop = nodes.firstOrNull { it.type == "loop" && it.id == loopId } ?: error("no loop $loopId")
        val field = loop.fields!!.firstOrNull { it["id"]?.asString() == id } ?: error("no field $loopId.$id")
        return questionFromSchema(field).copy(loopId = loopId)
    }

    @Test
    fun generatedPerQuestionCorpus() {
        val perQuestion = golden["perQuestion"]!!.asArray()!!.items
        val loopFieldCases = perQuestion.count { it.asObject()!!["loopId"] !== Json.Null }
        check(loopFieldCases > 100) { "the per-question corpus has only $loopFieldCases loop-field cases" }

        for ((i, raw) in perQuestion.withIndex()) {
            val c = raw.asObject()!!
            val id = c["id"]!!.asString()!!
            val loopId = c["loopId"]?.asString()
            val input = c["input"]!!.asString()!!
            val question = schemaQuestion(id, loopId)

            val parsed = Parse.parseLocal(question, input, typed = false, now = now)
            val expected = c["result"] ?: Json.Null
            check(resultTree(parsed).treeEquals(expected)) {
                "perQuestion[$i] ${loopId?.let { "$it." } ?: ""}$id (${question.type}) ${Json.Str(input).writeJson()}: " +
                    "expected ${expected.writeJson()} got ${resultTree(parsed).writeJson()}"
            }

            // And the normalized form, when the golden recorded one.
            val expectedNorm = c["normalized"]?.asObject() ?: continue
            val norm = Validate.normalize(parsed, question)
            val actualNorm = Json.Obj().also { o ->
                o["value"] = Json.of(norm.value)
                o["needsClarification"] = Json.bool(norm.needsClarification)
                o["clarifyPrompt"] = norm.clarifyPrompt?.let { Json.Str(it) } ?: Json.Null
            }
            val expectedNormTree = Json.Obj().also { o ->
                o["value"] = expectedNorm["value"] ?: Json.Null
                o["needsClarification"] = Json.bool(expectedNorm["needsClarification"]?.asBoolean() ?: false)
                o["clarifyPrompt"] = expectedNorm["clarifyPrompt"] ?: Json.Null
            }
            check(actualNorm.treeEquals(expectedNormTree)) {
                "normalized[$i] $id ${Json.Str(input).writeJson()}: expected ${expectedNormTree.writeJson()} got ${actualNorm.writeJson()}"
            }
        }
    }
}
