package org.ssa.assistant.core.pdf

import java.text.Normalizer
import java.time.LocalDate
import org.ssa.assistant.core.forms.buildReport
import org.ssa.assistant.core.forms.mapDsIntake
import org.ssa.assistant.core.forms.mapSsaStarterKit
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.FormSpecInfo
import org.ssa.assistant.core.schema.Schema

/**
 * Measures over the WinAnsi form of the text, as every caller in the
 * reference does (fontMetrics() in pdf.js): Helvetica can only draw WinAnsi,
 * so that is what gets measured.
 */
class WinAnsiMetrics(private val font: HelveticaMetrics) : Metrics {
    override fun widthOfTextAtSize(text: String, size: Double): Double =
        font.widthOfTextAtSize(WinAnsi.toWinAnsi(text), size)

    override fun heightAtSize(size: Double): Double = font.heightAtSize(size)

    companion object {
        val REGULAR: WinAnsiMetrics by lazy { WinAnsiMetrics(HelveticaMetrics.HELVETICA) }
        val BOLD: WinAnsiMetrics by lazy { WinAnsiMetrics(HelveticaMetrics.HELVETICA_BOLD) }
    }
}

/**
 * Everything one filled form needs, as data. The writer in :pdf only applies
 * it: the template, the plan for its fields, and the addendum pages (empty
 * when nothing overflowed and the form has no tables or sections to add).
 */
class FormDocument(
    val formId: String,
    val spec: FormSpecInfo,
    val manifest: TemplateManifest,
    val plan: FillPlan,
    val addendum: List<List<Op>>,
)

/** The fallback worksheet, as data: its title, subject and pages. */
class WorksheetDocument(val title: String, val subject: String, val creator: String, val pages: List<List<Op>>)

object FormDocuments {
    const val CREATOR = "Voice Assistant for Disability Forms"

    fun mapping(schema: Schema, formId: String, answers: Json.Obj, today: LocalDate): Mapping = when (formId) {
        "ssa" -> mapSsaStarterKit(schema, answers)
        "ds" -> mapDsIntake(schema, answers, today)
        else -> throw IllegalArgumentException("unknown form $formId")
    }

    /**
     * fillTemplate()'s planning half, in fill.js's order: every text value
     * goes through toWinAnsi before it is planned (so one name typed with a
     * character Helvetica lacks cannot fail the form), then the plan, then the
     * addendum when there is anything to put on one.
     */
    fun plan(schema: Schema, formId: String, answers: Json.Obj, today: LocalDate): FormDocument {
        val spec = schema.formSpecs[formId] ?: throw IllegalArgumentException("schema.json has no formSpecs.$formId")
        val raw = mapping(schema, formId, answers, today)
        val text = LinkedHashMap<String, String>()
        raw.text.forEach { (k, v) -> text[k] = WinAnsi.toWinAnsi(v) }
        val manifest = TemplateManifest.forForm(formId)
        val plan = planFill(raw.copy(text = text), manifest, WinAnsiMetrics.REGULAR)

        val addendum = if (plan.overflowText.isNotEmpty() || plan.tables.isNotEmpty() || plan.sections.isNotEmpty()) {
            AddendumLayout.layout(addendumContent(spec, plan), WinAnsiMetrics.REGULAR, WinAnsiMetrics.BOLD)
        } else {
            emptyList()
        }
        return FormDocument(formId, spec, manifest, plan, addendum)
    }

    /** The content fill.js hands layoutAddendum: the spec's wording plus the plan's overflow. */
    fun addendumContent(spec: FormSpecInfo, plan: FillPlan): AddendumLayout.Content =
        AddendumLayout.Content.fromJson(Json.Obj().also { o ->
            o["title"] = spec.addendum["title"] ?: Json.Null
            o["intro"] = spec.addendum["intro"] ?: Json.Arr()
            o["overflowText"] = Json.Arr(plan.overflowText.mapTo(mutableListOf()) { (label, value) ->
                Json.Obj().also { e -> e["label"] = Json.Str(label); e["value"] = Json.Str(value) }
            })
            o["tables"] = Json.Arr(plan.tables.toMutableList())
            o["sections"] = Json.Arr(plan.sections.toMutableList())
            o["footer"] = spec.addendum["footer"] ?: Json.Arr()
        })

    /**
     * buildWorksheet() in pdf.js: every answer on plain pages, for when a
     * form cannot be produced. "Prepared" is written M/D/YYYY, as en-US
     * toLocaleDateString() writes it.
     */
    fun worksheet(schema: Schema, answers: Json.Obj, today: LocalDate): WorksheetDocument {
        val w = schema.worksheet
        val heading = w["heading"]?.asString() ?: "Disability Forms Worksheet"
        fun list(key: String): Json = w[key]?.asArray() ?: Json.Arr()
        val content = AddendumLayout.Content.fromJson(Json.Obj().also { o ->
            o["title"] = Json.Str(heading)
            o["intro"] = list("intro")
            o["prepared"] = Json.Str("Prepared ${today.monthValue}/${today.dayOfMonth}/${today.year}")
            o["sections"] = Json.Arr(buildReport(schema, answers).toMutableList<Json>())
            o["footer"] = list("footer")
        })
        return WorksheetDocument(
            title = heading,
            subject = w["subject"]?.asString() ?: "",
            creator = w["creator"]?.asString() ?: CREATOR,
            pages = AddendumLayout.layout(content, WinAnsiMetrics.REGULAR, WinAnsiMetrics.BOLD)
        )
    }

    /**
     * downloadForm()'s filename: `<prefix>-<name>-<YYYY-MM-DD>.pdf`. Unlike the
     * web's slug, accents fold to their base letter first, so "José" names a
     * file "jose" rather than "Jos".
     */
    fun filename(spec: FormSpecInfo, answers: Json.Obj, today: LocalDate): String {
        val name = listOf("first_name", "last_name")
            .mapNotNull { (answers[it] as? Json.Str)?.value?.takeIf(String::isNotEmpty) }
            .joinToString(" ")
        val folded = Normalizer.normalize(name, Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")
        val who = folded.trim().replace(Regex("[^A-Za-z0-9]+"), "-").replace(Regex("^-|-$"), "")
        val stamp = "%04d-%02d-%02d".format(java.util.Locale.ROOT, today.year, today.monthValue, today.dayOfMonth)
        return "${spec.filePrefix}${if (who.isNotEmpty()) "-$who" else ""}-$stamp.pdf"
    }
}
