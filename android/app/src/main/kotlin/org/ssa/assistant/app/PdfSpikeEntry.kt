package org.ssa.assistant.app

import android.content.Context
import java.time.LocalDate
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.pdf.FormFiller
import org.ssa.assistant.pdf.TemplateLoader

/**
 * M1a's R8 probe. Fills both forms with synthetic fixture answers and reports
 * only pass/fail strings and field names — never a real answer value. Kept by
 * staging-rules.pro, so the staging instrumentation exercises the minified
 * PDF path; the release build does not reference it and R8 removes it.
 */
object PdfSpikeEntry {
    private val TODAY: LocalDate = LocalDate.of(2026, 9, 19)

    fun run(context: Context): String {
        val answers = Json.Obj().also {
            it["forms"] = Json.Str("ssa")
            it["first_name"] = Json.Str("Test")
            it["last_name"] = Json.Str("Applicant")
            // One condition so the Starter Kit actually fills a text field:
            // its fields are table cells only, so name-only answers would
            // produce an empty ssa plan and a hollow probe.
            it["conditions"] = Json.Arr(mutableListOf(
                Json.Obj().also { c -> c["name"] = Json.Str("Test condition") }
            ))
        }
        val schema = SchemaLoader.load()
        val filler = FormFiller(TemplateLoader(context))
        val parts = mutableListOf<String>()
        for (formId in listOf("ssa", "ds")) {
            try {
                val fd = FormDocuments.plan(schema, formId, answers, TODAY)
                val filled = filler.fill(fd)
                if (!filled.check.ok) return "failed $formId: ${filled.check}"
                if (filled.bytes.size > 2 * filled.templateSize) return "failed $formId: over 2x the template"
                parts += "$formId=${filled.bytes.size}/${filled.templateSize}B ${filled.timings.totalMs}ms"
            } catch (e: Throwable) {
                return "failed $formId: ${e.javaClass.simpleName}"
            }
        }
        return "ok " + parts.joinToString(" ")
    }
}
