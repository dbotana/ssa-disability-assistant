package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.ssa.assistant.core.app.Summary
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.fixture
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The `summary` golden: `buildReport()` and `summaryText()` from
 * `src/summary.js` for every answer fixture, and `maskDigits()`. These are
 * what the Review screen draws and what the read-back speaks.
 */
class SummaryGoldenTest {
    private val schema = SchemaLoader.load()
    private val i18n = I18n(schema)
    private val golden = Golden.load("summary").asObject()!!

    @Test
    fun everyFixtureMatchesTheJsReference() {
        val cases = golden["cases"]!!.asArray()!!.items.map { it.asObject()!! }
        assertTrue(cases.size >= 4, "only ${cases.size} summary cases")
        for (c in cases) {
            val name = c["fixture"]!!.asString()!!
            val lang = c["lang"]!!.asString()!!
            val answers = fixture(name)
            val report = Summary.buildReport(schema, answers, null, lang, i18n)
            Golden.assertTree(
                "summary", "$name $lang report",
                Json.Arr(report.toMutableList()), c["report"]!!,
            )
            assertEquals(c["text"]!!.asString(), Summary.summaryText(schema, answers, lang, i18n), "$name $lang read-back")
        }
    }

    @Test
    fun maskingHidesAllButTheLastFourDigits() {
        val masks = golden["masks"]!!.asArray()!!.items.map { it.asObject()!! }
        assertTrue(masks.size >= 8)
        for (m in masks) {
            val keep = (m["keep"] as Json.Num).value.toInt()
            assertEquals(m["out"]!!.asString(), Summary.maskDigits(m["input"]!!.asString(), keep), "mask ${m["input"]!!.asString()}")
        }
    }

    @Test
    fun theLabelsTableIsTheSchemasOwn() {
        // LABELS in src/summary.js is exported as schema.json's `labels`, so the
        // UI and the addendum read one table.
        assertEquals("Legal first name", Summary.labels(schema)["first_name"])
        assertEquals("Social Security number", Summary.labels(schema)["ssn"])
        assertTrue(Summary.isSensitive(schema, "ssn"))
        assertTrue(Summary.isSensitive(schema, "routing"))
        assertTrue(Summary.isSensitive(schema, "account"))
    }
}
