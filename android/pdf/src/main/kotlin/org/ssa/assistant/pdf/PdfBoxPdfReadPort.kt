package org.ssa.assistant.pdf

import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSString
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceEntry
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDAcroForm
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDSignatureField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTerminalField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import org.ssa.assistant.core.pdf.ContentStreamTokenizer
import org.ssa.assistant.core.pdf.DrawnContent
import org.ssa.assistant.core.pdf.PdfAppearanceView
import org.ssa.assistant.core.pdf.PdfFieldView
import org.ssa.assistant.core.pdf.PdfReadPort
import org.ssa.assistant.core.pdf.PdfReader
import org.ssa.assistant.core.pdf.PdfWidgetView

/**
 * The PdfBox-Android implementation of [PdfReadPort], so the core [PdfSelfCheck]
 * can run against a real PDDocument. PDFBox is not thread-safe and the core
 * check runs on the caller's thread, so every PDDocument access here — including
 * [PdfReader.close] — runs inside [PdfThread.run].
 */
object PdfBoxPdfReadPort : PdfReadPort {

    private const val OFF = "Off"

    override fun reader(bytes: ByteArray): PdfReader {
        val doc = PdfThread.run { TemplateLoader.open(bytes) }
        return Reader(doc)
    }

    private class Reader(private val doc: PDDocument) : PdfReader {

        override fun hasAcroForm(): Boolean =
            PdfThread.run { doc.documentCatalog.acroForm != null }

        override fun pageCount(): Int =
            PdfThread.run { doc.numberOfPages }

        override fun pageSize(index: Int): Pair<Double, Double> = PdfThread.run {
            val page = doc.getPage(index)
            page.mediaBox.width.toDouble() to page.mediaBox.height.toDouble()
        }

        override fun needAppearances(): Boolean =
            PdfThread.run { doc.documentCatalog.acroForm?.needAppearances ?: false }

        override fun hasXfa(): Boolean =
            PdfThread.run { doc.documentCatalog.acroForm?.hasXFA() ?: false }

        override fun sigFlags(): Int? = PdfThread.run {
            val acro = doc.documentCatalog.acroForm ?: return@run null
            val cos = acro.cosObject
            if (cos.containsKey(COSName.SIG_FLAGS)) cos.getInt(COSName.SIG_FLAGS) else null
        }

        override fun hasWinAnsiHelvWaInDefaultResources(): Boolean = PdfThread.run {
            val acro = doc.documentCatalog.acroForm ?: return@run false
            isWinAnsiHelvetica(acro.defaultResources?.cosObject?.let { fontDict(it, Fonts.HELV_WA) })
        }

        override fun terminalFieldNames(): Set<String> = PdfThread.run {
            val acro = doc.documentCatalog.acroForm ?: return@run emptySet()
            terminals(acro).keys
        }

        override fun field(name: String): PdfFieldView? = PdfThread.run {
            val acro = doc.documentCatalog.acroForm ?: return@run null
            val f = terminals(acro)[name] ?: return@run null
            toFieldView(f)
        }

        override fun pageContent(index: Int): ByteArray = PdfThread.run {
            doc.getPage(index).contents.use { it.readBytes() }
        }

        override fun close() {
            PdfThread.run { doc.close() }
        }
    }

    // -- field and widget projection -----------------------------------------

    private fun toFieldView(f: PDField): PdfFieldView {
        val type = when (f) {
            is PDTextField -> "text"
            is PDCheckBox -> "checkbox"
            is PDRadioButton -> "radio"
            is PDSignatureField -> "signature"
            else -> "other"
        }
        val value = when (f) {
            is PDTextField -> (f.cosObject.getDictionaryObject(COSName.V) as? COSString)?.string
            is PDCheckBox -> (f.cosObject.getDictionaryObject(COSName.V) as? COSName)?.name
            is PDRadioButton -> f.value
            is PDSignatureField -> if (f.cosObject.containsKey(COSName.V)) "signed" else null
            else -> null
        }
        val readOnly = f.isReadOnly
        val da = f.cosObject.getString(COSName.DA)
        val widgets = (f as? PDTerminalField)?.widgets?.map { toWidgetView(f, it) } ?: emptyList()
        return PdfFieldView(type, value, readOnly, da, widgets)
    }

    private fun toWidgetView(f: PDField, w: PDAnnotationWidget): PdfWidgetView {
        // A widget whose COS object is the field's own inherits its /DA; the
        // writer only sets /DA on a widget when it differs from the field's.
        val inherits = w.cosObject === f.cosObject || !w.cosObject.containsKey(COSName.DA)
        val da = if (inherits) null else w.cosObject.getString(COSName.DA)
        return PdfWidgetView(
            da = da,
            appearanceState = w.appearanceState?.name,
            normalAppearance = w.appearance?.normalAppearance?.let { toAppearanceView(it) },
            normalAppearanceBytes = appearanceBytes(w),
        )
    }

    private fun toAppearanceView(entry: PDAppearanceEntry): PdfAppearanceView {
        if (entry.isStream) {
            val stream = entry.appearanceStream
            val drawn = ContentStreamTokenizer.drawn(stream.cosObject.createInputStream().use { it.readBytes() })
            return PdfAppearanceView(
                isStream = true,
                bbox = stream.bBox.width.toDouble() to stream.bBox.height.toDouble(),
                hasWinAnsiHelvWa = isWinAnsiHelvetica(
                    stream.resources?.cosObject?.let { fontDict(it, Fonts.HELV_WA) }
                ),
                drawn = drawn,
                onStates = emptyList(),
            )
        }
        val onStates = entry.subDictionary.keys.map { it.name }.filter { it != OFF }
        return PdfAppearanceView(
            isStream = false,
            bbox = null,
            hasWinAnsiHelvWa = false,
            drawn = DrawnContent(emptyList(), emptyList()),
            onStates = onStates,
        )
    }

    private fun appearanceBytes(w: PDAnnotationWidget): List<Pair<String, List<Byte>>> {
        val n = w.appearance?.normalAppearance ?: return emptyList()
        val streams = if (n.isStream) listOf("" to n.appearanceStream)
        else n.subDictionary.entries.sortedBy { it.key.name }.map { it.key.name to it.value }
        return streams.map { (k, s) -> k to s.cosObject.createInputStream().use { it.readBytes() }.toList() }
    }

    // -- shared PdfBox helpers (ported from the old PdfSelfCheck) ------------

    private fun terminals(acro: PDAcroForm): Map<String, PDField> {
        val out = LinkedHashMap<String, PDField>()
        for (f in acro.fieldTree) if (f is PDTerminalField) out[f.fullyQualifiedName] = f
        return out
    }

    private fun fontDict(resources: COSDictionary, name: COSName): COSDictionary? =
        (resources.getDictionaryObject(COSName.FONT) as? COSDictionary)?.getDictionaryObject(name) as? COSDictionary

    private fun isWinAnsiHelvetica(font: COSDictionary?): Boolean =
        font != null &&
            font.getCOSName(COSName.BASE_FONT)?.name == "Helvetica" &&
            font.getCOSName(COSName.ENCODING) == COSName.WIN_ANSI_ENCODING
}
