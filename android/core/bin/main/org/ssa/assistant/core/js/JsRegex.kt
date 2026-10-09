package org.ssa.assistant.core.js

/**
 * JavaScript regular expressions, run the same way on the desktop JVM and on
 * Android.
 *
 * The port's patterns are written in JS syntax, copied from the reference,
 * and translated here into explicit classes. Neither platform's defaults can
 * be trusted to agree with JS:
 *
 *  - JS `\s` is Unicode whitespace. Java's is ASCII; ICU's is Unicode but a
 *    different set (it includes U+0085, which JS does not).
 *  - JS `\w`, `\d` and `\b` are ASCII (no `u` flag anywhere in the reference).
 *    The JVM's are ASCII too, but Android's java.util.regex is ICU, where all
 *    three are Unicode: "١٢٣" is `\d` there and not in JS.
 *  - JS `/i` (without `u`) folds ASCII letters to ASCII only. ICU may fold
 *    U+212A KELVIN SIGN to "k". Letters are expanded to `[kK]` instead, so no
 *    case-insensitive flag is ever handed to the platform.
 *  - JS `.` stops at \n \r U+2028 U+2029; Java's also stops at U+0085.
 *  - JS `$` (no `m` flag) is the end of input. Java's `$` also matches before
 *    a final line terminator, so "abc\n" would match `^abc$`.
 *
 * Supported: everything the reference uses — escapes, classes (with the
 * shorthand escapes inside them), groups `(?:` `(?=` `(?!` `(?<=` `(?<!`,
 * quantifiers, alternation, anchors. Anything else (inline flags, named
 * groups, letter ranges under `/i`) throws, so an unsupported pattern fails
 * the build's tests rather than matching differently.
 */
object JsRegex {
    /** JS `\s`, and the set String.prototype.trim() removes. */
    const val WS = "\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private const val WORD = "A-Za-z0-9_"
    private const val DIGIT = "0-9"
    private const val LINE_TERMINATORS = "\\n\\r\\u2028\\u2029"

    private const val BOUNDARY =
        "(?:(?<=[$WORD])(?![$WORD])|(?<![$WORD])(?=[$WORD]))"
    private const val NOT_BOUNDARY =
        "(?:(?<=[$WORD])(?=[$WORD])|(?<![$WORD])(?![$WORD]))"

    // Bounded: some patterns are built from answers (a provider's name in
    // Correct), and those should not accumulate for the whole session.
    private const val CACHE_SIZE = 512
    private val cache = object : LinkedHashMap<Pair<String, Boolean>, Regex>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Pair<String, Boolean>, Regex>?) = size > CACHE_SIZE
    }

    /** The Regex for a JS pattern, compiled once while it stays in use. */
    fun of(pattern: String, ignoreCase: Boolean = false): Regex =
        synchronized(cache) { cache.getOrPut(pattern to ignoreCase) { Regex(translate(pattern, ignoreCase)) } }

    /** The platform pattern that matches exactly what the JS pattern does. */
    fun translate(pattern: String, ignoreCase: Boolean = false): String {
        val out = StringBuilder()
        var i = 0
        var inClass = false
        var classStart = false
        fun fail(msg: String): Nothing = throw IllegalArgumentException("JsRegex: $msg in /$pattern/")
        fun isLetter(c: Char) = c in 'a'..'z' || c in 'A'..'Z'

        while (i < pattern.length) {
            val c = pattern[i]
            if (c == '\\') {
                if (i + 1 >= pattern.length) fail("trailing backslash")
                val e = pattern[i + 1]
                // \uXXXX and \xXX pass through whole: their hex letters are not
                // letters to case-fold.
                val hex = when (e) { 'u' -> 4; 'x' -> 2; else -> 0 }
                if (hex > 0) {
                    val digits = pattern.substring(i + 2, minOf(pattern.length, i + 2 + hex))
                    if (digits.length != hex || !digits.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) {
                        fail("bad \\$e escape")
                    }
                    out.append('\\').append(e).append(digits)
                    classStart = false
                    i += 2 + hex
                    continue
                }
                if (inClass) {
                    when (e) {
                        's' -> out.append(WS)
                        'd' -> out.append(DIGIT)
                        'w' -> out.append(WORD)
                        // The uppercase forms appear only as complement unions
                        // ([\s\S] = any character): a class and its complement
                        // cover everything under every dialect's boundary, so
                        // Java's ASCII negation is exact here too.
                        'S' -> out.append("\\S")
                        'D' -> out.append("\\D")
                        'W' -> out.append("\\W")
                        'b', 'B' -> fail("\\$e inside a class")
                        else -> out.append('\\').append(e)
                    }
                } else {
                    when (e) {
                        's' -> out.append("[$WS]")
                        'S' -> out.append("[^$WS]")
                        'd' -> out.append("[$DIGIT]")
                        'D' -> out.append("[^$DIGIT]")
                        'w' -> out.append("[$WORD]")
                        'W' -> out.append("[^$WORD]")
                        'b' -> out.append(BOUNDARY)
                        'B' -> out.append(NOT_BOUNDARY)
                        else -> out.append('\\').append(e)
                    }
                }
                classStart = false
                i += 2
                continue
            }

            if (inClass) {
                when {
                    c == ']' && !classStart -> { inClass = false; out.append(']') }
                    ignoreCase && isLetter(c) -> {
                        if (pattern.getOrNull(i + 1) == '-' && pattern.getOrNull(i + 2)?.let(::isLetter) == true) {
                            fail("a letter range under /i")
                        }
                        out.append(c.lowercaseChar()).append(c.uppercaseChar())
                    }
                    else -> out.append(c)
                }
                classStart = false
                i++
                continue
            }

            when {
                c == '[' -> {
                    inClass = true
                    classStart = true
                    out.append('[')
                    if (pattern.getOrNull(i + 1) == '^') { out.append('^'); i++ }
                }
                c == '.' -> out.append("[^$LINE_TERMINATORS]")
                c == '$' -> out.append("\\z")
                c == '(' && pattern.getOrNull(i + 1) == '?' -> {
                    val rest = pattern.substring(i + 2)
                    val head = listOf(":", "=", "!", "<=", "<!").firstOrNull { rest.startsWith(it) }
                        ?: fail("unsupported group (?${rest.take(2)}")
                    out.append("(?").append(head)
                    i += 2 + head.length
                    continue
                }
                ignoreCase && isLetter(c) -> out.append('[').append(c.lowercaseChar()).append(c.uppercaseChar()).append(']')
                else -> out.append(c)
            }
            i++
        }
        if (inClass) fail("unterminated class")
        return out.toString()
    }
}

/** A JS regex literal: `js("^\\s+")` is `/^\s+/`, `js("x", true)` is `/x/i`. */
fun js(pattern: String, ignoreCase: Boolean = false): Regex = JsRegex.of(pattern, ignoreCase)

/** RegExp.prototype.test. */
fun Regex.test(s: CharSequence): Boolean = containsMatchIn(s)

/** String.prototype.trim(): JS whitespace and line terminators only. */
fun jsTrim(s: String): String = s.replace(js("^\\s+|\\s+$"), "")

/** String.prototype.toLowerCase(): locale-independent, as Kotlin's lowercase() is. */
fun jsLower(s: String): String = s.lowercase()

/** A JS regex-escaped literal, as `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`. */
fun jsEscape(s: String): String = buildString {
    for (c in s) {
        if (c in ".*+?^\${}()|[]\\") append('\\')
        append(c)
    }
}
