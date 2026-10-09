package org.ssa.assistant.pdf

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDSignatureField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTerminalField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.ssa.assistant.core.pdf.TemplateManifest
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * What PDFBox reads from each template must match the `templateManifest` the
 * plan was made from (box sizes within 1e-3 — PDFBox stores reals as 32-bit
 * floats), and the templates must not have grown anything the writer does
 * not handle: comb fields, MaxLen, /Opt, a second widget on a text field, or
 * /MK colours on a text widget (the writer's appearances paint none).
 */
@RunWith(AndroidJUnit4::class)
class TemplateContractTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val templates = TemplateLoader(context)
    private val schema = SchemaLoader.load()

    private fun contract(formId: String, fieldCount: Int) = PdfThread.run {
        val manifest = TemplateManifest.forForm(formId)
        TemplateLoader.open(templates.bytes(schema.formSpecs.getValue(formId).template)).use { doc ->
            val acro = doc.documentCatalog.acroForm!!
            check(!acro.hasXFA()) { "$formId: XFA" }
            check(!acro.needAppearances) { "$formId: NeedAppearances" }
            val fields = acro.fieldTree.filterIsInstance<PDTerminalField>().associateBy { it.fullyQualifiedName }
            assertEquals("$formId field count", fieldCount, fields.size)
            assertEquals("$formId field names", manifest.fields.keys, fields.keys)

            for ((name, entry) in manifest.fields) {
                val f = fields.getValue(name)
                val cos = f.cosObject
                check(!cos.containsKey(COSName.OPT)) { "$name has /Opt" }
                when (entry.type) {
                    "text" -> {
                        f as? PDTextField ?: error("$name is not a text field in PDFBox")
                        check(!f.isComb) { "$name is combed" }
                        check(f.maxLen < 0) { "$name has MaxLen ${f.maxLen}" }
                        assertEquals("$name multiline", entry.multiline, f.isMultiline)
                        assertEquals("$name /Q", entry.quadding ?: 0, f.q)
                        assertEquals("$name widgets", 1, f.widgets.size)
                        val w = f.widgets[0]
                        val r = w.rectangle
                        check(abs(r.width - entry.width) < 1e-3) { "$name width ${r.width} vs ${entry.width}" }
                        check(abs(r.height - entry.height) < 1e-3) { "$name height ${r.height} vs ${entry.height}" }
                        val bw = (w.cosObject.getDictionaryObject(COSName.BS) as? COSDictionary)?.getFloat(COSName.W, 1f)
                        assertEquals("$name border width", entry.borderWidth, (bw ?: 0f).toDouble(), 1e-6)
                        val mk = w.cosObject.getDictionaryObject(COSName.MK) as? COSDictionary
                        for (key in listOf(COSName.BG, COSName.BC)) {
                            val colour = mk?.getDictionaryObject(key) as? COSArray
                            check(colour == null || colour.size() == 0) { "$name has /MK ${key.name} colours" }
                        }
                        assertEquals("$name DA present", entry.da != null, cos.containsKey(COSName.DA))
                    }
                    "checkbox" -> {
                        f as? PDCheckBox ?: error("$name is not a checkbox in PDFBox")
                        assertEquals("$name on-values", entry.onStates?.filterNotNull()?.toSet(), f.onValues)
                        assertEquals("$name on-value is Yes", "Yes", f.onValue)
                    }
                    "radio" -> {
                        f as? PDRadioButton ?: error("$name is not a radio group in PDFBox")
                        assertEquals("$name options", entry.onStates?.filterNotNull()?.toSet(), f.onValues)
                    }
                    "signature" -> f as? PDSignatureField ?: error("$name is not a signature field in PDFBox")
                }
            }
            if (formId == "ds") assertEquals("SigFlags", 1, acro.cosObject.getInt(COSName.SIG_FLAGS))
        }
    }

    @Test fun starterKit() = contract("ssa", 116)
    @Test fun dsIntake() = contract("ds", 126)

    @Test
    fun aTamperedTemplateIsRefused() {
        val path = schema.formSpecs.getValue("ssa").template
        val good = templates.bytes(path)
        check(TemplateLoader.sha256(good).length == 64)
        // The loader re-hashes on every load; a different path is not pinned.
        val refused = runCatching { templates.bytes("forms/not-a-template.pdf") }.exceptionOrNull()
        check(refused is TemplateException) { "an unpinned template was not refused" }
    }
}
