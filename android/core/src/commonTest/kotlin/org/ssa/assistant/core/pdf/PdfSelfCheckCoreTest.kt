package org.ssa.assistant.core.pdf

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.golden.fixture
import org.ssa.assistant.core.js.jsNumberToString
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The core self-check over a scripted [PdfReadPort]: no PDF library, just the
 * port model. Proves the checks fire (a changed /V is named, a correct fill
 * passes) and that a problem names a field and a check — never a value.
 */
class PdfSelfCheckCoreTest {

    private val schema = SchemaLoader.load()
    private val today = CivilDate(2026, 9, 19)

    private fun plan(): FormDocument = FormDocuments.plan(schema, "ds", fixture("minimal"), today)

    // -- scripted port --------------------------------------------------------

    private class ScriptedReader(
        private val fields: Map<String, PdfFieldView>,
        private val pages: Int,
    ) : PdfReader {
        override fun hasAcroForm(): Boolean = true
        override fun pageCount(): Int = pages
        override fun pageSize(index: Int): Pair<Double, Double> = Page.W to Page.H
        override fun needAppearances(): Boolean = false
        override fun hasXfa(): Boolean = false
        override fun sigFlags(): Int? = 0
        override fun hasWinAnsiHelvWaInDefaultResources(): Boolean = true
        override fun terminalFieldNames(): Set<String> = fields.keys
        override fun field(name: String): PdfFieldView? = fields[name]
        override fun pageContent(index: Int): ByteArray = byteArrayOf()
        override fun close() {}
    }

    private class ScriptedPort(private val doc: PdfReader, private val tpl: PdfReader) : PdfReadPort {
        private var calls = 0
        override fun reader(bytes: ByteArray): PdfReader {
            calls++
            return if (calls == 1) doc else tpl
        }
    }

    // -- synthetic field views ------------------------------------------------

    private fun blankField() = PdfFieldView("text", null, false, null, emptyList())

    private fun filledField(pf: PlannedField, entry: ManifestEntry): PdfFieldView {
        val size = pf.fit.size
        val drawn = DrawnContent(
            pf.fit.lines.map { WinAnsi.encode(it).toList() },
            listOf("HelvWA" to size),
        )
        return PdfFieldView(
            type = "text",
            value = pf.fit.text,
            readOnly = false,
            da = "/HelvWA ${jsNumberToString(size)} Tf 0 g",
            widgets = listOf(
                PdfWidgetView(
                    da = null,
                    appearanceState = null,
                    normalAppearance = PdfAppearanceView(
                        isStream = true,
                        bbox = entry.width to entry.height,
                        hasWinAnsiHelvWa = true,
                        drawn = drawn,
                        onStates = emptyList(),
                    ),
                    normalAppearanceBytes = emptyList(),
                )
            ),
        )
    }

    private fun checkboxField() = PdfFieldView(
        type = "checkbox",
        value = "Yes",
        readOnly = false,
        da = null,
        widgets = listOf(
            PdfWidgetView(
                da = null,
                appearanceState = "Yes",
                normalAppearance = PdfAppearanceView(
                    isStream = false,
                    bbox = null,
                    hasWinAnsiHelvWa = true,
                    drawn = DrawnContent(emptyList(), emptyList()),
                    onStates = listOf("Yes"),
                ),
                normalAppearanceBytes = emptyList(),
            )
        ),
    )

    private fun radioField(option: String) = PdfFieldView(
        type = "radio",
        value = option,
        readOnly = false,
        da = null,
        widgets = listOf(
            PdfWidgetView(
                da = null,
                appearanceState = option,
                normalAppearance = PdfAppearanceView(
                    isStream = false,
                    bbox = null,
                    hasWinAnsiHelvWa = true,
                    drawn = DrawnContent(emptyList(), emptyList()),
                    onStates = listOf(option),
                ),
                normalAppearanceBytes = emptyList(),
            )
        ),
    )

    private fun docFields(fd: FormDocument, changed: Pair<String, String>? = null): Map<String, PdfFieldView> {
        val m = LinkedHashMap<String, PdfFieldView>()
        for (name in fd.manifest.fields.keys) m[name] = blankField()
        for (pf in fd.plan.fields) {
            val entry = fd.manifest.field(pf.name)!!
            m[pf.name] = filledField(pf, entry)
        }
        for (name in fd.plan.checks) m[name] = checkboxField()
        for ((name, option) in fd.plan.radios) m[name] = radioField(option)
        if (changed != null) {
            val (name, value) = changed
            val current = m[name] ?: error("no scripted field named $name")
            m[name] = current.copy(value = value)
        }
        return m
    }

    private fun tplFields(fd: FormDocument): Map<String, PdfFieldView> {
        val m = LinkedHashMap<String, PdfFieldView>()
        for (name in fd.manifest.fields.keys) m[name] = blankField()
        return m
    }

    // -- tests -----------------------------------------------------------------

    @Test
    fun aCorrectFillPasses() {
        val fd = plan()
        check(fd.plan.fields.isNotEmpty()) { "the minimal DS fixture plans no text fields" }
        val port = ScriptedPort(
            doc = ScriptedReader(docFields(fd), 1 + fd.addendum.size),
            tpl = ScriptedReader(tplFields(fd), 1),
        )
        val result = PdfSelfCheck.check(byteArrayOf(), byteArrayOf(), fd, port)
        assertTrue(result.ok, result.toString())
    }

    @Test
    fun aChangedValueIsCaughtByNameWithoutLeakingIt() {
        val fd = plan()
        val target = fd.plan.fields.first()
        val secret = "top secret replacement"
        val port = ScriptedPort(
            doc = ScriptedReader(docFields(fd, target.name to secret), 1 + fd.addendum.size),
            tpl = ScriptedReader(tplFields(fd), 1),
        )
        val result = PdfSelfCheck.check(byteArrayOf(), byteArrayOf(), fd, port)
        assertFalse(result.ok, "the changed value went unnoticed")
        assertTrue(result.problems.any { it.field == target.name }, "no problem names ${target.name}: $result")
        assertTrue(result.problems.none { it.check.contains(secret) }, "a problem leaked the value: $result")
    }

    @Test
    fun aChangedValueTypeOnAnUntouchedFieldIsCaught() {
        val fd = plan()
        val untouched = fd.manifest.fields.entries
            .first { (name, e) -> e.type == "text" && fd.plan.fields.none { it.name == name } }.key
        val doc = docFields(fd).toMutableMap()
        val tpl = tplFields(fd).toMutableMap()
        doc[untouched] = doc[untouched]!!.copy(value = null, rawValue = "s:x")
        tpl[untouched] = tpl[untouched]!!.copy(value = null, rawValue = "n:x")
        val port = ScriptedPort(
            doc = ScriptedReader(doc, 1 + fd.addendum.size),
            tpl = ScriptedReader(tpl, 1),
        )
        val result = PdfSelfCheck.check(byteArrayOf(), byteArrayOf(), fd, port)
        assertFalse(result.ok, "the changed /V COS type went unnoticed")
        assertTrue(
            result.problems.any { it.field == untouched && it.check == "value changed though the plan left it alone" },
            "no problem names $untouched: $result"
        )
    }
}
