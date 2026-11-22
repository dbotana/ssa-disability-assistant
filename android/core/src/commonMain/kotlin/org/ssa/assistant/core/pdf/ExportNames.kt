package org.ssa.assistant.core.pdf

import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.schema.Schema

/**
 * Port of src/export-name.js (Step 2 item 8): export file names, with the
 * version suffix of plan 4.7. Pinned by the `exportnames` golden.
 *
 *   ssa-starter-kit-<name>-<date>.pdf            one version, as today
 *   ssa-starter-kit-<name>-<date>-lingala.pdf    version A in a Lingala session
 *   ssa-starter-kit-<name>-<date>-english.pdf    version B, the translation
 */
object ExportNames {
    /** The suffix for each version; null is the single version every English session gets. */
    val VERSION_SUFFIXES = mapOf("lingala" to "-lingala", "english" to "-english")

    /** slug() in JS: every run of characters outside [a-zA-Z0-9] becomes one '-', none at the ends. */
    fun slug(s: String?): String {
        val b = StringBuilder()
        var dash = false
        for (c in (s ?: "").trim()) {
            if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9') {
                if (dash && b.isNotEmpty()) b.append('-')
                dash = false
                b.append(c)
            } else dash = true
        }
        // A trailing run is dropped, as JS's /-$/ removes it.
        return b.toString()
    }

    fun exportFileName(schema: Schema, formId: String, answers: Json.Obj, date: CivilDate, version: String? = null): String {
        val prefix = schema.formSpecs[formId]?.filePrefix ?: throw IllegalArgumentException("Unknown form: $formId")
        if (version != null && version !in VERSION_SUFFIXES) throw IllegalArgumentException("Unknown version: $version")
        val name = listOf("first_name", "last_name")
            .mapNotNull { (answers[it] as? Json.Str)?.value?.takeIf { v -> v.isNotEmpty() } }
            .joinToString(" ")
        val who = slug(name)
        val stamp = "${date.year}-${date.month.toString().padStart(2, '0')}-${date.day.toString().padStart(2, '0')}"
        return "$prefix${if (who.isNotEmpty()) "-$who" else ""}-$stamp${version?.let { VERSION_SUFFIXES.getValue(it) } ?: ""}.pdf"
    }
}
