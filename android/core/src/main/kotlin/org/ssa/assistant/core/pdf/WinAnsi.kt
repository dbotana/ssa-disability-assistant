package org.ssa.assistant.core.pdf

/**
 * Port of toWinAnsi() in src/forms/common.js.
 *
 * pdf-lib's standard Helvetica can only draw the WinAnsi character set, and it
 * throws on anything else — one name typed with a character outside it would
 * fail the whole download. Every string headed for a PDF goes through here
 * first: accented letters outside Latin-1 lose their accent (ő -> o, Ł -> L),
 * tabs and carriage returns become spaces, and anything with no close
 * equivalent becomes "?".
 */

private val WIN_ANSI_EXTRAS: Set<String> =
    "€‚ƒ„…†‡ˆ‰Š‹ŒŽ''\"\"•–—˜™š›œžŸ".map { it.toString() }.toSet()

private val STROKED = mapOf(
    "Ł" to "L", "ł" to "l", "Đ" to "D", "đ" to "d", "Ħ" to "H", "ħ" to "h",
    "ı" to "i", "Ŧ" to "T", "ŧ" to "t"
)

private fun encodable(cp: Int): Boolean {
    if (cp == 0x0A) return true
    if (cp in 0x20..0x7E) return true
    if (cp in 0xA0..0xFF) return true
    return WIN_ANSI_EXTRAS.contains(String(Character.toChars(cp)))
}

object WinAnsi {
    /** The glyph a code point encodes to, as pdf-lib's WinAnsi table has it. */
    fun glyphFor(cp: Int): Pair<Int, String> =
        WIN_ANSI_ENCODING[cp] ?: throw IllegalArgumentException(
            "WinAnsi cannot encode U+%04X".format(cp)
        )

    /**
     * The closest thing to [value] that Helvetica can draw. Iterates code
     * points, as JS's for..of does, and normalizes NFKD (stripping combining
     * marks) exactly like `ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')`.
     */
    fun toWinAnsi(value: Any?): String {
        val s = (value?.toString() ?: "").replace(Regex("[\t\r]"), " ")
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            i += Character.charCount(cp)
            val ch = String(Character.toChars(cp))
            if (encodable(cp)) { out.append(ch); continue }
            val stroked = STROKED[ch]
            if (stroked != null) { out.append(stroked); continue }
            val normalized = java.text.Normalizer.normalize(ch, java.text.Normalizer.Form.NFKD)
            val base = StringBuilder()
            var k = 0
            while (k < normalized.length) {
                val c = normalized.codePointAt(k)
                k += Character.charCount(c)
                if (c !in 0x300..0x36F) base.appendCodePoint(c)
            }
            val baseStr = base.toString()
            val every = baseStr.codePoints().allMatch { encodable(it) }
            out.append(if (every && baseStr.isNotEmpty()) baseStr else "?")
        }
        return out.toString()
    }
}
