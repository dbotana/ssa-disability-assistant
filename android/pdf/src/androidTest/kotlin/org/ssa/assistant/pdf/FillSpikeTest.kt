package org.ssa.assistant.pdf

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.pdf.FormVersions
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

    @Test
    fun theExportPathOffersTheFormNotTheWorksheet() {
        val answers = Fixtures.answers("both")
        for (formId in listOf("ssa", "ds")) {
            val fd = FormDocuments.plan(schema, formId, answers, Fixtures.TODAY)
            val outcome = filler.export(fd) {
                FormDocuments.worksheet(schema, answers, Fixtures.TODAY)
            }
            check(outcome is FormFiller.Outcome.Form) {
                "$formId fell back to the worksheet: ${(outcome as FormFiller.Outcome.Worksheet).reason}"
            }
            check(outcome.filled.check.ok) { "$formId: ${outcome.filled.check}" }
        }
    }

    @Test fun both() = fillAndPublish("both", Fixtures.answers("both"))
    @Test fun starterKit() = fillAndPublish("starter-kit", Fixtures.answers("starter-kit"))
    @Test fun dsOnly() = fillAndPublish("ds-only", Fixtures.answers("ds-only"))
    @Test fun minimal() = fillAndPublish("minimal", Fixtures.answers("minimal"))
    @Test fun long() = fillAndPublish("long", Fixtures.long())

    /**
     * Step 2 item 5: a Lingala session's two versions of each form, from the
     * fixed translation fixture, both filled and both through PdfSelfCheck.
     * Published as ln-both-a and ln-both-b, so crosscheck.mjs re-plans each
     * version's answers with the JS reference too.
     */
    @Test
    fun lingalaVersionsAAndB() {
        val (answers, overlay) = Fixtures.lingala()
        for (formId in listOf("ssa", "ds")) {
            val versions = FormVersions.plan(schema, formId, answers, overlay, Fixtures.TODAY)
            val b = checkNotNull(versions.b) { "$formId: the fixture makes no version B" }
            check(versions.a.notes == listOf(FormVersions.NOTE_A)) { "$formId: version A has no interpreter note" }
            check(b.appendix.isNotEmpty()) { "$formId: version B has no appendix" }
            for (v in listOf(versions.a, b)) {
                val case = "ln-both-${v.version}"
                val filled = filler.fill(v.document)
                Fixtures.publish(case, v.document, v.answers, filled)
                assertEquals("$case $formId: names the template lacks", emptyList<String>(), filled.missing)
                check(filled.check.ok) { "$case $formId self-check: ${filled.check}" }
                check(v.document.addendum.isNotEmpty()) { "$case $formId: the version's note needs an addendum page" }
            }
        }
    }

    @Test
    fun accentsAndCurlyQuotes() {
        val answers = Fixtures.answers("both").also {
            it["first_name"] = Json.Str("Zoë “Zo” O’Brien-Łukasiewicz")
            it["last_name"] = Json.Str("Ñúñez 😀")
        }
        fillAndPublish("winansi", answers)
    }
}
