package org.ssa.assistant.core.js

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The translator against JS itself. Every expected result below was produced
 * by `new RegExp(pattern, flags).test(input)` in Node, on inputs chosen where
 * the JVM's or ICU's defaults disagree with JS: Unicode digits and word
 * characters, the whitespace sets, Unicode case folding, `$` before a final
 * newline, and `.` against U+0085.
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
    )

    @Test
    fun matchesWhatJsMatches() {
        for (c in cases) {
            assertEquals("/${c.pattern}/${if (c.ignoreCase) "i" else ""} on ${c.input.map { "%04x".format(java.util.Locale.ROOT, it.code) }}",
                c.expected, js(c.pattern, c.ignoreCase).test(c.input))
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
        assertThrows(IllegalArgumentException::class.java) { JsRegex.translate("(?i)x") }
        assertThrows(IllegalArgumentException::class.java) { JsRegex.translate("[a-z]", ignoreCase = true) }
        assertThrows(IllegalArgumentException::class.java) { JsRegex.translate("[\\b]") }
        assertThrows(IllegalArgumentException::class.java) { JsRegex.translate("[abc") }
    }

    @Test
    fun escapeMatchesTheReferenceEscapeRe() {
        assertEquals("a\\.b\\(c\\)\\$\\^\\*", jsEscape("a.b(c)$^*"))
        assertEquals(true, js("^${jsEscape("dr. o'brien (left)")}$").test("dr. o'brien (left)"))
    }
}
