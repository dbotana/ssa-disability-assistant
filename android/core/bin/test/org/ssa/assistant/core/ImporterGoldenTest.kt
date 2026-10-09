package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The `import` golden: v1, v2 and v3 export files parsed back, and broken
 * files refused with a sentence fit to be spoken aloud. The Kotlin importer
 * must accept and reject exactly the same bytes with the same messages.
 */
class ImporterGoldenTest {

    private val schema = SchemaLoader.load()
    private val golden = Golden.load("import")

    @Test
    fun versions() {
        val results = golden.asObject()!!["results"]!!.asObject()!!
        val inputs = golden.asObject()!!["inputs"]!!.asObject()!!
        for (name in listOf("v1", "v2", "v3")) {
            val r = Importer.parseExport(schema, inputs[name]!!.asString()!!)
            val expected = results[name]!!.asObject()!!
            check(r.savedAt == expected["savedAt"]?.asString()) {
                "$name savedAt: ${r.savedAt} != ${expected["savedAt"]?.asString()}"
            }
            check(r.rebuiltCursor == (expected["rebuiltCursor"]?.asBoolean() ?: false)) {
                "$name rebuiltCursor: ${r.rebuiltCursor}"
            }
            Golden.assertTree("import", "$name state", r.state, expected["state"]!!)
        }
        check(results["v1"]!!.asObject()!!["rebuiltCursor"]!!.asBoolean()!!) {
            "a v1 file (no cursor) must rebuild its cursor"
        }
        check(!results["v3"]!!.asObject()!!["rebuiltCursor"]!!.asBoolean()!!) {
            "a v3 file with a good cursor must keep it"
        }
    }

    @Test
    fun broken() {
        val broken = golden.asObject()!!["broken"]!!.asObject()!!
        val inputs = golden.asObject()!!["inputs"]!!.asObject()!!
        for ((name, expected) in broken.entries) {
            val message = expected.asString()!!
            try {
                Importer.parseExport(schema, inputs[name]!!.asString()!!)
                check(message == "accepted (bad)") {
                    "$name: accepted, but the golden expected refusal"
                }
            } catch (e: ImportError) {
                check(e.message == message) { "$name: \"${e.message}\" != \"$message\"" }
            }
        }
    }

    @Test
    fun sanitize() {
        // The JS importer is strict about types but a number IS a scalar:
        // first_name: 42 survives (it parses to text downstream), while the
        // bogus form choice "weird" is dropped and repaired to the Starter
        // Kit, exactly as the golden records.
        val r = Importer.parseExport(
            schema,
            golden.asObject()!!["inputs"]!!.asObject()!!["badAnswers"]!!.asString()!!
        )
        val answers = r.state["answers"]!!.asObject()!!
        check(answers["first_name"] is Json.Num) { "first_name: 42 should have been kept" }
        check(answers["forms"]?.asString() == "ssa") { "the form choice was not repaired" }
    }
}
