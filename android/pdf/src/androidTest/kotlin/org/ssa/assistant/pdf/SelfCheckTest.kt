package org.ssa.assistant.pdf

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import java.io.ByteArrayOutputStream
import org.junit.Test
import org.junit.runner.RunWith
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The self-check is what stands between a bad file and a claimant, so each
 * of its checks is proven to fire: a filled PDF is damaged in one way, and
 * the check must fail, name the field, and never repeat a value.
 */
@RunWith(AndroidJUnit4::class)
class SelfCheckTest {
    private val schema = SchemaLoader.load()
    private val templates = TemplateLoader(Fixtures.context)
    private val filler = FormFiller(templates)

    private val fd: FormDocument = FormDocuments.plan(schema, "ds", Fixtures.answers("both"), Fixtures.TODAY)
    private val filled = filler.fill(fd)
    private val template = templates.bytes(fd.spec.template)
    private val target = fd.plan.fields.first { it.value.length > 3 }

    private fun damaged(edit: (PDDocument) -> Unit): PdfSelfCheck.Result {
        val bytes = PdfThread.run {
            TemplateLoader.open(filled.bytes).use { doc ->
                edit(doc)
                ByteArrayOutputStream().also { doc.save(it) }.toByteArray()
            }
        }
        return PdfSelfCheck.check(bytes, template, fd)
    }

    private fun assertCaught(result: PdfSelfCheck.Result, field: String?) {
        check(!result.ok) { "the damage went unnoticed" }
        if (field != null) check(result.problems.any { it.field == field }) { "no problem names $field: $result" }
        val values = fd.plan.fields.map { it.value }.filter { it.length > 3 }
        val leaked = result.problems.flatMap { p -> values.filter { v -> p.check.contains(v) } }
        check(leaked.isEmpty()) { "a problem repeats a value" }
    }

    @Test fun theUndamagedFormPasses() = check(filled.check.ok) { filled.check.toString() }

    @Test
    fun aChangedValueIsCaught() = assertCaught(damaged { doc ->
        (doc.documentCatalog.acroForm.getField(target.name) as PDTextField).cosObject.setString(COSName.V, "something else")
    }, target.name)

    @Test
    fun aMissingAppearanceIsCaught() = assertCaught(damaged { doc ->
        (doc.documentCatalog.acroForm.getField(target.name) as PDTextField).widgets.forEach { it.cosObject.removeItem(COSName.AP) }
    }, target.name)

    @Test
    fun pdfBoxsOwnAppearanceIsCaught() = assertCaught(damaged { doc ->
        // setValue() runs PDFBox's appearance generator, which the writer
        // never uses: its lines and padding are not the plan's.
        (doc.documentCatalog.acroForm.getField(target.name) as PDTextField).setValue(target.fit.text + " and more words")
    }, target.name)

    @Test
    fun aTouchedBlankFieldIsCaught() {
        val blank = fd.manifest.fields.entries.first { (name, e) -> e.type == "text" && fd.plan.fields.none { it.name == name } }.key
        assertCaught(damaged { doc ->
            doc.documentCatalog.acroForm.getField(blank).cosObject.setString(COSName.V, "x")
        }, blank)
    }

    @Test
    fun aMissingAddendumPageIsCaught() {
        check(fd.addendum.isNotEmpty()) { "this case has no addendum to remove" }
        assertCaught(damaged { doc -> doc.removePage(doc.numberOfPages - 1) }, null)
    }

    @Test
    fun needAppearancesIsCaught() = assertCaught(damaged { doc -> doc.documentCatalog.acroForm.needAppearances = true }, null)

    @Test
    fun garbageIsCaught() {
        val r = PdfSelfCheck.check(ByteArray(100) { 'x'.code.toByte() }, template, fd)
        check(!r.ok)
    }

    @Test
    fun aFailedCheckOffersTheWorksheet() {
        // A plan naming a field the template lacks cannot be offered as the form.
        val broken = FormDocument(fd.formId, fd.spec, fd.manifest,
            fd.plan.copy(checks = fd.plan.checks + "No such checkbox"), fd.addendum)
        val outcome = filler.export(broken) { FormDocuments.worksheet(schema, Fixtures.answers("both"), Fixtures.TODAY) }
        check(outcome is FormFiller.Outcome.Worksheet) { "a failing form was offered" }
        val pages = PdfThread.run { TemplateLoader.open(outcome.bytes).use { it.numberOfPages } }
        check(pages > 0)
    }
}
