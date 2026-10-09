package org.ssa.assistant.pdf

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * M1a, the PDF spike: both official forms filled on the device from the
 * plan, every one self-checked clean, and each PDF published with its plan
 * so tools/golden/crosscheck.mjs can re-read it with pdf-lib and re-plan the
 * same answers with the JS reference.
 */
@RunWith(AndroidJUnit4::class)
class FillSpikeTest {
    private val schema = SchemaLoader.load()
    private val filler = FormFiller(TemplateLoader(Fixtures.context))

    private fun fillAndPublish(case: String, answers: Json.Obj) {
        for (formId in listOf("ssa", "ds")) {
            val fd = FormDocuments.plan(schema, formId, answers, Fixtures.TODAY)
            val filled = filler.fill(fd)
            Fixtures.publish(case, fd, answers, filled)
            assertEquals("$case $formId: names the template lacks", emptyList<String>(), filled.missing)
            check(filled.check.ok) { "$case $formId self-check: ${filled.check}" }
            check(filled.bytes.size <= 2 * filled.templateSize) {
                "$case $formId: ${filled.bytes.size} bytes, over 2x the ${filled.templateSize}-byte template"
            }
        }
    }

    @Test fun both() = fillAndPublish("both", Fixtures.answers("both"))
    @Test fun starterKit() = fillAndPublish("starter-kit", Fixtures.answers("starter-kit"))
    @Test fun dsOnly() = fillAndPublish("ds-only", Fixtures.answers("ds-only"))
    @Test fun minimal() = fillAndPublish("minimal", Fixtures.answers("minimal"))
    @Test fun long() = fillAndPublish("long", Fixtures.long())

    @Test
    fun accentsAndCurlyQuotes() {
        val answers = Fixtures.answers("both").also {
            it["first_name"] = Json.Str("Zoë “Zo” O’Brien-Łukasiewicz")
            it["last_name"] = Json.Str("Ñúñez 😀")
        }
        fillAndPublish("winansi", answers)
    }
}
