package org.ssa.assistant.pdf

import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDResources
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.font.PDFont
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import org.ssa.assistant.core.js.jsNumberToString
import org.ssa.assistant.core.pdf.AppearanceLayout
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.ManifestEntry
import org.ssa.assistant.core.pdf.TextAppearance
import org.ssa.assistant.core.pdf.WinAnsi

/**
 * Applies a [FormDocument]'s plan to a loaded template: PDFBox is used only
 * as the object model. Values are written to /V directly, every appearance is
 * drawn here from the plan's lines, and PDFBox's own appearance generator is
 * never run — it wraps without kerning and with its own padding, and could
 * clip text TextFitter measured as fitting. No refreshAppearances(), no
 * NeedAppearances, no flattening: the fields stay editable.
 *
 * The font: filled fields draw with /HelvWA, standard Helvetica with
 * WinAnsiEncoding, added to /DR. The Starter Kit's own /Helv carries
 * PDFDocEncoding differences (0x85 is an en dash there, an ellipsis in
 * WinAnsi), so the plan's WinAnsi bytes would draw the wrong glyphs under it
 * — "(see attached)" cuts end in "…". Naming /HelvWA in the DA as well means
 * a viewer that regenerates an edited field uses the same encoding.
 */
object AcroFormWriter {
    /** Returns the names the plan used that the template lacks (never expected). */
    fun apply(doc: PDDocument, fd: FormDocument): List<String> {
        val acro = doc.documentCatalog.acroForm ?: throw IllegalStateException("template has no AcroForm")
        val missing = fd.plan.missing.toMutableList()

        val font = Fonts.winAnsi("Helvetica")
        val dr = acro.defaultResources ?: PDResources().also { acro.defaultResources = it }
        dr.put(Fonts.HELV_WA, font)

        for (pf in fd.plan.fields) {
            val field = acro.getField(pf.name) as? PDTextField
            val entry = fd.manifest.field(pf.name)
            if (field == null || entry == null) { missing.add(pf.name); continue }

            val cos = field.cosObject
            cos.setString(COSName.V, pf.fit.text)
            val da = "/${Fonts.HELV_WA.name} ${jsNumberToString(pf.fit.size)} Tf 0 g"
            cos.setString(COSName.DA, da)

            val layout = AppearanceLayout.layout(entry, pf.fit)
            for (widget in field.widgets) {
                val w = widget.cosObject
                if (w !== cos && w.containsKey(COSName.DA)) w.setString(COSName.DA, da)
                w.setItem(COSName.AP, COSDictionary().apply {
                    setItem(COSName.N, textAppearance(doc, entry, layout, font).cosObject)
                })
            }
        }

        for ((name, option) in fd.plan.radios) {
            if (option.isEmpty()) continue
            val radio = acro.getField(name) as? PDRadioButton
            if (radio == null || option !in radio.onValues) { missing.add(name); continue }
            radio.setValue(option)
        }

        for (name in fd.plan.checks) {
            val box = acro.getField(name) as? PDCheckBox
            if (box == null) { missing.add(name); continue }
            box.check()
        }

        doc.documentInformation.title = fd.spec.title
        doc.documentInformation.creator = org.ssa.assistant.core.pdf.FormDocuments.CREATOR
        return missing
    }

    /**
     * One text widget's /AP /N, laid out as pdf-lib's drawTextField():
     * `q <clip> W n /Tx BMC q BT 0 g /HelvWA size Tf (Tm Tj)… ET Q EMC Q`.
     * The BBox is the manifest's box (pdf-lib's doubles, never PDFBox's
     * floats). The widget has no /MK colours on either template, so like
     * pdf-lib's output there is no background or border to paint
     * (TemplateContractTest fails if that ever changes).
     */
    private fun textAppearance(doc: PDDocument, entry: ManifestEntry, layout: TextAppearance, font: PDFont): PDAppearanceStream {
        val b = layout.bounds
        val c = Content()
            .op("q")
            .op(b.x, b.y, b.width, b.height, "re")
            .op("W")
            .op("n")
            .op("/Tx", "BMC")
            .op("q")
            .op("BT")
            .op("0", "g")
            .op("/${Fonts.HELV_WA.name}", layout.size, "Tf")
        for (line in layout.lines) {
            c.op(1.0, 0.0, 0.0, 1.0, line.x, line.y, "Tm")
            c.op(Content.hex(WinAnsi.encode(line.text)), "Tj")
        }
        c.op("ET").op("Q").op("EMC").op("Q")

        val ap = PDAppearanceStream(doc)
        ap.bBox = PDRectangle(0f, 0f, entry.width.toFloat(), entry.height.toFloat())
        ap.resources = PDResources().apply { put(Fonts.HELV_WA, font) }
        ap.contentStream.createOutputStream(COSName.FLATE_DECODE).use { it.write(c.bytes()) }
        return ap
    }
}
