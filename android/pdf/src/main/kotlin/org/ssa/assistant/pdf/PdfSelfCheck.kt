package org.ssa.assistant.pdf

import com.tom_roush.pdfbox.contentstream.PDContentStream
import com.tom_roush.pdfbox.contentstream.operator.Operator
import com.tom_roush.pdfbox.cos.COSBase
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSNumber
import com.tom_roush.pdfbox.cos.COSString
import com.tom_roush.pdfbox.pdfparser.PDFStreamParser
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDAcroForm
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDSignatureField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTerminalField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import org.ssa.assistant.core.js.jsNumberToString
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.Op
import org.ssa.assistant.core.pdf.WinAnsi

/**
 * Runs on every export, on the device: reopens the bytes that are about to
 * be offered and checks them against the plan (the plan's L2 checks). If
 * anything fails, the form is not offered; the worksheet is.
 *
 *   - the file opens; pages = template pages + addendum pages
 *   - the field set is the template's (116 / 126), nothing flattened, no
 *     NeedAppearances, no XFA, SigFlags unchanged
 *   - every filled text field: /V is the planned text, the DA names /HelvWA
 *     at the planned size, /HelvWA is WinAnsi Helvetica in /DR and in the
 *     appearance's resources, and the appearance draws exactly the planned
 *     lines (each `Tj` operand compared byte for byte)
 *   - every checked box and the radio: value, /AS and an appearance for it
 *   - everything the plan did not touch, signatures included, is the
 *     template's own: same value, same state, same appearance bytes
 *   - every addendum page draws exactly its draw list's text
 *
 * A problem names a field and a check — never a value — so a failure report
 * can be logged or spoken without carrying an SSN.
 */
object PdfSelfCheck {
    /** A button's off state. (COSName.OFF is /OFF, optional content's name.) */
    private const val OFF = "Off"

    data class Problem(val field: String?, val check: String)

    /** What the form says, field by field, as read back from the bytes. For the spoken preview. */
    data class ReadBack(val label: String, val value: String)

    class Result(val problems: List<Problem>, val pages: Int, val fields: Int, val readBack: List<ReadBack>) {
        val ok: Boolean get() = problems.isEmpty()
        override fun toString(): String =
            if (ok) "ok ($fields fields, $pages pages)"
            else problems.joinToString("; ") { "${it.field ?: "document"}: ${it.check}" }
    }

    fun check(bytes: ByteArray, template: ByteArray, fd: FormDocument): Result = PdfThread.run {
        val doc = try { TemplateLoader.open(bytes) } catch (e: Exception) {
            return@run Result(listOf(Problem(null, "does not open")), 0, 0, emptyList())
        }
        doc.use { TemplateLoader.open(template).use { tpl -> Checker(doc, tpl, fd).run() } }
    }

    private class Checker(val doc: PDDocument, val tpl: PDDocument, val fd: FormDocument) {
        val problems = mutableListOf<Problem>()
        val readBack = mutableListOf<ReadBack>()
        fun fail(field: String?, check: String) { problems.add(Problem(field, check)) }

        fun run(): Result {
            val expectedPages = tpl.numberOfPages + fd.addendum.size
            if (doc.numberOfPages != expectedPages) fail(null, "has ${doc.numberOfPages} pages, expected $expectedPages")

            val acro = doc.documentCatalog.acroForm
            val tplAcro = tpl.documentCatalog.acroForm ?: throw IllegalStateException("template has no AcroForm")
            if (acro == null) {
                fail(null, "has no AcroForm")
                return Result(problems, doc.numberOfPages, 0, readBack)
            }
            if (acro.needAppearances) fail(null, "sets NeedAppearances")
            if (acro.hasXFA()) fail(null, "has XFA")
            if (acro.cosObject.getInt(COSName.SIG_FLAGS) != tplAcro.cosObject.getInt(COSName.SIG_FLAGS)) fail(null, "SigFlags changed")
            if (!isWinAnsiHelvetica(acro.defaultResources?.cosObject?.let { fontDict(it, Fonts.HELV_WA) })) {
                fail(null, "/DR has no WinAnsi /HelvWA")
            }

            val fields = terminals(acro)
            val tplFields = terminals(tplAcro)
            if (fields.keys != tplFields.keys) fail(null, "field set differs from the template")
            if (fields.size != fd.manifest.fields.size) fail(null, "has ${fields.size} fields, manifest has ${fd.manifest.fields.size}")

            val touched = HashSet<String>()
            for (pf in fd.plan.fields) {
                touched.add(pf.name)
                val f = fields[pf.name] as? PDTextField ?: run { fail(pf.name, "is not a text field"); null } ?: continue
                checkText(f, pf.fit.text, pf.fit.size, pf.fit.lines)
                readBack.add(ReadBack(pf.label, (f.cosObject.getDictionaryObject(COSName.V) as? COSString)?.string ?: ""))
            }
            for (name in fd.plan.checks) {
                touched.add(name)
                val box = fields[name] as? PDCheckBox ?: run { fail(name, "is not a checkbox"); null } ?: continue
                if (!box.isChecked) fail(name, "is not checked")
                for (w in box.widgets) checkState(name, w, box.onValue)
                readBack.add(ReadBack(name, "checked"))
            }
            for ((name, option) in fd.plan.radios) {
                if (option.isEmpty()) continue
                touched.add(name)
                val radio = fields[name] as? PDRadioButton ?: run { fail(name, "is not a radio group"); null } ?: continue
                if (radio.value != option) fail(name, "is not set to its planned option")
                for (w in radio.widgets) {
                    val on = onState(w)
                    checkState(name, w, if (on == option) option else OFF)
                }
                readBack.add(ReadBack(name, option))
            }

            for ((name, field) in fields) {
                if (name in touched) continue
                val original = tplFields[name] ?: continue
                if (field is PDSignatureField && field.cosObject.containsKey(COSName.V)) fail(name, "signature has a value")
                untouched(name, field, original)
            }

            checkAddendum()
            return Result(problems, doc.numberOfPages, fields.size, readBack)
        }

        fun checkText(f: PDTextField, text: String, size: Double, lines: List<String>) {
            val name = f.fullyQualifiedName
            val v = f.cosObject.getDictionaryObject(COSName.V) as? COSString
            if (v?.string != text) fail(name, "/V is not the planned text")
            val da = "/${Fonts.HELV_WA.name} ${jsNumberToString(size)} Tf 0 g"
            if (f.cosObject.getString(COSName.DA) != da) fail(name, "DA is not /HelvWA at the planned size")
            if (f.widgets.isEmpty()) fail(name, "has no widget")
            for (w in f.widgets) {
                if (w.cosObject !== f.cosObject && w.cosObject.containsKey(COSName.DA) && w.cosObject.getString(COSName.DA) != da) {
                    fail(name, "widget DA is not /HelvWA at the planned size")
                }
                val ap = w.appearance?.normalAppearance
                if (ap == null || !ap.isStream) { fail(name, "has no /AP /N stream"); continue }
                val stream = ap.appearanceStream
                if (!isWinAnsiHelvetica(stream.resources?.cosObject?.let { fontDict(it, Fonts.HELV_WA) })) {
                    fail(name, "appearance has no WinAnsi /HelvWA")
                }
                val drawn = drawn(stream)
                val want = lines.map { WinAnsi.encode(it).toList() }
                if (drawn.strings != want) fail(name, "appearance draws ${drawn.strings.size} lines, not the planned ${want.size}")
                if (drawn.fonts.any { it != Fonts.HELV_WA.name to size }) fail(name, "appearance font is not /HelvWA at the planned size")
            }
        }

        fun checkState(name: String, w: PDAnnotationWidget, state: String) {
            if (w.appearanceState?.name != state) fail(name, "/AS is not $state")
            val n = w.appearance?.normalAppearance
            if (state != OFF && (n == null || !n.isSubDictionary || n.subDictionary[COSName.getPDFName(state)] == null)) {
                fail(name, "has no appearance for $state")
            }
        }

        fun untouched(name: String, field: PDField, original: PDField) {
            if (str(field.cosObject.getDictionaryObject(COSName.V)) != str(original.cosObject.getDictionaryObject(COSName.V))) {
                fail(name, "value changed though the plan left it alone")
            }
            val ws = (field as? PDTerminalField)?.widgets ?: return
            val os = (original as? PDTerminalField)?.widgets ?: return
            if (ws.size != os.size) { fail(name, "widget count changed"); return }
            for (i in ws.indices) {
                if (ws[i].appearanceState?.name != os[i].appearanceState?.name) fail(name, "/AS changed though the plan left it alone")
                if (appearanceBytes(ws[i]) != appearanceBytes(os[i])) fail(name, "appearance changed though the plan left it alone")
            }
        }

        fun checkAddendum() {
            val first = tpl.numberOfPages
            for ((i, ops) in fd.addendum.withIndex()) {
                if (first + i >= doc.numberOfPages) return
                val drawn = drawn(doc.getPage(first + i))
                val want = ops.filterIsInstance<Op.Text>().map { WinAnsi.encode(WinAnsi.toWinAnsi(it.text)).toList() }
                if (drawn.strings != want) fail(null, "addendum page ${i + 1} does not draw its draw list")
            }
        }
    }

    private class Drawn(val strings: List<List<Byte>>, val fonts: List<Pair<String, Double>>)

    /** Every `Tj` operand and every `Tf` in a content stream, in order. */
    private fun drawn(content: PDContentStream): Drawn {
        val parser = PDFStreamParser(content)
        parser.parse()
        val strings = mutableListOf<List<Byte>>()
        val fonts = mutableListOf<Pair<String, Double>>()
        val operands = mutableListOf<Any>()
        for (token in parser.tokens) {
            if (token !is Operator) { operands.add(token); continue }
            when (token.name) {
                "Tj" -> (operands.lastOrNull() as? COSString)?.let { strings.add(it.bytes.toList()) }
                "Tf" -> {
                    val font = operands.getOrNull(0) as? COSName
                    val size = operands.getOrNull(1) as? COSNumber
                    if (font != null && size != null) fonts.add(font.name to size.doubleValue())
                }
            }
            operands.clear()
        }
        return Drawn(strings, fonts)
    }

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

    private fun onState(w: PDAnnotationWidget): String? =
        w.appearance?.normalAppearance?.takeIf { it.isSubDictionary }?.subDictionary?.keys
            ?.map { it.name }?.firstOrNull { it != OFF }

    private fun str(b: COSBase?): String? = when (b) {
        null -> null
        is COSString -> "s:" + b.string
        is COSName -> "n:" + b.name
        else -> b.toString()
    }

    private fun appearanceBytes(w: PDAnnotationWidget): List<Any?> {
        val n = w.appearance?.normalAppearance ?: return emptyList()
        val streams = if (n.isStream) listOf("" to n.appearanceStream)
        else n.subDictionary.entries.sortedBy { it.key.name }.map { it.key.name to it.value }
        return streams.map { (k, s) -> k to s.cosObject.createInputStream().use { it.readBytes() }.toList() }
    }
}
