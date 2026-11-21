package org.ssa.assistant.core.js

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.Test

/**
 * The translator against JS itself. Every expected result below was produced
 * by `new RegExp(pattern, flags).test(input)` in Node, on inputs chosen where
 * the JVM's or ICU's defaults disagree with JS: Unicode digits and word
 * characters, the whitespace sets, Unicode case folding, `$` before a final
 * newline, and `.` against U+0085 — and Lingala text, from the same Node.
 */
class JsRegexTest {
    private data class Case(val pattern: String, val ignoreCase: Boolean, val input: String, val expected: Boolean)

    private val cases = listOf(
        Case("^\\d+$", false, "123", true),
        Case("^\\d+$", false, "١٢٣", false),
        Case("^\\d+$", false, "１２", false),
        Case("\\s", false, " ", true),
        Case("\\s", false, "\n", true),
        Case("\\s", false, "\u0085", false),
        Case("\\s", false, "﻿", true),
        Case("\\s", false, "​", false),
        Case("^\\w+$", false, "café", false),
        Case("^\\w+$", false, "abc_123", true),
        Case("\\bcaf\\b", false, "café", true),
        Case("\\bno\\b", false, "noé", true),
        Case("\\bno\\b", false, "no way", true),
        Case("^k$", true, "K", false),
        Case("^k$", true, "K", true),
        Case("^s$", true, "ſ", false),
        Case("^yes$", true, "YES", true),
        Case("^abc$", false, "abc\n", false),
        Case("^a.c$", false, "a\u0085c", true),
        Case("^a.c$", false, "a\nc", false),
        Case("^[a-z0-9'\\s-]+$", false, "it s", true),
        Case("^\\D$", false, "١", true),
        Case("^\\S+$", false, "a b", false),
        Case("^(?:my |the )?date (?:is|was)", true, "My DATE is", true),
        Case("^x\\u00e9$", true, "Xé", true),
        // Lingala input: the open vowels ɛ and ɔ, tone marks as combining
        // characters (U+0300, U+0301, U+0302), and precomposed accented
        // letters. None is an ASCII word character, so \w and \b must treat
        // each exactly as JS does whatever the platform's Unicode tables say.
        Case("^\\w+\$", false, "mb\u0254\u0301t\u025B", false),
        Case("\\bmb", false, "mb\u0254\u0301t\u025B", true),
        Case("\\bte\\b", false, "te\u0301", true),
        Case("\\bte\\b", false, "t\u00E9", false),
        Case("^.\$", false, "\u025B", true),
        Case("^.\$", false, "\u025B\u0301", false),
        Case("^.\$", false, "\u00E9", true),
        Case("^[a-z]+\$", false, "mbote", true),
        Case("^[a-z]+\$", false, "mb\u0254te", false),
        Case("\\s", false, "\u0301", false),
        Case("^te\$", true, "TE", true),
        Case("^te\$", true, "T\u00C9", false),
        Case("^\\S+\$", false, "\u0254\u0301", true),
        Case("^e\$", true, "\u0190", false),
        Case("^e\$", true, "\u025B", false),
        Case("^\\D+\$", false, "\u025B\u0301\u0254\u0300", true),
        Case("\\bn\\b", false, "n\u0254", true),
        Case("^\u025B\u025B\$", false, "\u025B\u025B", true),
        Case("^\u025B\u025B\$", false, "\u0190\u0190", false),
        Case("^e\\u0301\$", false, "\u00E9", false),
        Case("^e\\u0301\$", false, "e\u0301", true),
        Case("[\u025B\u0254]", false, "mb\u0254te", true),
        Case("^iyo\\b", true, "Iyo.", true),
        Case("^(?:\u025B|e)[.!?]*\$", false, "\u025B\u0302", false),
        Case("\\B", false, "\u025B\u0301", true),
    )

    @Test
    fun matchesWhatJsMatches() {
        for (c in cases) {
            assertEquals(c.expected, js(c.pattern, c.ignoreCase).test(c.input),
                "/${c.pattern}/${if (c.ignoreCase) "i" else ""} on ${c.input.map { it.code.toString(16).padStart(4, '0') }}")
        }
    }

    @Test
    fun trimRemovesExactlyJsWhitespace() {
        assertEquals("a", jsTrim(" ﻿ a \n　"))
        assertEquals("\u0085a\u0085", jsTrim(" \u0085a\u0085 "))
        assertEquals("\u001fa", jsTrim("\u001fa"))   // Kotlin's trim() would remove U+001F; JS's does not
    }

    @Test
    fun unsupportedSyntaxFailsLoudly() {
        assertFailsWith<IllegalArgumentException> { JsRegex.translate("(?i)x") }
        assertFailsWith<IllegalArgumentException> { JsRegex.translate("[a-z]", ignoreCase = true) }
        assertFailsWith<IllegalArgumentException> { JsRegex.translate("[\\b]") }
        assertFailsWith<IllegalArgumentException> { JsRegex.translate("[abc") }
    }

    @Test
    fun escapeMatchesTheReferenceEscapeRe() {
        assertEquals("a\\.b\\(c\\)\\$\\^\\*", jsEscape("a.b(c)$^*"))
        assertEquals(true, js("^${jsEscape("dr. o'brien (left)")}$").test("dr. o'brien (left)"))
    }
}
