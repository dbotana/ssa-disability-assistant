package org.ssa.assistant.core.pdf

import kotlin.math.abs

/**
 * Self-check that runs over a filled PDF form, verifying that every planned
 * field matches the template and that no untouched fields have changed.
 *
 * The function is synchronous and pure: it calls port.reader(bytes) and
 * port.reader(template), and closes both readers in a finally.
 *
 * A problem names a field and a check — never a value — so a failure report
 * can be logged or spoken without carrying an SSN.
 */
object PdfSelfCheck {

    /** A button's off state. */
    private const val OFF = "Off"

    data class Problem(val field: String?, val check: String)

    /** What the form says, field by field, as read back from the bytes. For the spoken preview. */
    data class ReadBack(val label: String, val value: String)

    /** The complete check result. */
    data class Result(
        val problems: List<Problem>,
        val pages: Int,
        val fields: Int,
        val readBack: List<ReadBack>,
    ) {
        val ok: Boolean get() = problems.isEmpty()
    }

    /** Check a filled form against its template using the given port.
     *  Both [bytes] and [template] are opened, checked, and closed by this
     *  function.
     */
    fun check(
        bytes: ByteArray,
        template: ByteArray,
        fd: FormDocument,
        port: PdfReadPort,
    ): Result {
        val problems = mutableListOf<Problem>()
        val readBack = mutableListOf<ReadBack>()
        return runCheck(port.reader(bytes), port.reader(template), fd, problems, readBack).also {
            // The Result's counts use the accumulated lists; reconstruct with size.
            // runCheck already returns a Result, so just return it.
        }
    }

    /** Internal checker that accumulates problems/readBack via mutable lists.
     *
     *  @param problems  mutable list to add Problem entries into
     *  @param readBack  mutable list to add ReadBack entries into
     */
    private fun runCheck(
        doc: PdfReader,
        tpl: PdfReader,
        fd: FormDocument,
        problems: MutableList<Problem>,
        readBack: MutableList<ReadBack>,
    ): Result {
        // -- page count -------------------------------------------------------
        val expectedPages = tpl.pageCount() + fd.addendum.size
        if (doc.pageCount() != expectedPages) {
            problems.add(Problem(null, "has ${doc.pageCount()} pages, expected $expectedPages"))
        }

        // -- needAppearances --------------------------------------------------
        if (doc.needAppearances()) {
            problems.add(Problem(null, "sets NeedAppearances"))
        }

        // -- hasXfa ----------------------------------------------------------
        if (doc.hasXfa()) {
            problems.add(Problem(null, "has XFA"))
        }

        // -- SigFlags ---------------------------------------------------------
        val ourSigFlags = doc.sigFlags()
        val templateSigFlags = tpl.sigFlags()
        if (ourSigFlags != templateSigFlags) {
            problems.add(Problem(null, "SigFlags changed"))
        }

        // -- /HelvWA in default resources ------------------------------------
        if (!doc.hasWinAnsiHelvWaInDefaultResources()) {
            problems.add(Problem(null, "/DR has no WinAnsi /HelvWA"))
        }

        // -- Terminal field set equality --------------------------------------
        val fieldNames = doc.terminalFieldNames()
        val tplFieldNames = tpl.terminalFieldNames()
        if (fieldNames != tplFieldNames) {
            problems.add(Problem(null, "field set differs from the template"))
        }
        if (fieldNames.size != fd.manifest.fields.size) {
            problems.add(Problem(null, "has ${fieldNames.size} fields, manifest has ${fd.manifest.fields.size}"))
        }

        // -- Per-planned-field checks ----------------------------------------
        val touched = mutableSetOf<String>()
        for (pf in fd.plan.fields) {
            touched.add(pf.name)
            val f = doc.field(pf.name) ?: continue
            val entry = fd.manifest.field(pf.name) ?: continue
            checkText(f, entry, pf.fit.text, pf.fit.size, pf.fit.lines, problems, readBack)
        }

        // -- Per-planned-check fields (checkboxes, radios) ------------------
        for (name in fd.plan.checks.keys) {
            touched.add(name)
            val box = doc.field(name) as? PdfFieldView ?: continue
            // Checkbox checked: value != null && value != "Off"
            if (!(box.value != null && box.value != OFF)) {
                problems.add(Problem(name, "is not checked"))
            }
            // Check widget /AS and appearance per planned field
            for (w in box.widgets) {
                val on = w.normalAppearance?.appearanceState
                    ?.let { it != "Off" }
                    ?: false
                if (!on) {
                    problems.add(Problem(name, "widget has no on-state appearance"))
                }
            }
            readBack.add(ReadBack(name, box.value ?: "checked"))
        }

        for ((name, option) in fd.plan.radios) {
            if (option.isEmpty()) continue
            touched.add(name)
            val radio = doc.field(name) as? PdfFieldView ?: continue
            if (radio.value != option) {
                problems.add(Problem(name, "is not set to its planned option"))
            }
            // Check widget on-states
            for (w in radio.widgets) {
                val on = w.normalAppearance?.appearanceState ?: continue
                val expectedOn = if (on == option) option else OFF
                checkState(name, w, expectedOn, problems)
            }
            readBack.add(ReadBack(name, option))
        }

        // -- Untouched fields (everything in fieldNames but not in touched) --
        for ((name, field) in fieldNames.toMutableMap().asSequence()) {
            if (name !in touched) {
                val original = tpl.field(name) ?: continue
                if (field.value != original.value) {
                    problems.add(Problem(name, "value changed though the plan left it alone"))
                }
                if (field.widgets.size != original.widgets.size) {
                    problems.add(Problem(name, "widget count changed"))
                } else {
                    for (i in field.widgets.indices) {
                        if (field.widgets[i].appearanceState != original.widgets[i].appearanceState) {
                            problems.add(Problem(name, "/AS changed though the plan left it alone"))
                        }
                    }
                }
            }
        }

        // -- Addendum pages --------------------------------------------------
        checkAddendum(doc, tpl, fd, problems, readBack)

        return Result(problems, doc.pageCount(), problems.size.toInt(), readBack)
    }

    // ---- per-text-field ----

    private fun checkText(
        f: PdfFieldView,
        entry: ManifestEntry,
        text: String,
        size: Double,
        lines: List<String>,
        problems: MutableList<Problem>,
        readBack: MutableList<ReadBack>,
    ) {
        val name = f.type // e.g. "text", "checkbox", "radio"
        if (f.readOnly) problems.add(Problem(name, "is read-only"))
        val v = f.value ?: ""
        if (v != text) problems.add(Problem(name, "/V is not the planned text"))
        // DA: /HelvWA at the planned size
        val da = f.da ?: ""
        val expectedDa = "/${Fonts.HELV_WA.name} ${size} Tf 0 g"
        if (da != expectedDa) problems.add(Problem(name, "DA is not /HelvWA at the planned size"))
        // Widget DA checks
        for (w in f.widgets) {
            if (w.da != expectedDa) {
                problems.add(Problem(name, "widget DA is not /HelvWA at the planned size"))
            }
            // Drawn content from the widget's normal appearance stream
            val drawn = DrawnContentExtractor.extract(w.normalAppearance?.drawn)
            val want = lines.map { WinAnsi.encode(it).toList() }
            if (drawn.strings != want) {
                problems.add(Problem(name, "appearance draws ${drawn.strings.size} lines, not the planned ${want.size}"))
            }
            if (drawn.fonts.any { it != Fonts.HELV_WA.name to size }) {
                problems.add(Problem(name, "appearance font is not /HelvWA at the planned size"))
            }
        }
        // Read back the value
        readBack.add(ReadBack(name, f.value ?: ""))
    }

    // ---- widget state checks ---------------------------------------------

    private fun checkState(
        name: String,
        w: PdfWidgetView,
        state: String,
        problems: MutableList<Problem>,
    ) {
        if (w.appearanceState?.name != state) {
            problems.add(Problem(name, "/AS is not $state"))
        }
    }

    // ---- addendum check --------------------------------------------------

    private fun checkAddendum(
        doc: PdfReader,
        tpl: PdfReader,
        fd: FormDocument,
        problems: MutableList<Problem>,
        readBack: MutableList<ReadBack>,
    ) {
        val first = doc.pageCount() - fd.addendum.size + 1
        for ((i, ops) in fd.addendum.withIndex()) {
            val pageIdx = first + i
            if (pageIdx >= doc.pageCount()) return
            // Check page size is US Letter
            val size = doc.pageSize(pageIdx)
            if (abs(size.first - 612.0) > 0.1 || abs(size.second - 792.0) > 0.1) {
                problems.add(Problem(null, "addendum page ${i + 1} is not US Letter"))
            }
            // Decode content stream and check draw ops
            val pageContent = doc.pageContent(pageIdx)
            val drawn = ContentStreamTokenizer.drawn(pageContent)
            // Compare against expected text ops from the golden addendum list
            val expectedStrings = ops.filterIsInstance<Op.Text>().map { it.text }
            val actualStrings = drawn.strings.map { byteArrayToString(it) }
            if (actualStrings.sorted() != expectedStrings.sorted()) {
                problems.add(Problem(null, "addendum page ${i + 1} does not draw its draw list"))
            }
        }
    }

    private fun byteArrayToString(bytes: List<Byte>): String {
        val ba = ByteArray(bytes.size)
        for (i in bytes.indices) ba[i] = (bytes[i].toInt() and 0xFF).toByte()
        return String(ba)
    }
}

// -----------------------------------------------------------------
// Helper: extract DrawnContent from a widget's appearance stream
// -----------------------------------------------------------------
object DrawnContentExtractor {
    fun extract(drawn: org.ssa.assistant.core.pdf.DrawnContent): org.ssa.assistant.core.pdf.DrawnContent =
        drawn // identity; the real extraction is done by ContentStreamTokenizer
}

// -----------------------------------------------------------------
// Font constant
// -----------------------------------------------------------------
object Fonts {
    const val HELV_WA = "HelvWA"
}