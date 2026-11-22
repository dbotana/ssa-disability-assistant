package org.ssa.assistant.core.pdf

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The content-stream tokenizer over hand-built streams: hex and literal Tj
 * strings, Tf font name + size, name #xx escapes, and array/dictionary
 * skipping. The bytes are ASCII so `encodeToByteArray()` (UTF-8) is exact.
 */
class ContentStreamTokenizerTest {

    private fun bytes(s: String): ByteArray = s.encodeToByteArray()

    @Test
    fun extractsTjStringAndTfFontInStreamOrder() {
        val drawn = ContentStreamTokenizer.drawn(
            bytes("q BT /HelvWA 9.5 Tf 1 0 0 1 72 720 Tm <4869> Tj ET Q")
        )
        assertEquals(listOf(listOf<Byte>(0x48, 0x69)), drawn.strings)
        assertEquals(listOf("HelvWA" to 9.5), drawn.fonts)
    }

    @Test
    fun padsAnOddFinalHexNibbleWithZero() {
        val drawn = ContentStreamTokenizer.drawn(bytes("<486> Tj"))
        assertEquals(listOf(listOf<Byte>(0x48, 0x60)), drawn.strings)
    }

    @Test
    fun ignoresWhitespaceInsideAHexString() {
        val drawn = ContentStreamTokenizer.drawn(bytes("<48 69> Tj"))
        assertEquals(listOf(listOf<Byte>(0x48, 0x69)), drawn.strings)
    }

    @Test
    fun decodesLiteralStringEscapesAndNesting() {
        // "H(i)" with the parens escaped, then a nested pair, then a newline escape.
        val drawn = ContentStreamTokenizer.drawn(bytes("(H\\(i\\)) Tj (a(b)c) Tj (x\\ny) Tj"))
        assertEquals(
            listOf(
                listOf<Byte>(0x48, 0x28, 0x69, 0x29),
                listOf<Byte>(0x61, 0x28, 0x62, 0x29, 0x63),
                listOf<Byte>(0x78, 0x0A, 0x79),
            ),
            drawn.strings,
        )
    }

    @Test
    fun decodesNameHashEscapes() {
        val drawn = ContentStreamTokenizer.drawn(bytes("/F#31 9 Tf"))
        assertEquals(listOf("F1" to 9.0), drawn.fonts)
    }

    @Test
    fun skipsArraysAndDictionaries() {
        val drawn = ContentStreamTokenizer.drawn(
            bytes("q [/HelvWA 9.5] << /X 1 >> [<4869>] <4849> Tj ET Q")
        )
        // Only the top-level <4849> Tj survives; the array's <4869> is skipped.
        assertEquals(listOf(listOf<Byte>(0x48, 0x49)), drawn.strings)
        assertEquals(emptyList(), drawn.fonts)
    }

    @Test
    fun commentsAreIgnored() {
        val drawn = ContentStreamTokenizer.drawn(bytes("% a comment\n/HelvWA 9.5 Tf <4869> Tj"))
        assertEquals(listOf("HelvWA" to 9.5), drawn.fonts)
        assertEquals(listOf(listOf<Byte>(0x48, 0x69)), drawn.strings)
    }
}
