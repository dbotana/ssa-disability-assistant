package org.ssa.assistant.core.forms

import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asString

/**
 * Formatting shared by the form mappings. Port of src/forms/common.js.
 *
 * Answers are stored in the shapes the engine validates (ISO dates, bare
 * digits, booleans). A paper form wants them the way a person writes them:
 * 03/14/1979, 555-123-4567, Yes.
 */

/** "1979-03-14" -> "03/14/1979". Anything else passes through. */
fun mdy(value: Any?): String {
    val m = js("^(\\d{4})-(\\d{2})-(\\d{2})$").find(value?.toString() ?: "")
        ?: return text(value)
    return "${m.groupValues[2]}/${m.groupValues[3]}/${m.groupValues[1]}"
}

/** "2023-05" -> "05/2023", "present" -> "Present". */
fun my(value: Any?): String {
    val s = value?.toString() ?: ""
    if (s.lowercase() == "present") return "Present"
    val m = js("^(\\d{4})-(\\d{2})$").find(s) ?: return text(value)
    return "${m.groupValues[2]}/${m.groupValues[1]}"
}

/** Month/year or full date, whichever the value is. */
fun anyDate(value: Any?): String =
    if (js("^\\d{4}-\\d{2}-\\d{2}$").test(value?.toString() ?: "")) mdy(value) else my(value)

fun yesNo(value: Any?): String = when (value) {
    true -> "Yes"
    false -> "No"
    else -> ""
}

fun phone(value: Any?): String {
    val d = (value?.toString() ?: "").replace(js("\\D"), "")
    return if (d.length == 10) "${d.substring(0, 3)}-${d.substring(3, 6)}-${d.substring(6)}" else text(value)
}

fun ssn(value: Any?): String {
    val d = (value?.toString() ?: "").replace(js("\\D"), "")
    return if (d.length == 9) "${d.substring(0, 3)}-${d.substring(3, 5)}-${d.substring(5)}" else text(value)
}

fun zip(value: Any?): String {
    val d = (value?.toString() ?: "").replace(js("\\D"), "")
    return if (d.length == 9) "${d.substring(0, 5)}-${d.substring(5)}" else text(value)
}

/** A stored value as a trimmed string, with null and undefined as ''.
 *  Numbers print as JS String(n) does: "8", never "8.0". */
fun text(value: Any?): String {
    if (value == null) return ""
    if (value is Double || value is Float || value is Int || value is Long || value is Short || value is Byte ||
        value is Boolean
    ) {
        return org.ssa.assistant.core.js.jsString(value)
    }
    return value.toString().trim()
}

/** Join the non-empty parts. */
fun join(parts: List<Any?>, sep: String = ", "): String =
    parts.map { text(it) }.filter { it.isNotEmpty() }.joinToString(sep)

/** The items of a loop answer, never null. */
fun items(answers: Json.Obj?, loopId: String?): List<Json> =
    (answers?.get(loopId) as? Json.Arr)?.items ?: emptyList()

/** "$1,200" — JS Number.toLocaleString() in its default (en-US) form. */
fun money(value: Any?): String {
    if (value == null || value == "") return ""
    val n = (value as? Json.Num)?.value
        ?: value.toString().toDoubleOrNull()
        ?: return text(value)
    if (!n.isFinite()) return text(value)
    return "$${enUsGrouped(n)}"
}

/**
 * Number.toLocaleString('en-US') for the values this app stores: whole dollar
 * amounts, printed with thousands separators and no decimals ("1200" ->
 * "1,200"). Fractions would be grouped the same way with up to three
 * fraction digits; none of the mappings produce one.
 */
fun enUsGrouped(n: Double): String {
    if (n.isNaN()) return "NaN"
    if (n == Double.POSITIVE_INFINITY) return "∞"
    if (n == Double.NEGATIVE_INFINITY) return "-∞"
    val negative = n < 0 || (n == 0.0 && 1.0 / n < 0)
    val whole = kotlin.math.floor(kotlin.math.abs(n)).toLong().toString()
    val grouped = StringBuilder()
    whole.forEachIndexed { i, c ->
        if (i > 0 && (whole.length - i) % 3 == 0) grouped.append(',')
        grouped.append(c)
    }
    val frac = kotlin.math.abs(n) - kotlin.math.floor(kotlin.math.abs(n))
    var fraction = ""
    if (frac > 0.0) {
        // JS prints up to three fraction digits, trailing zeros trimmed.
        val raw = String.format(java.util.Locale.ROOT, "%.3f", frac).substring(2)
        fraction = "." + raw.trimEnd('0')
    }
    return (if (negative) "-" else "") + grouped + fraction
}
