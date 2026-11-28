package org.ssa.assistant.core.app

import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.forms.buildReport as formsBuildReport
import org.ssa.assistant.core.forms.kotlinValue
import org.ssa.assistant.core.forms.present as formsPresent
import org.ssa.assistant.core.forms.shortLabel as formsShortLabel
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.optionsFromSchema
import org.ssa.assistant.core.speakableValue

/**
 * Port of `src/summary.js`, the Review screen and the spoken read-back: the
 * report the summary is drawn from, the masking of sensitive numbers, and the
 * plain-text read-back.
 *
 * `buildReport`, `present` and `shortLabel` already live in `core`'s `forms`
 * package (the PDF worksheet and the addendum use them), so this object is the
 * rendering half the UI needs and the single place the app reaches the
 * summary through. The `LABELS` table is exported into `schema.json` as
 * `labels`, so [labels] is the same data the JS holds.
 */
object Summary {

    /** The `LABELS` table: explicit short names for the form rows (schema.json's `labels`). */
    fun labels(schema: Schema): Map<String, String> = schema.labels

    /** The ordered, presentable answer set: sections, field blocks and loop tables. */
    fun buildReport(
        schema: Schema,
        answers: Json.Obj,
        form: String? = null,
        lang: String = "en",
        i18n: I18n = I18n(schema),
    ): List<Json.Obj> = formsBuildReport(schema, answers, form, lang, i18n)

    /** A printable value for a stored answer. */
    fun present(
        value: Any?,
        type: String,
        options: List<org.ssa.assistant.core.Option>? = null,
        lang: String = "en",
        i18n: I18n? = null,
    ): String = formsPresent(value, type, options, lang, i18n)

    /** A compact label for a form row: the LABELS table first, then the prompt. */
    fun shortLabel(schema: Schema, prompt: String?, id: String?): String = formsShortLabel(schema, prompt, id)

    /** Is this question type one whose answers are withheld from a save? */
    fun isSensitive(schema: Schema, type: String?): Boolean =
        type != null && schema.sensitiveTypes.contains(type)

    /**
     * Hide every digit of each number but the last [keep], keeping the
     * separators so the shape still reads: "987-65-4321" becomes
     * "•••-••-4321", and a spoken "9 8 7, 6 5, 4 3 2 1" keeps its spacing. A
     * number of [keep] digits or fewer is hidden entirely.
     */
    fun maskDigits(text: String?, keep: Int = 4): String {
        val s = text ?: ""
        return Regex("\\d(?:[\\s,.-]*\\d)*").replace(s) { match ->
            val run = match.value
            val total = run.count { it.isDigit() }
            var hide = if (total > keep) total - keep else total
            buildString {
                for (c in run) {
                    if (c.isDigit()) {
                        append(if (hide > 0) '\u2022' else c)
                        hide -= 1
                    } else {
                        append(c)
                    }
                }
            }
        }
    }

    /**
     * The plain-text read-back, as `summaryText()` builds it: one line per
     * section heading, field or table row, joined with newlines.
     *
     * The read-back is **not** masked, exactly as the web's is: the user is
     * asking to hear their own answers. Review is the masked screen.
     */
    fun summaryText(
        schema: Schema,
        answers: Json.Obj,
        lang: String = "en",
        i18n: I18n = I18n(schema),
    ): String {
        val lines = mutableListOf<String>()
        for (section in buildReport(schema, answers, null, lang, i18n)) {
            lines.add((section["title"]?.asString() ?: "") + ".")
            for (block in section["blocks"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()) {
                if (block["kind"]?.asString() == "table") {
                    val label = block["label"]?.asString() ?: ""
                    if (block["empty"] == Json.True) {
                        lines.add(i18n.message("no_recorded", mapOf("label" to label), lang))
                        continue
                    }
                    val columns = block["columns"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()
                    val rows = block["rows"]?.asArray()?.items ?: emptyList()
                    rows.forEachIndexed { index, _ ->
                        val item = (answers[block["id"]?.asString()] as? Json.Arr)?.items?.getOrNull(index)?.asObject()
                            ?: Json.Obj()
                        val parts = columns.mapNotNull { column ->
                            val raw = item[column["id"]?.asString()]
                            if (raw == null || raw === Json.Null || (raw is Json.Str && raw.value.isEmpty())) {
                                null
                            } else {
                                val shown = speakableValue(
                                    kotlinValue(raw),
                                    column["type"]?.asString() ?: "text",
                                    optionsFromSchema(column["options"]),
                                    lang,
                                )
                                (column["label"]?.asString() ?: "") + ", " + shown
                            }
                        }
                        val caption = i18n.message(
                            "table_caption",
                            mapOf("label" to titleCase(label), "number" to index + 1),
                            lang,
                        )
                        lines.add(caption + ": " + parts.joinToString(". ") + ".")
                    }
                    continue
                }
                val value = block["value"]?.asString() ?: ""
                lines.add(
                    i18n.message(
                        "summary_row",
                        mapOf(
                            "label" to (block["label"]?.asString() ?: ""),
                            "value" to value.ifEmpty { i18n.message("not_answered", emptyMap(), lang) },
                        ),
                        lang,
                    )
                )
            }
        }
        return lines.joinToString("\n")
    }

    /** `String(s).replace(/^(.)/, c => c.toUpperCase())` from summary.js. */
    private fun titleCase(s: String): String = s.replaceFirstChar { it.uppercase() }
}
