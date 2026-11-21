package org.ssa.assistant.core.js

/**
 * Code points, as JS's for..of and String.prototype.codePointAt() see them,
 * with the surrogate pairs handled explicitly: common Kotlin has no
 * codePointAt or appendCodePoint. A lone surrogate is its own code point,
 * as it is in JS and in java.lang.Character.
 */

/** The code point starting at [index]. */
fun String.codePointAtJs(index: Int): Int {
    val high = this[index]
    if (high.isHighSurrogate() && index + 1 < length) {
        val low = this[index + 1]
        if (low.isLowSurrogate()) return 0x10000 + ((high.code - 0xD800) shl 10) + (low.code - 0xDC00)
    }
    return high.code
}

/** How many UTF-16 units [cp] takes. */
fun charCountOf(cp: Int): Int = if (cp >= 0x10000) 2 else 1

/** [cp] as a String of one or two UTF-16 units. */
fun stringOfCodePoint(cp: Int): String = StringBuilder().appendCodePointJs(cp).toString()

/** Appends [cp] as one or two UTF-16 units. */
fun StringBuilder.appendCodePointJs(cp: Int): StringBuilder {
    if (cp < 0x10000) return append(cp.toChar())
    val v = cp - 0x10000
    append((0xD800 + (v shr 10)).toChar())
    append((0xDC00 + (v and 0x3FF)).toChar())
    return this
}

/** Each code point of this string, in order. */
fun String.codePointList(): List<Int> {
    val out = ArrayList<Int>(length)
    var i = 0
    while (i < length) {
        val cp = codePointAtJs(i)
        out.add(cp)
        i += charCountOf(cp)
    }
    return out
}
