package org.ssa.assistant.core.js

import org.ssa.assistant.core.json.Json
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode

/**
 * JavaScript's Number.prototype.toString(): "15" not "15.0", "0.0001" not
 * "1.0E-4", "1e+21", "1.5e-7".
 *
 * The digits are the shortest that round-trip to the same double, found from
 * the exact binary value rather than from Double.toString(), which gives
 * the shortest digits only from JDK 19 on, and not on every Android
 * release. The layout is the spec's (ECMA-262 Number::toString): plain
 * notation for decimal exponents from -6 to 21, exponent notation outside.
 */
fun jsNumberToString(x: Double): String {
    if (x.isNaN()) return "NaN"
    if (x == 0.0) return "0"                       // and -0, which JS prints as "0"
    if (x.isInfinite()) return if (x > 0) "Infinity" else "-Infinity"
    if (x < 0) return "-" + jsNumberToString(-x)

    val exact = BigDecimal(x)
    var shortest: BigDecimal? = null
    for (precision in 1..17) {
        val r = exact.round(MathContext(precision, RoundingMode.HALF_EVEN))
        if (r.toDouble() == x) { shortest = r; break }
    }
    val r = shortest ?: exact.round(MathContext(17, RoundingMode.HALF_EVEN))

    // r = s × 10^(n−k), with s the k significant digits.
    val unscaled = r.unscaledValue().toString()
    val digits = unscaled.trimEnd('0')
    val k = digits.length
    val n = k + (unscaled.length - digits.length) - r.scale()

    return when {
        n in k..21 -> digits + "0".repeat(n - k)
        n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
        n in -5..0 -> "0." + "0".repeat(-n) + digits
        else -> {
            val e = n - 1
            val sign = if (e >= 0) "+" else "-"
            val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
            "${mantissa}e$sign${Math.abs(e)}"
        }
    }
}

/** A number as JSON.stringify writes it: NaN and the infinities become null. */
fun jsJsonNumber(x: Double): String = if (x.isFinite()) jsNumberToString(x) else "null"

/**
 * String(value) for the values that reach normalize() and the read-backs:
 * strings as they are, numbers as JS prints them, booleans and null as words.
 */
fun jsString(value: Any?): String = when (value) {
    null -> "null"
    is String -> value
    is Double -> jsNumberToString(value)
    is Float -> jsNumberToString(value.toDouble())
    is Int, is Long, is Short, is Byte -> value.toString()
    is Boolean -> value.toString()
    is Json.Str -> value.value
    is Json.Num -> jsNumberToString(value.value)
    Json.True -> "true"
    Json.False -> "false"
    Json.Null -> "null"
    else -> value.toString()
}
