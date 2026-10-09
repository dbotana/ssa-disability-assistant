package org.ssa.assistant.core.forms

import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsString
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.parse.choiceLabel
import org.ssa.assistant.core.schema.Node
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.flatten
import org.ssa.assistant.core.schema.optionsFromSchema
import org.ssa.assistant.core.schema.jsTruthy
import org.ssa.assistant.core.schema.nodeActive
import org.ssa.assistant.core.schema.sectionActive
import org.ssa.assistant.core.formatDate
import org.ssa.assistant.core.formatMonthYear

/**
 * Port of buildReport() / present() / shortLabel() in src/summary.js: the
 * ordered, presentable structure the HTML summary, the spoken read-back and
 * the PDF addendum build from. Only what the chosen forms actually asked is
 * included.
 */

/**
 * Normalize the raw answer set into an ordered, presentable structure.
 * Pass `form` to narrow it further to one form's questions, as the Starter
 * Kit's addendum does.
 */
fun buildReport(schema: Schema, answers: Json.Obj, form: String? = null): List<Json.Obj> {
    val report = mutableListOf<Json.Obj>()
    for (section in schema.sections) {
        if (!sectionActive(section, answers)) continue
        if (form != null && (section["id"]?.asString() == "forms" ||
                !((section["forms"]?.asArray()?.items?.mapNotNull { it.asString() } ?: schema.formIds)
                    .contains(form)))
        ) continue

        val blocks = mutableListOf<Json.Obj>()
        for (q in section["questions"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()) {
            val forms = q["forms"]?.asArray()?.items?.mapNotNull { it.asString() }
                ?: section["forms"]?.asArray()?.items?.mapNotNull { it.asString() }
            val node = Node(q, forms, section["id"]?.asString() ?: "", section["title"]?.asString() ?: "")
            if (!nodeActive(node, answers)) continue
            if (form != null && node.forms != null && !node.forms.contains(form)) continue

            if (node.type == "loop") {
                val loopItems = items(answers, node.id)
                blocks.add(Json.Obj().also { b ->
                    b["kind"] = Json.Str("table")
                    b["id"] = Json.Str(node.id ?: "")
                    b["label"] = Json.Str(node.itemLabel ?: "")
                    b["columns"] = Json.Arr((node.fields ?: emptyList()).mapTo(mutableListOf()) { f ->
                        Json.Obj().also { c ->
                            c["id"] = f["id"] ?: Json.Null
                            c["label"] = Json.Str(shortLabel(schema, f["prompt"]?.asString(), f["id"]?.asString()))
                            c["type"] = f["type"] ?: Json.Null
                            // JS sets options: undefined, which JSON drops.
                            (f["options"] as? Json.Arr)?.let { c["options"] = it }
                        }
                    })
                    b["rows"] = Json.Arr(loopItems.mapTo(mutableListOf()) { item ->
                        Json.Arr((node.fields ?: emptyList()).mapTo(mutableListOf()) { f ->
                            val raw = item.asObject()?.get(f["id"]?.asString())
                            Json.Str(present(raw?.let { kotlinValue(it) }, f["type"]?.asString() ?: "text", optionsFromSchema(f["options"])))
                        })
                    })
                    b["empty"] = Json.bool(loopItems.isEmpty())
                })
                continue
            }

            val value = kotlinValue(answers[node.id])
            val type = node.type ?: "text"
            blocks.add(Json.Obj().also { b ->
                b["kind"] = Json.Str("field")
                b["id"] = Json.Str(node.id ?: "")
                b["label"] = Json.Str(shortLabel(schema, node.prompt, node.id))
                b["type"] = Json.Str(type)
                // JS sets options: undefined, which JSON drops.
                (node.raw["options"] as? Json.Arr)?.let { b["options"] = it }
                b["value"] = Json.Str(present(value, type, optionsFromSchema(node.raw["options"])))
                b["answered"] = Json.bool(value != null && value != "")
            })
        }

        if (blocks.isNotEmpty()) {
            report.add(Json.Obj().also { s ->
                s["id"] = section["id"] ?: Json.Null
                s["title"] = section["title"] ?: Json.Null
                s["blocks"] = Json.Arr(blocks.mapTo(mutableListOf()) { it })
            })
        }
    }
    return report
}

/** A JSON value as the Kotlin value the mappings read: string, number, boolean. */
internal fun kotlinValue(j: Json?): Any? = when (j) {
    null, Json.Null -> null
    Json.True -> true
    Json.False -> false
    is Json.Str -> j.value
    is Json.Num -> j.value
    else -> null
}

/** Printable rendering of a stored value. `options` is for choice answers. */
fun present(value: Any?, type: String, options: List<org.ssa.assistant.core.Option>? = null): String {
    if (value == null || value == "") return ""
    return when (type) {
        "yesno" -> if (value == true) "Yes" else "No"
        "choice" -> choiceLabel(options, value)
        "zip" -> {
            val digits = value.toString().replace(js("\\D"), "")
            if (digits.length == 9) "${digits.substring(0, 5)}-${digits.substring(5)}" else digits.ifEmpty { jsString(value) }
        }
        "money" -> "$" + enUsGrouped(
            (value as? Double) ?: (value as? Int)?.toDouble() ?: value.toString().toDoubleOrNull() ?: Double.NaN
        )
        "ssn" -> groupDigits(value, listOf(3, 2, 4), "-")
        "phone" -> groupDigits(value, listOf(3, 3, 4), "-")
        "routing", "account" -> value.toString().replace(js("\\D"), "")
        "date" -> formatDate(value)
        "monthyear" -> if (value.toString().lowercase() == "present") "Present" else formatMonthYear(value)
        else -> jsString(value)
    }
}

private fun groupDigits(value: Any?, groups: List<Int>, sep: String): String {
    val digits = value.toString().replace(js("\\D"), "")
    val total = groups.reduce { a, b -> a + b }
    if (digits.length != total) return digits.ifEmpty { jsString(value) }
    val out = mutableListOf<String>()
    var i = 0
    for (n in groups) {
        out.add(digits.substring(i, i + n))
        i += n
    }
    return out.joinToString(sep)
}

/**
 * Turn a spoken question into a compact label for a form row. The exported
 * LABELS table first; then the mechanical prefix-stripping of summary.js.
 */
fun shortLabel(schema: Schema, prompt: String?, id: String?): String {
    if (id != null && schema.labels.containsKey(id)) return schema.labels[id]!!
    val s = (prompt ?: "")
        .replaceFirst(js("^(What is|What was|What|Who|Where|When|Which|Do you have|Do you|Did you|Have you|Are you|Is this|Can you give me|Can you provide)\\s+", true), "")
        .replaceFirst(js("\\?.*$"), "")
        .replaceFirst(js("^the\\s+", true), "")
        .replaceFirst(js("^your\\s+", true), "")
        .replaceFirst(js("\\s+You can say.*$", true), "")
    // .replace(/^(.)/, c => c.toUpperCase()): JS `.` is not a line terminator.
    val first = js("^(.)").find(s)
    return jsTrim(if (first == null) s else s.replaceRange(first.range, first.value.uppercase()))
}
