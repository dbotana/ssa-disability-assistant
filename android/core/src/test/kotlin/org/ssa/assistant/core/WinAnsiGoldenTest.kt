package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.pdf.WinAnsi

/**
 * The `winansi` golden: toWinAnsi() from the JS reference over every code
 * point of the Latin, punctuation, currency and letterlike blocks, plus
 * samples that must lose an accent or become "?". Every value headed for a
 * PDF goes through it, so the Kotlin port must agree on all of them — the
 * curly quotes once came out as "?" here and no other golden noticed.
 */
class WinAnsiGoldenTest {
    @Test
    fun everyCodePointMatchesTheReference() {
        val cases = Golden.load("winansi").asObject()!!["cases"]!!.asArray()!!.items
        check(cases.size > 1000) { "only ${cases.size} cases" }
        val wrong = cases.mapNotNull { c ->
            val (text, ansi) = c.asArray()!!.items.map { it.asString()!! }
            val got = WinAnsi.toWinAnsi(text)
            if (got == ansi) null else "U+%04X".format(text.codePointAt(0)) + " \"$text\": JS \"$ansi\", Kotlin \"$got\""
        }
        check(wrong.isEmpty()) { "${wrong.size} code points differ:\n  " + wrong.take(20).joinToString("\n  ") }
    }

    @Test
    fun everyKeptCharacterEncodes() {
        // What toWinAnsi keeps, encode() can draw — except the newline, which
        // only multiline values carry and wrapLines splits on before drawing.
        val cases = Golden.load("winansi").asObject()!!["cases"]!!.asArray()!!.items
        for (c in cases) {
            val ansi = c.asArray()!!.items[1].asString()!!.replace("\n", "")
            WinAnsi.encode(ansi)
        }
    }
}
