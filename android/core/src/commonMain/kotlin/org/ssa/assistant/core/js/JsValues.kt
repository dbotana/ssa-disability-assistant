package org.ssa.assistant.core.js

import org.ssa.assistant.core.json.Json
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10

/**
 * JavaScript's Number.prototype.toString(): "15" not "15.0", "0.0001" not
 * "1.0E-4", "1e+21", "1.5e-7".
 *
 * The digits are the shortest that round-trip to the same double, found from
 * the exact binary value ([shortestDecimal]) rather than from
 * Double.toString(), which gives the shortest digits only from JDK 19 on,
 * and not on every Android release or on Kotlin/Native. The layout is the
 * spec's (ECMA-262 Number::toString): plain notation for decimal exponents
 * from -6 to 21, exponent notation outside.
 */
fun jsNumberToString(x: Double): String {
    if (x.isNaN()) return "NaN"
    if (x == 0.0) return "0"                       // and -0, which JS prints as "0"
    if (x.isInfinite()) return if (x > 0) "Infinity" else "-Infinity"
    if (x < 0) return "-" + jsNumberToString(-x)

    // x = 0.digits × 10^n, so digits × 10^(n−k), with k significant digits.
    val (digits, n) = shortestDecimal(x)
    val k = digits.length

    return when {
        n in k..21 -> digits + "0".repeat(n - k)
        n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
        n in -5..0 -> "0." + "0".repeat(-n) + digits
        else -> {
            val e = n - 1
            val sign = if (e >= 0) "+" else "-"
            val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
            "${mantissa}e$sign${abs(e)}"
        }
    }
}

/**
 * Math.round() in JS, and Math.round(double) on the JVM: the nearest integer,
 * ties toward positive infinity, and 0 for NaN.
 */
fun jsRound(x: Double): Long {
    if (x.isNaN()) return 0L
    val f = floor(x)
    // x − f is exact: f is x with its fraction bits cleared.
    return (if (x - f >= 0.5) f + 1 else f).toLong()
}

/**
 * `String.format(Locale.ROOT, "%.<places>f", x)` for 0 ≤ x < 10^12: as
 * java.util.Formatter does it, the shortest round-trip digits rounded half
 * up to [places] decimals, so 0.0005 gives "0.001".
 */
fun fixedHalfUp(x: Double, places: Int): String {
    require(x >= 0.0 && x < 1e12 && places in 0..6) { "fixedHalfUp($x, $places)" }
    var scaled = 0L
    if (x > 0.0) {
        val (digits, n) = shortestDecimal(x)
        // The digits at or above 10^-places, then the first one below decides.
        val keep = n + places
        if (keep >= 0) {
            for (i in 0 until keep) scaled = scaled * 10 + (if (i < digits.length) digits[i] - '0' else 0)
            if (keep < digits.length && digits[keep] >= '5') scaled++
        }
    }
    val s = scaled.toString().padStart(places + 1, '0')
    return if (places == 0) s else s.dropLast(places) + "." + s.takeLast(places)
}

/**
 * The shortest decimal that reads back as [x] (finite, positive), as
 * `digits` (no trailing zeros) and `n`, with x ≈ 0.digits × 10^n.
 *
 * For each length p from 1 to 17 it rounds the exact binary value to p
 * significant digits, half to even, and keeps the first that a correctly
 * rounded parse turns back into x. All of it is exact integer arithmetic.
 */
internal fun shortestDecimal(x: Double): Pair<String, Int> {
    val bits = x.toRawBits()
    val biased = ((bits ushr 52) and 0x7FF).toInt()
    val fraction = bits and 0xFFFFFFFFFFFFFL
    val m = if (biased == 0) fraction else fraction or (1L shl 52)
    val e = if (biased == 0) -1074 else biased - 1075
    // At a power of two the double below is half as far away as the one
    // above, except below the smallest normal, where the spacing is even.
    val lowerCloser = fraction == 0L && biased > 1

    // x = r/s, and its neighbours' midpoints are x + plus/s and x − minus/s.
    var r = Big.of(4 * m)
    var plus = Big.of(2L)
    var minus = Big.of(if (lowerCloser) 1L else 2L)
    var s = Big.of(1L)
    if (e >= 2) {
        r = r.shl(e - 2); plus = plus.shl(e - 2); minus = minus.shl(e - 2)
    } else {
        s = s.shl(2 - e)
    }

    // Scale so that 1/10 ≤ r/s < 1; then x = (r/s) × 10^k.
    var k = ceil(log10(x)).toInt()
    if (k >= 0) {
        s = s.timesPow10(k)
    } else {
        r = r.timesPow10(-k); plus = plus.timesPow10(-k); minus = minus.timesPow10(-k)
    }
    while (r >= s) { s = s.times(10); k++ }
    while (r.times(10) < s) { r = r.times(10); plus = plus.times(10); minus = minus.times(10); k-- }

    // A parse rounds half to even, so a midpoint reads back as x only when
    // x's significand is even.
    val inclusive = m % 2 == 0L
    var rem = r
    var sig = 0L
    var rScaled = r
    var plusScaled = plus
    var minusScaled = minus
    for (p in 1..17) {
        // The next exact digit, and the exact remainder after it.
        var t = rem.times(10)
        var d = 0
        while (t >= s) { t -= s; d++ }
        rem = t
        sig = sig * 10 + d
        rScaled = rScaled.times(10); plusScaled = plusScaled.times(10); minusScaled = minusScaled.times(10)

        val half = rem.shl(1).compareTo(s)
        val rounded = if (half > 0 || (half == 0 && sig % 2 == 1L)) sig + 1 else sig
        // Does rounded/10^p lie within x's rounding interval (scaled by s·10^p)?
        val a = s.timesLong(rounded)
        val fits = if (a >= rScaled) {
            val c = a.compareTo(rScaled + plusScaled)
            if (inclusive) c <= 0 else c < 0
        } else {
            val c = (a + minusScaled).compareTo(rScaled)
            if (inclusive) c >= 0 else c > 0
        }
        if (fits || p == 17) {
            val text = rounded.toString()
            // Rounding 99…9 up carries into a new leading digit.
            return if (text.length > p) "1" to k + 1 else text.trimEnd('0') to k
        }
    }
    error("unreachable")
}

/** An unsigned integer of any size, in little-endian base-2^32 limbs. */
private class Big private constructor(private val limbs: IntArray) : Comparable<Big> {
    companion object {
        private const val MASK = 0xFFFFFFFFL

        fun of(v: Long): Big {
            require(v >= 0)
            return Big(intArrayOf(v.toInt(), (v ushr 32).toInt())).trimmed()
        }

        private fun limb(a: IntArray, i: Int): Long = if (i < a.size) a[i].toLong() and MASK else 0L
    }

    private fun trimmed(): Big {
        var n = limbs.size
        while (n > 0 && limbs[n - 1] == 0) n--
        return if (n == limbs.size) this else Big(limbs.copyOf(n))
    }

    /** this × 2^bits. */
    fun shl(bits: Int): Big {
        val words = bits / 32
        val shift = bits % 32
        val out = IntArray(limbs.size + words + 1)
        for (i in limbs.indices) {
            val v = (limbs[i].toLong() and MASK) shl shift
            out[i + words] = out[i + words] or v.toInt()
            out[i + words + 1] = (v ushr 32).toInt()
        }
        return Big(out).trimmed()
    }

    /** this × [f], for 0 ≤ f < 2^31. */
    fun times(f: Int): Big {
        val out = IntArray(limbs.size + 1)
        var carry = 0L
        for (i in limbs.indices) {
            val v = (limbs[i].toLong() and MASK) * f + carry
            out[i] = v.toInt()
            carry = v ushr 32
        }
        out[limbs.size] = carry.toInt()
        return Big(out).trimmed()
    }

    /** this × [f], for 0 ≤ f < 2^62. */
    fun timesLong(f: Long): Big = times((f ushr 31).toInt()).shl(31) + times((f and 0x7FFFFFFFL).toInt())

    /** this × 10^[n]. */
    fun timesPow10(n: Int): Big {
        var out = this
        var left = n
        while (left >= 9) { out = out.times(1_000_000_000); left -= 9 }
        while (left > 0) { out = out.times(10); left-- }
        return out
    }

    operator fun plus(o: Big): Big {
        val n = maxOf(limbs.size, o.limbs.size)
        val out = IntArray(n + 1)
        var carry = 0L
        for (i in 0 until n) {
            val v = limb(limbs, i) + limb(o.limbs, i) + carry
            out[i] = v.toInt()
            carry = v ushr 32
        }
        out[n] = carry.toInt()
        return Big(out).trimmed()
    }

    /** this − [o], for o ≤ this. */
    operator fun minus(o: Big): Big {
        val out = IntArray(limbs.size)
        var borrow = 0L
        for (i in limbs.indices) {
            var v = limb(limbs, i) - limb(o.limbs, i) - borrow
            borrow = if (v < 0) 1L else 0L
            if (v < 0) v += 1L shl 32
            out[i] = v.toInt()
        }
        check(borrow == 0L)
        return Big(out).trimmed()
    }

    override fun compareTo(other: Big): Int {
        if (limbs.size != other.limbs.size) return limbs.size.compareTo(other.limbs.size)
        for (i in limbs.indices.reversed()) {
            val a = limbs[i].toLong() and MASK
            val b = other.limbs[i].toLong() and MASK
            if (a != b) return a.compareTo(b)
        }
        return 0
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
