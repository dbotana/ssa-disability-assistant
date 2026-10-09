package org.ssa.assistant.core.pdf

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/**
 * Port of planFill() in src/plan.js: a mapping plus a template manifest
 * produce fit decisions, overflow, and the addendum content. No PDF library
 * here — the writer consumes the plan as data.
 */

/** One filled field: the trimmed value, its fit decision, and its label. */
data class PlannedField(val name: String, val value: String, val fit: Fit, val label: String)

/**
 * The plan a writer applies to a document. `missing` are names the mapping
 * used that the manifest lacks; `overflowText` are the answers cut short for
 * the addendum. `radios`, `checks`, `tables` and `sections` pass through from
 * the mapping — the form specs own their shape.
 */
data class FillPlan(
    val fields: List<PlannedField>,
    val missing: List<String>,
    val overflowText: List<Pair<String, String>>,
    val radios: Map<String, String>,
    val checks: List<String>,
    val tables: List<Json>,
    val sections: List<Json>,
)

/** The mapping a form spec's map(answers) returns. */
data class Mapping(
    val text: LinkedHashMap<String, String> = LinkedHashMap(),
    val labels: Map<String, String> = emptyMap(),
    val radios: Map<String, String> = emptyMap(),
    val checks: List<String> = emptyList(),
    val tables: List<Json> = emptyList(),
    val sections: List<Json> = emptyList(),
)

fun planFill(mapping: Mapping, manifest: TemplateManifest, metrics: Metrics): FillPlan {
    val fields = mutableListOf<PlannedField>()
    val missing = mutableListOf<String>()
    val overflowText = mutableListOf<Pair<String, String>>()

    // Insertion order drives the addendum order, as the JS object does.
    for ((name, raw) in mapping.text) {
        val entry = manifest.field(name)
        if (entry == null || entry.type != "text") {
            missing.add(name)
            continue
        }
        val value = raw.trim()
        if (value.isEmpty()) continue
        val fit = fitTextBox(entry.box, value, metrics)
        val label = mapping.labels[name] ?: name
        fields.add(PlannedField(name, value, fit, label))
        if (fit.cut) overflowText.add(label to value)
    }

    return FillPlan(
        fields = fields,
        missing = missing,
        overflowText = overflowText,
        radios = mapping.radios,
        checks = mapping.checks,
        tables = mapping.tables,
        sections = mapping.sections
    )
}
