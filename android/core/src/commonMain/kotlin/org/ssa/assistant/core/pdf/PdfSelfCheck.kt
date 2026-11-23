package org.ssa.assistant.core.pdf

import kotlin.math.abs
import org.ssa.assistant.core.js.jsNumberToString

/**
 * Runs on every export, on the device: reopens the bytes that are about to
 * be offered and checks them against the plan (the plan's L2 checks). If
 * anything fails, the form is not offered; the worksheet is.
 *
 * This is the core half of the moved self-check: it works only over
 * [PdfReadPort], so it can run against the PdfBox reader on Android and, one
 * day, a CGPDF reader on iOS, without any PDF library of its own.
 *
 *   - the file opens; pages = template pages + addendum pages
 *   - the field set is the template's, nothing flattened, no NeedAppearances,
 *     no XFA, SigFlags unchanged
 *   - every filled text field: /V is the planned text, the DA names /HelvWA
 *     at the planned size, /HelvWA is WinAnsi Helvetica in /DR and in the
 *     appearance's resources, and the appearance draws exactly the planned
 *     lines (each Tj operand compared byte for byte)
 *   - every checked box and the radio: value, /AS and an appearance for it
 *   - everything the plan did not touch, signatures included, is the
 *     template's own: same value, same state, same appearance bytes
 *   - every addendum page draws exactly its draw list's text
 *
 * A problem names a field and a check — never a value — so a failure report
 * can be logged or spoken without carrying an SSN.
 */
object PdfSelfCheck {
    /** A button's off state. */
    private const val OFF = "Off"

    /** The name filled fields' DAs and appearances use; added to /DR. */
    private const val HELV_WA = "HelvWA"

    data class Problem(val field: String?, val check: String)

    /** What the form says, field by field, as read back from the bytes. For the spoken preview. */
    data class ReadBack(val label: String, val value: String)

    class Result(val problems: List<Problem>, val pages: Int, val fields: Int, val readBack: List<ReadBack>) {
        val ok: Boolean get() = problems.isEmpty()
        override fun toString(): String =
            if (ok) "ok ($fields fields, $pages pages)"
            else problems.joinToString("; ") { "${it.field ?: "document"}: ${it.check}" }
    }

    fun check(bytes: ByteArray, template: ByteArray, fd: FormDocument, port: PdfReadPort): Result {
        val doc = try {
            port.reader(bytes)
        } catch (e: Exception) {
            return Result(listOf(Problem(null, "does not open")), 0, 0, emptyList())
        }
        val tpl = port.reader(template)
        try {
            return Checker(doc, tpl, fd).run()
        } finally {
            doc.close()
            tpl.close()
        }
    }

    private class Checker(val doc: PdfReader, val tpl: PdfReader, val fd: FormDocument) {
        val problems = mutableListOf<Problem>()
        val readBack = mutableListOf<ReadBack>()
        fun fail(field: String?, check: String) { problems.add(Problem(field, check)) }

        fun run(): Result {
            val expectedPages = tpl.pageCount() + fd.addendum.size
            if (doc.pageCount() != expectedPages) fail(null, "has ${doc.pageCount()} pages, expected $expectedPages")

            if (!doc.hasAcroForm()) {
                fail(null, "has no AcroForm")
                return Result(problems, doc.pageCount(), 0, readBack)
            }
            if (doc.needAppearances()) fail(null, "sets NeedAppearances")
            if (doc.hasXfa()) fail(null, "has XFA")
            if (doc.sigFlags() != tpl.sigFlags()) fail(null, "SigFlags changed")
            if (!doc.hasWinAnsiHelvWaInDefaultResources()) {
                fail(null, "/DR has no WinAnsi /HelvWA")
            }

            val fieldNames = doc.terminalFieldNames()
            val tplFieldNames = tpl.terminalFieldNames()
            if (fieldNames != tplFieldNames) fail(null, "field set differs from the template")
            if (fieldNames.size != fd.manifest.fields.size) fail(null, "has ${fieldNames.size} fields, manifest has ${fd.manifest.fields.size}")

            val touched = HashSet<String>()
            for (pf in fd.plan.fields) {
                touched.add(pf.name)
                val f = doc.field(pf.name)
                if (f == null || f.type != "text") { fail(pf.name, "is not a text field"); continue }
                val entry = fd.manifest.field(pf.name) ?: run { fail(pf.name, "is not in the manifest"); null } ?: continue
                checkText(pf.name, f, entry, pf.fit.text, pf.fit.size, pf.fit.lines)
                readBack.add(ReadBack(pf.label, f.value ?: ""))
            }
            for (name in fd.plan.checks) {
                touched.add(name)
                val box = doc.field(name)
                if (box == null || box.type != "checkbox") { fail(name, "is not a checkbox"); continue }
                if (!(box.value != null && box.value != OFF)) fail(name, "is not checked")
                for (w in box.widgets) checkState(name, w, box.value ?: OFF)
                readBack.add(ReadBack(name, "checked"))
            }
            for ((name, option) in fd.plan.radios) {
                if (option.isEmpty()) continue
                touched.add(name)
                val radio = doc.field(name)
                if (radio == null || radio.type != "radio") { fail(name, "is not a radio group"); continue }
                if (radio.value != option) fail(name, "is not set to its planned option")
                for (w in radio.widgets) {
                    val on = w.normalAppearance?.onStates?.firstOrNull { it != OFF }
                    checkState(name, w, if (on == option) option else OFF)
                }
                readBack.add(ReadBack(name, option))
            }

            for (name in fieldNames) {
                if (name in touched) continue
                val field = doc.field(name) ?: continue
                val original = tpl.field(name) ?: continue
                if (field.type == "signature" && field.value != null) fail(name, "signature has a value")
                untouched(name, field, original)
            }

            checkAddendum()
            return Result(problems, doc.pageCount(), fieldNames.size, readBack)
        }

        fun checkText(name: String, f: PdfFieldView, entry: ManifestEntry, text: String, size: Double, lines: List<String>) {
            if (f.readOnly) fail(name, "is read-only")
            if (f.value != text) fail(name, "/V is not the planned text")
            val da = "/$HELV_WA ${jsNumberToString(size)} Tf 0 g"
            if (f.da != da) fail(name, "DA is not /HelvWA at the planned size")
            if (f.widgets.isEmpty()) fail(name, "has no widget")
            for (w in f.widgets) {
                if (w.da != null && w.da != da) {
                    fail(name, "widget DA is not /HelvWA at the planned size")
                }
                val ap = w.normalAppearance
                if (ap == null || !ap.isStream) { fail(name, "has no /AP /N stream"); continue }
                val bbox = ap.bbox
                if (bbox == null || abs(bbox.first - entry.width) > 1e-3 || abs(bbox.second - entry.height) > 1e-3) {
                    fail(name, "appearance box is not the manifest box")
                }
                if (!ap.hasWinAnsiHelvWa) {
                    fail(name, "appearance has no WinAnsi /HelvWA")
                }
                val drawn = ap.drawn
                val want = lines.map { WinAnsi.encode(it).toList() }
                if (drawn.strings != want) fail(name, "appearance draws ${drawn.strings.size} lines, not the planned ${want.size}")
                if (drawn.fonts.any { it != HELV_WA to size }) fail(name, "appearance font is not /HelvWA at the planned size")
            }
        }

        fun checkState(name: String, w: PdfWidgetView, state: String) {
            if (w.appearanceState != state) fail(name, "/AS is not $state")
            val n = w.normalAppearance
            if (state != OFF && (n == null || n.isStream || state !in n.onStates)) {
                fail(name, "has no appearance for $state")
            }
        }

        fun untouched(name: String, field: PdfFieldView, original: PdfFieldView) {
            if (field.value != original.value || field.rawValue != original.rawValue) fail(name, "value changed though the plan left it alone")
            val ws = field.widgets
            val os = original.widgets
            if (ws.size != os.size) { fail(name, "widget count changed"); return }
            for (i in ws.indices) {
                if (ws[i].appearanceState != os[i].appearanceState) fail(name, "/AS changed though the plan left it alone")
                if (ws[i].normalAppearanceBytes != os[i].normalAppearanceBytes) fail(name, "appearance changed though the plan left it alone")
            }
        }

        fun checkAddendum() {
            val first = tpl.pageCount()
            for ((i, ops) in fd.addendum.withIndex()) {
                if (first + i >= doc.pageCount()) return
                val size = doc.pageSize(first + i)
                if (abs(size.first - Page.W) > 1e-3 || abs(size.second - Page.H) > 1e-3) {
                    fail(null, "addendum page ${i + 1} is not US Letter")
                }
                val drawn = ContentStreamTokenizer.drawn(doc.pageContent(first + i))
                val want = ops.filterIsInstance<Op.Text>().map { WinAnsi.encode(WinAnsi.toWinAnsi(it.text)).toList() }
                if (drawn.strings != want) fail(null, "addendum page ${i + 1} does not draw its draw list")
            }
        }
    }
}
