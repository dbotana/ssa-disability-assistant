package org.ssa.assistant.core

import org.ssa.assistant.core.js.js

/**
 * Port of src/a11y.js's pure helpers: spoken read-backs and time estimates.
 * The DOM parts (announce, focus) have no Android equivalent here.
 */

private val MONTHS = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
)

/** Spoken-friendly digit read-back: "5 5 5, 1 2, 3 4 5 6". */
fun spellDigits(value: Any?, groups: List<Int>? = null): String {
    val digits = (value?.toString() ?: "").replace(js("\\D"), "")
    if (digits.isEmpty()) return ""
    val chunks = mutableListOf<String>()
    if (groups != null) {
        var rest = digits
        for (n in groups) {
            chunks.add(rest.substring(0, n))
            rest = rest.substring(n)
        }
        if (rest.isNotEmpty()) chunks.add(rest)
    } else {
        chunks.add(digits)
    }
    return chunks.filter { it.isNotEmpty() }.joinToString(", ") { c -> c.toList().joinToString(" ") }
}

/** Human-readable rendering of a stored value, for read-back and the summary. */
fun speakableValue(value: Any?, type: String, options: List<Option>? = null): String {
    if (value == null || value == "") return "not answered"
    return when (type) {
        "yesno" -> if (value == true) "yes" else "no"
        "choice" -> org.ssa.assistant.core.parse.choiceLabel(options, value).lowercase()
        "zip" -> spellDigits(value, listOf(5))
        "ssn" -> spellDigits(value, listOf(3, 2, 4))
        "routing" -> spellDigits(value, listOf(3, 3, 3))
        "account", "phone" -> spellDigits(value, listOf(3, 3))
        "date" -> formatDate(value)
        "monthyear" -> formatMonthYear(value)
        "money" -> "${org.ssa.assistant.core.forms.enUsGrouped(value.toString().toDoubleOrNull() ?: 0.0)} dollars"
        else -> org.ssa.assistant.core.js.jsString(value)
    }
}

fun formatDate(iso: Any?): String {
    val m = js("^(\\d{4})-(\\d{2})-(\\d{2})$").find(iso?.toString() ?: "")
        ?: return iso?.toString() ?: ""
    val month = m.groupValues[2].toInt()
    val day = m.groupValues[3].toInt()
    if (month !in 1..12) return iso.toString()
    return "${MONTHS[month - 1]} $day, ${m.groupValues[1]}"
}

fun formatMonthYear(value: Any?): String {
    val s = value?.toString() ?: ""
    if (s.lowercase() == "present") return "still ongoing"
    val m = js("^(\\d{4})-(\\d{2})$").find(s) ?: return s
    val month = m.groupValues[2].toInt()
    if (month !in 1..12) return s
    return "${MONTHS[month - 1]} ${m.groupValues[1]}"
}

/**
 * A spoken estimate of time remaining, or null when there is nothing honest
 * to say. Bucketed hard on purpose — five-minute steps under an hour,
 * half-hours above.
 */
fun formatTimeRemaining(seconds: Int?): String? {
    if (seconds == null || seconds < 0) return null
    if (seconds < 60) return "less than a minute"
    val minutes = seconds / 60.0
    if (minutes < 2.5) return "about two minutes"
    if (minutes < 60) {
        val step = kotlin.math.max(5.0, Math.round(minutes / 5) * 5.0).toInt()
        return "about $step minutes"
    }
    val halves = Math.round(minutes / 30) / 2.0
    if (halves <= 1) return "about an hour"
    val whole = kotlin.math.floor(halves).toInt()
    if (halves % 1 == 0.0) return "about $whole hours"
    return if (whole == 1) "about an hour and a half" else "about $whole and a half hours"
}
