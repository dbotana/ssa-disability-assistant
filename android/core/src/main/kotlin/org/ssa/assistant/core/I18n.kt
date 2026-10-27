package org.ssa.assistant.core

import java.text.Normalizer
import org.ssa.assistant.core.forms.enUsGrouped
import org.ssa.assistant.core.js.jsString
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.parse.choiceLabel
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * Port of src/i18n/: the language table, the two catalogues keyed by their
 * English source (D1) and the formatting that depends on a language.
 *
 * Everything comes from the exported `i18n` object in tools/schema.json, so
 * the web app and this port resolve the same four channels from the same
 * data. Translation is data on disk; there is no network path here either.
 */

/** The four independent channels, in the order the setup panel shows them. */
val CHANNELS = listOf("input", "output", "screen", "fill")

val LANGUAGE_ORDER = listOf("en", "fr", "ln")

/** One language per channel. Each value is normalized independently. */
data class LanguageSettings(
    val input: String = "en",
    val output: String = "en",
    val screen: String = "en",
    val fill: String = "en",
) {
    fun normalize(): LanguageSettings = LanguageSettings(
        input = valid(input),
        output = valid(output),
        screen = valid(screen),
        fill = valid(fill),
    )

    fun langFor(channel: String): String = when (channel) {
        "input" -> input
        "output" -> output
        "screen" -> screen
        "fill" -> fill
        else -> "en"
    }

    fun toJson(): Json.Obj = Json.Obj().also { o ->
        o["input"] = Json.Str(input)
        o["output"] = Json.Str(output)
        o["screen"] = Json.Str(screen)
        o["fill"] = Json.Str(fill)
    }

    companion object {
        private fun valid(value: String?) = if (value != null && LANGUAGE_ORDER.contains(value)) value else "en"

        fun fromJson(value: Json?): LanguageSettings {
            val obj = value?.asObject() ?: return LanguageSettings()
            return LanguageSettings(
                input = valid(obj["input"]?.asString()),
                output = valid(obj["output"]?.asString()),
                screen = valid(obj["screen"]?.asString()),
                fill = valid(obj["fill"]?.asString()),
            )
        }
    }
}

/**
 * Translation lookup and language-dependent formatting.
 *
 * `translate()` records a miss rather than throwing: a missing entry falls
 * back to its English source, exactly as the web app does, and
 * [missingKeys] lets the golden replay prove nothing was missed.
 */
class I18n(private val table: Json.Obj) {

    constructor(schema: Schema) : this(schema.i18n)

    private val languages: Json.Obj = table["languages"]?.asObject() ?: Json.Obj()
    private val messages: Json.Obj = table["messages"]?.asObject() ?: Json.Obj()
    private val strings: Json.Obj = table["strings"]?.asObject() ?: Json.Obj()
    private val lexicons: Json.Obj = table["lexicon"]?.asObject() ?: Json.Obj()
    private val misses = LinkedHashSet<String>()

    /** The language table's entry for [lang], falling back to English. */
    fun language(lang: String): Json.Obj =
        languages[lang]?.asObject() ?: languages["en"]?.asObject() ?: Json.Obj()

    /** The translation of an English source string, or the source itself. */
    fun translate(text: String?, lang: String = "en"): String {
        if (text.isNullOrEmpty()) return text ?: ""
        if (lang == "en") return text
        val hit = strings[lang]?.asObject()?.get(text)?.asString()
        if (!hit.isNullOrEmpty()) return hit
        misses.add("$lang:$text")
        return text
    }

    /**
     * Render a message template. Substitution is a single pass, so a value
     * that happens to contain `{something}` is never expanded again.
     */
    fun message(key: String, vars: Map<String, Any?> = emptyMap(), lang: String = "en"): String {
        val template = translate(messages[key]?.asString() ?: "", lang)
        return Regex("\\{(\\w+)\\}").replace(template) { m ->
            val value = vars[m.groupValues[1]]
            // JS renders a missing or null var as the empty string, not "null".
            jsString(value ?: "")
        }
    }

    /** English source strings that were asked for and had no translation. */
    fun missingKeys(): List<String> = misses.sorted()

    /** The recognition tables for a language. */
    fun lexicon(lang: String = "en"): Json.Obj =
        lexicons[lang]?.asObject() ?: lexicons["en"]?.asObject() ?: Json.Obj()

    /** Case-fold and strip diacritics for non-English matching; English is exact. */
    fun fold(text: String?, lang: String = "en"): String {
        val s = text ?: ""
        if (lang == "en") return s
        // NFD + \p{M}, as the reference does: "Février" -> "fevrier".
        return Normalizer.normalize(s, Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "")
            .lowercase()
    }

    /** Is the speech pack this language needs installed? */
    fun sttInstalled(lang: String = "en"): Boolean =
        language(lang)["stt"]?.asObject()?.get("installed")?.asBoolean() ?: true

    private fun months(lang: String): List<String> =
        language(lang)["months"]?.asArray()?.items?.mapNotNull { it.asString() }
            ?: EN_MONTHS

    /** A date the way the language writes it. English output is unchanged. */
    fun formatDate(iso: Any?, lang: String = "en"): String {
        val raw = iso?.toString() ?: ""
        val m = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$").find(raw) ?: return raw
        val month = m.groupValues[2].toInt()
        val day = m.groupValues[3].toInt()
        if (month !in 1..12) return raw
        if (lang == "en") return "${EN_MONTHS[month - 1]} $day, ${m.groupValues[1]}"
        return "$day ${months(lang)[month - 1]} ${m.groupValues[1]}"
    }

    /** "March 1979", "still ongoing". */
    fun formatMonthYear(value: Any?, lang: String = "en"): String {
        val s = value?.toString() ?: ""
        if (s.lowercase() == "present") return message("still_ongoing", emptyMap(), lang)
        val m = Regex("^(\\d{4})-(\\d{2})$").find(s) ?: return s
        val month = m.groupValues[2].toInt()
        if (month !in 1..12) return s
        if (lang == "en") return "${EN_MONTHS[month - 1]} ${m.groupValues[1]}"
        return "${months(lang)[month - 1]} ${m.groupValues[1]}"
    }

    /**
     * A money amount. English keeps the existing toLocaleString() shape;
     * French and Lingala group with ASCII spaces and put the symbol after the
     * number, and never use Locale.
     */
    fun formatMoney(value: Any?, lang: String = "en"): String {
        val n = when (value) {
            is Double -> value
            is Int -> value.toDouble()
            is Long -> value.toDouble()
            is Json.Num -> value.value
            else -> value?.toString()?.toDoubleOrNull()
        }
        if (n == null || !n.isFinite()) return value?.toString() ?: ""
        if (lang == "en") return enUsGrouped(n)
        val rounded = Math.round(n).toDouble()
        return "${enUsGrouped(rounded).replace(',', ' ')} $"
    }

    /**
     * A spoken estimate of time remaining, or null when there is nothing
     * honest to say. The buckets are the same in every language.
     */
    fun formatTimeRemaining(seconds: Int?, lang: String = "en"): String? {
        if (seconds == null || seconds < 0) return null
        if (seconds < 60) return message("time_less_minute", emptyMap(), lang)
        val minutes = seconds / 60.0
        if (minutes < 2.5) return message("time_two_minutes", emptyMap(), lang)
        if (minutes < 60) {
            val step = kotlin.math.max(5.0, Math.round(minutes / 5) * 5.0).toInt()
            return message("time_minutes", mapOf("count" to step), lang)
        }
        val halves = Math.round(minutes / 30) / 2.0
        if (halves <= 1) return message("time_hour", emptyMap(), lang)
        val whole = kotlin.math.floor(halves).toInt()
        if (halves % 1 == 0.0) return message("time_hours", mapOf("count" to whole), lang)
        return if (whole == 1) message("time_hour_half", emptyMap(), lang)
        else message("time_and_half_hours", mapOf("count" to whole), lang)
    }

    /**
     * A stored value rendered for a read-back or the summary. English is the
     * original a11y.js code; other languages translate the words but never
     * the digits.
     */
    fun speakable(
        value: Any?,
        type: String,
        options: List<Option>? = null,
        lang: String = "en",
    ): String {
        if (value == null || value == "") return translate("not answered", lang)
        return when (type) {
            "yesno" -> translate(if (value == true) "Yes" else "No", lang).lowercase()
            "choice" -> choiceLabel(options, value, lang, this).lowercase()
            "zip" -> spellDigits(value, listOf(5))
            "ssn" -> spellDigits(value, listOf(3, 2, 4))
            "routing" -> spellDigits(value, listOf(3, 3, 3))
            "account", "phone" -> spellDigits(value, listOf(3, 3))
            "date" -> formatDate(value, lang)
            "monthyear" -> formatMonthYear(value, lang)
            "money" -> if (lang == "en")
                "${enUsGrouped((value as? Json.Num)?.value ?: value.toString().toDoubleOrNull() ?: 0.0)} dollars"
            else formatMoney(value, lang)
            else -> jsString(value)
        }
    }

    companion object {
        val EN_MONTHS = listOf(
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        )

        /** The exported table, loaded once, for callers with no schema in hand. */
        val default: I18n by lazy { I18n(SchemaLoader.load()) }
    }
}
