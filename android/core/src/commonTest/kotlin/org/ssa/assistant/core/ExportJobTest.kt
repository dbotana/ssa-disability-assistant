package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.ssa.assistant.core.app.ExportJob
import org.ssa.assistant.core.app.PdfFillService
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.runTestBlocking
import org.ssa.assistant.core.js.jsNumberToString
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.pdf.DrawnContent
import org.ssa.assistant.core.pdf.ExportNames
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.FormVersions
import org.ssa.assistant.core.pdf.ManifestEntry
import org.ssa.assistant.core.pdf.Op
import org.ssa.assistant.core.pdf.Page
import org.ssa.assistant.core.pdf.PdfAppearanceView
import org.ssa.assistant.core.pdf.PdfFieldView
import org.ssa.assistant.core.pdf.PdfReadPort
import org.ssa.assistant.core.pdf.PdfReader
import org.ssa.assistant.core.pdf.PdfWidgetView
import org.ssa.assistant.core.pdf.TemplateManifest
import org.ssa.assistant.core.pdf.WinAnsi
import org.ssa.assistant.core.pdf.WriterJson
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * Plan A4: ExportJob plans every version, fills it through a callback
 * [PdfFillService], self-checks the bytes through [PdfReadPort], and names the
 * file. Both are fakes here; the real ones are Swift (SsaPdf).
 */
class ExportJobTest {
    private val schema = SchemaLoader.load()
    private val i18n = I18n(schema)
    private val today = CivilDate(2026, 9, 19)

    private val template = byteArrayOf(9, 9, 9)
    private val filled = byteArrayOf(1, 2, 3)

    // -- fake reader ---------------------------------------------------------

    /** Answers as if the writer had produced exactly the plan it was given. */
    private class Port(val template: ByteArray, val filled: ByteArray) : PdfReadPort {
        var current: FormDocument? = null
        var sabotage: String? = null

        override fun reader(bytes: ByteArray): PdfReader {
            val document = current!!
            return if (bytes.contentEquals(template)) TemplateReader(document.manifest)
            else DocReader(document, sabotage)
        }
    }

    private class TemplateReader(private val manifest: TemplateManifest) : PdfReader {
        override fun hasAcroForm() = true
        override fun pageCount() = 1
        override fun pageSize(index: Int): Pair<Double, Double> = Page.W to Page.H
        override fun needAppearances() = false
        override fun hasXfa() = false
        override fun sigFlags(): Int? = null
        override fun hasWinAnsiHelvWaInDefaultResources() = false
        override fun terminalFieldNames(): Set<String> = manifest.fields.keys
        override fun field(name: String): PdfFieldView? =
            manifest.field(name)?.let { untouched(it) }
        override fun pageContent(index: Int): ByteArray = ByteArray(0)
        override fun close() {}
    }

    private class DocReader(private val document: FormDocument, private val sabotage: String?) : PdfReader {
        private val plan = document.plan
        override fun hasAcroForm() = sabotage != "has no AcroForm"
        override fun pageCount() = 1 + document.addendum.size
        override fun pageSize(index: Int): Pair<Double, Double> = Page.W to Page.H
        override fun needAppearances() = false
        override fun hasXfa() = false
        override fun sigFlags(): Int? = null
        override fun hasWinAnsiHelvWaInDefaultResources() = false
        override fun terminalFieldNames(): Set<String> = document.manifest.fields.keys

        override fun field(name: String): PdfFieldView? {
            plan.fields.firstOrNull { it.name == name }?.let { pf ->
                val entry = document.manifest.field(name) ?: return null
                return plannedText(pf.fit.text, pf.fit.size, pf.fit.lines, entry)
            }
            if (name in plan.checks) {
                val entry = document.manifest.field(name) ?: return null
                return plannedCheckbox(entry)
            }
            plan.radios[name]?.takeIf { it.isNotEmpty() }?.let { option -> return plannedRadio(option) }
            return document.manifest.field(name)?.let { untouched(it) }
        }

        override fun pageContent(index: Int): ByteArray {
            val ops = document.addendum.getOrNull(index - 1) ?: return ByteArray(0)
            // Built as bytes, not as a String: the charset constants are
            // JVM-only, and this file is commonTest.
            val out = mutableListOf<Byte>()
            fun ascii(text: String) { for (c in text) out.add(c.code.toByte()) }
            for (op in ops) {
                if (op !is Op.Text) continue
                val bytes = WinAnsi.encode(WinAnsi.toWinAnsi(op.text))
                ascii("<")
                for (b in bytes) ascii(hexByte(b.toInt() and 0xFF))
                ascii("> Tj\n")
            }
            return out.toByteArray()
        }

        override fun close() {}
    }

    /** Fills by finding the version whose plan JSON the job just wrote. */
    private class ScriptedFill(
        private val port: Port,
        private val versions: List<FormVersions.Version>,
        private val fail: Boolean = false,
        private val filled: ByteArray,
    ) : PdfFillService {
        val titles = mutableListOf<String>()
        val creators = mutableListOf<String>()

        override fun fill(
            template: ByteArray,
            planJson: String,
            drawListJson: String?,
            title: String,
            creator: String,
            done: (ByteArray?, String?) -> Unit,
        ) {
            if (fail) {
                done(null, "the writer failed")
                return
            }
            val version = versions.firstOrNull { WriterJson.plan(it.plan).writeJson() == planJson }
            if (version == null) {
                done(null, "no version matches the plan")
                return
            }
            port.current = version.document
            titles.add(title)
            creators.add(creator)
            done(filled.copyOf(), null)
        }
    }

    // -- tests ---------------------------------------------------------------

    @Test
    fun everyGoldenVersionIsFilledSelfCheckedAndNamed() = runTestBlocking {
        val cases = Golden.load("fillplans").asObject()!!["versions"]!!.asArray()!!.items.map { it.asObject()!! }
        var files = 0
        for (v in cases) {
            val form = v["form"]!!.asString()!!
            val answers = v["answers"]!!.asObject()!!
            val overlay = FormVersions.Overlay.fromJson(v["overlay"])
            val versions = FormVersions.plan(schema, form, answers, overlay, today, "en", i18n)
            val ordered = listOfNotNull(versions.a, versions.b)
            val both = versions.b != null

            val port = Port(template, filled)
            val fill = ScriptedFill(port, ordered, filled = filled)
            val outcome = ExportJob(schema, today, i18n, { template }, fill, port)
                .export(listOf(form), answers, overlay)

            assertEquals(emptyList(), outcome.failed, "$form ${v["fixture"]!!.asString()}")
            assertEquals(ordered.size, outcome.ready.size)
            for ((i, version) in ordered.withIndex()) {
                val suffix = if (both) (if (i == 0) "lingala" else "english") else null
                assertEquals(
                    ExportNames.exportFileName(schema, form, version.answers, today, suffix),
                    outcome.ready[i].fileName,
                )
                assertEquals(
                    schema.formSpecs.getValue(form).title, fill.titles[i],
                    "the form's own title, as the web sets it",
                )
                assertEquals(ExportJob.FORM_CREATOR, fill.creators[i])
                assertTrue(
                    outcome.ready[i].selfCheck.problems.all { it.check in ExportJob.KNOWN_CONVENTION_CHECKS },
                    "unexpected self-check problems: ${outcome.ready[i].selfCheck}",
                )
                assertTrue(
                    outcome.ready[i].selfCheck.problems.any { it.check == "/DR has no WinAnsi /HelvWA" },
                    "the fake reader reports the known /HelvWA convention problem",
                )
                assertTrue(outcome.ready[i].bytes.contentEquals(filled))
                files++
            }
        }
        assertTrue(files >= 6, "only $files files exported")
    }

    @Test
    fun aProblemOutsideTheKnownSetFailsThatFile() = runTestBlocking {
        val answers = Golden.load("fillplans").asObject()!!["versions"]!!.asArray()!!.items
            .map { it.asObject()!! }.first { it["fixture"]!!.asString() == "both-english" && it["form"]!!.asString() == "ssa" }["answers"]!!.asObject()!!
        val versions = FormVersions.plan(schema, "ssa", answers, FormVersions.Overlay(), today, "en", i18n)
        val port = Port(template, filled).also { it.sabotage = "has no AcroForm" }
        val outcome = ExportJob(schema, today, i18n, { template }, ScriptedFill(port, listOf(versions.a), filled = filled), port)
            .export(listOf("ssa"), answers)
        assertTrue(outcome.ready.isEmpty())
        assertEquals("has no AcroForm", outcome.failed.single().check)
        assertEquals("ssa", outcome.failed.single().formId)
    }

    @Test
    fun aFillErrorFailsThatForm() = runTestBlocking {
        val answers = Golden.load("fillplans").asObject()!!["versions"]!!.asArray()!!.items
            .map { it.asObject()!! }.first { it["form"]!!.asString() == "ssa" }["answers"]!!.asObject()!!
        val versions = FormVersions.plan(schema, "ssa", answers, FormVersions.Overlay(), today, "en", i18n)
        val port = Port(template, filled)
        val outcome = ExportJob(schema, today, i18n, { template }, ScriptedFill(port, listOf(versions.a), fail = true, filled = filled), port)
            .export(listOf("ssa"), answers)
        assertTrue(outcome.ready.isEmpty())
        assertEquals("could not be written", outcome.failed.single().check)
    }

    @Test
    fun anUnknownFormAndAMissingTemplateFailWithoutStoppingTheOther() = runTestBlocking {
        val answers = Golden.load("fillplans").asObject()!!["versions"]!!.asArray()!!.items
            .map { it.asObject()!! }.first { it["fixture"]!!.asString() == "both-english" }["answers"]!!.asObject()!!
        val ssa = FormVersions.plan(schema, "ssa", answers, FormVersions.Overlay(), today, "en", i18n)
        val port = Port(template, filled)
        val job = ExportJob(
            schema, today, i18n,
            templateFor = { id -> if (id == "ds") throw IllegalStateException("no template") else template },
            fill = ScriptedFill(port, listOf(ssa.a), filled = filled),
            read = port,
        )
        val outcome = job.export(listOf("nope", "ds", "ssa"), answers)
        assertEquals(listOf("unknown form", "template unavailable"), outcome.failed.map { it.check })
        assertEquals(1, outcome.ready.size, "ssa still exported")
    }
}

// -- the fake reader's field views (file level, so the nested readers see them) ----

private fun hexByte(value: Int): String {
    val digits = "0123456789abcdef"
    return "${digits[(value shr 4) and 0xF]}${digits[value and 0xF]}"
}

private fun emptyWidget() = PdfWidgetView(
    da = null, appearanceState = null, normalAppearance = null, normalAppearanceBytes = emptyList(),
)

private fun untouched(entry: ManifestEntry): PdfFieldView {
    val type = when (entry.type) {
        "text", "checkbox", "radio", "signature" -> entry.type
        else -> "other"
    }
    return PdfFieldView(type = type, value = null, readOnly = false, da = null, widgets = listOf(emptyWidget()), rawValue = null)
}

private fun plannedText(text: String, size: Double, lines: List<String>, entry: ManifestEntry): PdfFieldView {
    val da = "/HelvWA ${jsNumberToString(size)} Tf 0 g"
    val appearance = PdfAppearanceView(
        isStream = true,
        bbox = entry.width to entry.height,
        hasWinAnsiHelvWa = true,
        drawn = DrawnContent(
            strings = lines.map { WinAnsi.encode(it).toList() },
            fonts = listOf("HelvWA" to size),
        ),
        onStates = emptyList(),
    )
    return PdfFieldView(
        type = "text", value = text, readOnly = false, da = da,
        widgets = listOf(PdfWidgetView(da = null, appearanceState = null, normalAppearance = appearance, normalAppearanceBytes = emptyList())),
        rawValue = "s:$text",
    )
}

private fun plannedCheckbox(entry: ManifestEntry): PdfFieldView {
    val on = entry.onStates?.firstOrNull { it != null && it != "Off" } ?: "Yes"
    val appearance = PdfAppearanceView(false, null, false, DrawnContent(emptyList(), emptyList()), listOf(on))
    return PdfFieldView(
        type = "checkbox", value = on, readOnly = false, da = null,
        widgets = listOf(PdfWidgetView(da = null, appearanceState = on, normalAppearance = appearance, normalAppearanceBytes = emptyList())),
        rawValue = "n:$on",
    )
}

private fun plannedRadio(option: String): PdfFieldView {
    val appearance = PdfAppearanceView(false, null, false, DrawnContent(emptyList(), emptyList()), listOf(option))
    return PdfFieldView(
        type = "radio", value = option, readOnly = false, da = null,
        widgets = listOf(PdfWidgetView(da = null, appearanceState = option, normalAppearance = appearance, normalAppearanceBytes = emptyList())),
        rawValue = "n:$option",
    )
}
