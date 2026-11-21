package org.ssa.assistant.core.parse

import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.Option
import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsEscape
import org.ssa.assistant.core.js.jsLower
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asString

/**
 * Port of src/choice.js: multiple-choice answers, the one place that turns
 * what someone said into one of the question's option values.
 *
 * Matching is all-or-nothing, exactly as in the JS: one option named clearly,
 * or null. A negation never matches, "never married" is not also "married",
 * and a lone letter counts only when it is the whole answer. Patterns are the
 * reference's, in JS syntax, through [js].
 *
 * Non-English matching folds case and strips diacritics (D5), and adds the
 * translated label to the names an option answers to. Values, letters and
 * English labels always keep working, so a mixed-channel setup is safe.
 */

// "Never" is deliberately absent: "never married" is an answer, not a negation.
private val NEGATION = js("\\b(not|no|nor|neither|without|cannot|(?:do|does|did|is|was|are|were|ca|wo|could|would|should)n'?t)\\b")
private val LEAD = js("^(um|uh|er|well|so|okay|ok|i think|i would say|i'd say|probably|maybe|it is|it's|its|that is|that's|thats|i guess)\\b[\\s,]*")

private val LETTER_WORDS = mapOf(
    "a" to "a", "ay" to "a", "b" to "b", "bee" to "b", "be" to "b", "c" to "c",
    "see" to "c", "sea" to "c", "d" to "d", "dee" to "d", "e" to "e", "ee" to "e",
    "f" to "f", "ef" to "f", "m" to "m", "em" to "m"
)

private fun normalize(s: String?, lang: String = "en", i18n: I18n = I18n.default): String {
    if (lang != "en") {
        // Lingala's open vowels are what users write on a phone keyboard too
        // ("fomele" for "fɔmɛlɛ"), so fold them before the strip that would
        // otherwise turn ɛ/ɔ into spaces.
        val folded = when (lang) {
            "ln" -> i18n.fold(s, lang).replace("\u025B", "e").replace("\u0254", "o")
            else -> i18n.fold(s, lang)
        }
        return jsTrim(folded
            .replace(js("[\u2019']"), " ")
            .replace(js("[^a-z0-9\\s-]"), " ")
            .replace("-", " ")
            .replace(js("\\s+"), " "))
    }
    return jsTrim(jsLower(s ?: "")
        .replace(js("[\u2019']"), "'")
        .replace(js("[^a-z0-9'\\s-]"), " ")
        .replace("-", " ")
        .replace(js("\\s+"), " "))
}

private fun tableStrings(tables: org.ssa.assistant.core.json.Json.Obj, key: String): List<String> =
    (tables[key]?.asArray()?.items ?: emptyList()).mapNotNull { it.asString() }

/**
 * The option a free-form answer names, or null. Ported 1:1 from
 * matchChoice() in src/choice.js — the same rule order, so the goldens agree.
 */
fun matchChoice(
    options: List<Option>?,
    text: String?,
    lang: String = "en",
    i18n: I18n? = null,
): Option? {
    if (options.isNullOrEmpty()) return null
    val table = i18n ?: I18n.default
    val tables = table.lexicon(lang)
    val lead: Regex? = if (lang == "en") LEAD
    else tableStrings(tables, "lead").firstOrNull()?.let { source ->
        try { js(source) } catch (_: Exception) { null }
    }
    val negation: Regex = if (lang == "en") NEGATION
    else {
        val sources = tableStrings(tables, "negation")
        if (sources.isNotEmpty()) {
            try { js(sources.joinToString("|")) } catch (_: Exception) { NEGATION }
        } else NEGATION
    }

    var s = normalize(text, lang, table)
    for (i in 0 until 3) {
        val next = lead?.let { jsTrim(s.replaceFirst(it, "")) } ?: s
        if (next == s) break
        s = next
    }
    if (s.isEmpty()) return null

    // Exact value, letter, English label, or translated label.
    for (o in options) {
        val names = listOf(o.value, o.label, table.translate(o.label, lang))
        if (names.any { s == normalize(it, lang, table) }) return o
    }

    // A lone letter, optionally introduced: "b", "letter b", "the letter bee".
    val letter = js("^(?:the )?(?:letter |option )?([a-z]{1,3})$").find(s)
    if (letter != null) {
        val name = letter.groupValues[1]
        val letterValue = LETTER_WORDS[name]
        if (letterValue != null) {
            val hits = options.filter { o -> o.letter != null && jsLower(o.letter) == letterValue }
            if (hits.size == 1) return hits[0]
        }
    }

    if (negation.test(s)) return null

    // Phrase search: every alias found in the answer, dropping any match
    // sitting inside a longer one.
    data class Found(val option: Option, val start: Int, val end: Int)

    val found = mutableListOf<Found>()
    for (o in options) {
        for (phrase in listOf(o.label, table.translate(o.label, lang)) + o.aliases) {
            val p = normalize(phrase, lang, table)
            if (p.isEmpty()) continue
            val re = js("(?:^|\\s)${jsEscape(p)}(?:$|\\s)")
            re.findAll(s).forEach { m ->
                val start = m.range.first + (if (m.value.startsWith(" ")) 1 else 0)
                found.add(Found(o, start, start + p.length))
            }
        }
    }
    val kept = found.filter { f ->
        !found.any { g -> g !== f && g.start <= f.start && g.end >= f.end && (g.end - g.start) > (f.end - f.start) }
    }

    var values = kept.map { it.option.value }.distinct().toMutableList()

    for (o in options) {
        val implied = o.impliedBy ?: continue
        if (implied.all { v -> values.contains(v) }) {
            values = values.filter { v -> !implied.contains(v) }.toMutableList()
            if (!values.contains(o.value)) values.add(o.value)
        }
    }

    if (values.size != 1) return null
    return options.firstOrNull { o -> o.value == values[0] }
}

fun optionFor(options: List<Option>?, value: Any?): Option? {
    if (options == null) return null
    return options.firstOrNull { o -> o.value == value?.toString() }
}

/** Printable label for a stored choice value; the raw value if unknown. */
fun choiceLabel(
    options: List<Option>?,
    value: Any?,
    lang: String = "en",
    i18n: I18n? = null,
): String {
    if (value == null || value == "") return ""
    val option = optionFor(options, value) ?: return value.toString()
    return (i18n ?: I18n.default).translate(option.label, lang)
}

/** "independent, needs supervision, or total care" — for spoken hints. */
fun optionsSentence(options: List<Option>?, lang: String = "en", i18n: I18n? = null): String {
    val table = i18n ?: I18n.default
    val labels = (options ?: emptyList()).map { table.translate(it.label, lang).lowercase() }
    val connector = table.lexicon(lang)["connector"]?.asString() ?: "or"
    if (labels.size <= 2) return labels.joinToString(" $connector ")
    return "${labels.dropLast(1).joinToString(", ")}, $connector ${labels.last()}"
}
