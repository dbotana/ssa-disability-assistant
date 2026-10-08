package org.ssa.assistant.core.parse

import org.ssa.assistant.core.Option
import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsEscape
import org.ssa.assistant.core.js.jsLower
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test

/**
 * Port of src/choice.js: multiple-choice answers, the one place that turns
 * what someone said into one of the question's option values.
 *
 * Matching is all-or-nothing, exactly as in the JS: one option named clearly,
 * or null. A negation never matches, "never married" is not also "married",
 * and a lone letter counts only when it is the whole answer. Patterns are the
 * reference's, in JS syntax, through [js].
 */

// "Never" is deliberately absent: "never married" is an answer, not a negation.
private val NEGATION = js("\\b(not|no|nor|neither|without|cannot|(?:do|does|did|is|was|are|were|ca|wo|could|would|should)n'?t)\\b")
private val LEAD = js("^(um|uh|er|well|so|okay|ok|i think|i would say|i'd say|probably|maybe|it is|it's|its|that is|that's|thats|i guess)\\b[\\s,]*")

private val LETTER_WORDS = mapOf(
    "a" to "a", "ay" to "a", "b" to "b", "bee" to "b", "be" to "b", "c" to "c",
    "see" to "c", "sea" to "c", "d" to "d", "dee" to "d", "e" to "e", "ee" to "e",
    "f" to "f", "ef" to "f", "m" to "m", "em" to "m"
)

private fun normalize(s: String?): String = jsTrim(jsLower(s ?: "")
    .replace(js("[\u2019']"), "'")
    .replace(js("[^a-z0-9'\\s-]"), " ")
    .replace("-", " ")
    .replace(js("\\s+"), " "))

/**
 * The option a free-form answer names, or null. Ported 1:1 from
 * matchChoice() in src/choice.js — the same rule order, so the goldens agree.
 */
fun matchChoice(options: List<Option>?, text: String?): Option? {
    if (options.isNullOrEmpty()) return null
    var s = normalize(text)
    for (i in 0 until 3) {
        val next = jsTrim(s.replaceFirst(LEAD, ""))
        if (next == s) break
        s = next
    }
    if (s.isEmpty()) return null

    // Exact value or label: "both", "B", "Needs supervision".
    for (o in options) {
        if (s == normalize(o.value) || s == normalize(o.label)) return o
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

    if (NEGATION.test(s)) return null

    // Phrase search: every alias found in the answer, dropping any match
    // sitting inside a longer one.
    data class Found(val option: Option, val start: Int, val end: Int)

    val found = mutableListOf<Found>()
    for (o in options) {
        for (phrase in listOf(o.label) + o.aliases) {
            val p = normalize(phrase)
            if (p.isEmpty()) continue
            val re = js("\\b${jsEscape(p)}\\b")
            re.findAll(s).forEach { m -> found.add(Found(o, m.range.first, m.range.last + 1)) }
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

fun choiceLabel(options: List<Option>?, value: Any?): String {
    if (value == null || value == "") return ""
    return optionFor(options, value)?.label ?: value.toString()
}

/** "independent, needs supervision, or total care" — for spoken hints. */
fun optionsSentence(options: List<Option>?): String {
    val labels = (options ?: emptyList()).map { it.label.lowercase() }
    if (labels.size <= 2) return labels.joinToString(" or ")
    return "${labels.dropLast(1).joinToString(", ")}, or ${labels.last()}"
}
