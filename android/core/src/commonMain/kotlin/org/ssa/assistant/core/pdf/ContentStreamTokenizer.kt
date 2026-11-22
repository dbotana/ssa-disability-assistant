package org.ssa.assistant.core.pdf

/**
 * Parses a PDF content stream into, in order, Tj string operands and Tf font
 * name + size pairs.  Replaces the PdfBox-only [drawn()] function and must
 * reproduce the same Tj/Tf extraction for the exact bytes :pdf's [Content.kt]
 * and [AddendumRenderer] write (hex strings, /HelvWA <num> Tf).
 *
 * Works on the bytes directly: each source byte is taken as 0..255 and never
 * decoded through UTF-8, so WinAnsi bytes of 0x80 and above are preserved
 * exactly as they appear in the stream.
 */
object ContentStreamTokenizer {

    /** Extract [DrawnContent] from a PDF content-stream byte array. */
    fun drawn(bytes: ByteArray): DrawnContent {
        val strings = mutableListOf<List<Byte>>()
        val fonts = mutableListOf<Pair<String, Double>>()
        val stack = mutableListOf<Operand>()
        var i = 0
        val n = bytes.size
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            when {
                isWhitespace(b) -> i++
                b == '%'.code -> i = skipComment(bytes, i, n)
                b == '<'.code -> {
                    if (i + 1 < n && (bytes[i + 1].toInt() and 0xFF) == '<'.code) {
                        i = skipDictionary(bytes, i, n)
                    } else {
                        val r = parseHexString(bytes, i, n)
                        stack.add(Operand.Str(r.bytes))
                        i = r.next
                    }
                }
                b == '>'.code -> i++
                b == '('.code -> {
                    val r = parseLiteralString(bytes, i, n)
                    stack.add(Operand.Str(r.bytes))
                    i = r.next
                }
                b == ')'.code -> i++
                b == '['.code -> i = skipArray(bytes, i, n)
                b == ']'.code -> i++
                b == '/'.code -> {
                    val r = parseName(bytes, i, n)
                    stack.add(Operand.Name(r.name))
                    i = r.next
                }
                b == '{'.code -> i++
                b == '}'.code -> i++
                isRegular(b) -> {
                    val word = readWord(bytes, i, n)
                    i = word.next
                    val num = word.text.toDoubleOrNull()
                    if (num != null && num.isFinite()) {
                        stack.add(Operand.Num(num))
                    } else {
                        applyOperator(word.text, stack, strings, fonts)
                    }
                }
                else -> i++
            }
        }
        return DrawnContent(strings, fonts)
    }

    // -----------------------------------------------------------------
    // Operands
    // -----------------------------------------------------------------

    private sealed class Operand {
        data class Str(val bytes: List<Byte>) : Operand()
        data class Name(val name: String) : Operand()
        data class Num(val value: Double) : Operand()
    }

    /** Applies one operator to the operand stack, then clears the stack. */
    private fun applyOperator(
        op: String,
        stack: MutableList<Operand>,
        strings: MutableList<List<Byte>>,
        fonts: MutableList<Pair<String, Double>>,
    ) {
        when (op) {
            "Tj" -> {
                val str = stack.lastOrNull()?.let { o ->
                    when (o) {
                        is Operand.Str -> o.bytes
                        is Operand.Name -> null
                        is Operand.Num -> null
                    }
                }
                if (str != null) strings.add(str)
            }
            "Tf" -> {
                val font = stack.getOrNull(0)?.let { o ->
                    when (o) {
                        is Operand.Name -> o.name
                        is Operand.Str -> null
                        is Operand.Num -> null
                    }
                }
                val size = stack.getOrNull(1)?.let { o ->
                    when (o) {
                        is Operand.Num -> o.value
                        is Operand.Str -> null
                        is Operand.Name -> null
                    }
                }
                if (font != null && size != null) fonts.add(font to size)
            }
        }
        stack.clear()
    }

    // -----------------------------------------------------------------
    // Character classes
    // -----------------------------------------------------------------

    private fun isWhitespace(b: Int): Boolean =
        b == 0 || b == 9 || b == 10 || b == 12 || b == 13 || b == 32

    private fun isDelimiter(b: Int): Boolean =
        b == '('.code || b == ')'.code || b == '<'.code || b == '>'.code ||
            b == '['.code || b == ']'.code || b == '{'.code || b == '}'.code ||
            b == '/'.code || b == '%'.code

    private fun isRegular(b: Int): Boolean = !isWhitespace(b) && !isDelimiter(b)

    private fun hexValue(b: Int): Int = when (b) {
        in '0'.code..'9'.code -> b - '0'.code
        in 'a'.code..'f'.code -> b - 'a'.code + 10
        in 'A'.code..'F'.code -> b - 'A'.code + 10
        else -> -1
    }

    // -----------------------------------------------------------------
    // Comments and words
    // -----------------------------------------------------------------

    private fun skipComment(bytes: ByteArray, start: Int, n: Int): Int {
        var i = start + 1
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            if (b == 10 || b == 13) break
            i++
        }
        return i
    }

    private data class Word(val text: String, val next: Int)

    private fun readWord(bytes: ByteArray, start: Int, n: Int): Word {
        val sb = StringBuilder()
        var i = start
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            if (!isRegular(b)) break
            sb.append(b.toChar())
            i++
        }
        return Word(sb.toString(), i)
    }

    // -----------------------------------------------------------------
    // Names
    // -----------------------------------------------------------------

    private data class NameResult(val name: String, val next: Int)

    private fun parseName(bytes: ByteArray, start: Int, n: Int): NameResult {
        val sb = StringBuilder()
        var i = start + 1   // skip the leading '/'
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            if (!isRegular(b)) break
            if (b == '#'.code) {
                if (i + 2 < n) {
                    val hi = hexValue(bytes[i + 1].toInt() and 0xFF)
                    val lo = hexValue(bytes[i + 2].toInt() and 0xFF)
                    if (hi >= 0 && lo >= 0) {
                        sb.append(((hi shl 4) or lo).toChar())
                        i += 3
                        continue
                    }
                }
                sb.append('#')
                i++
                continue
            }
            sb.append(b.toChar())
            i++
        }
        return NameResult(sb.toString(), i)
    }

    // -----------------------------------------------------------------
    // Hex strings
    // -----------------------------------------------------------------

    private data class StrResult(val bytes: List<Byte>, val next: Int)

    private fun parseHexString(bytes: ByteArray, start: Int, n: Int): StrResult {
        val nibbles = mutableListOf<Int>()
        var i = start + 1   // skip '<'
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            if (b == '>'.code) {
                i++
                break
            }
            val v = hexValue(b)
            if (v >= 0) nibbles.add(v)
            i++
        }
        if (nibbles.size % 2 != 0) nibbles.add(0)   // pad an odd final nibble
        val out = mutableListOf<Byte>()
        var k = 0
        while (k < nibbles.size) {
            out.add(((nibbles[k] shl 4) or nibbles[k + 1]).toByte())
            k += 2
        }
        return StrResult(out, i)
    }

    // -----------------------------------------------------------------
    // Literal strings
    // -----------------------------------------------------------------

    private fun parseLiteralString(bytes: ByteArray, start: Int, n: Int): StrResult {
        val out = mutableListOf<Byte>()
        var i = start + 1   // skip '('
        var depth = 1
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            when {
                b == '\\'.code -> {
                    i++
                    if (i >= n) break
                    i = appendEscaped(bytes, i, n, out)
                }
                b == '('.code -> {
                    depth++
                    out.add(b.toByte())
                    i++
                }
                b == ')'.code -> {
                    depth--
                    if (depth == 0) { i++; break }
                    out.add(b.toByte())
                    i++
                }
                else -> {
                    out.add(b.toByte())
                    i++
                }
            }
        }
        return StrResult(out, i)
    }

    /** Appends one escape sequence's bytes, returning the index just after it. */
    private fun appendEscaped(bytes: ByteArray, start: Int, n: Int, out: MutableList<Byte>): Int {
        val b = bytes[start].toInt() and 0xFF
        return when (b) {
            'n'.code -> { out.add(10); start + 1 }
            'r'.code -> { out.add(13); start + 1 }
            't'.code -> { out.add(9); start + 1 }
            'b'.code -> { out.add(8); start + 1 }
            'f'.code -> { out.add(12); start + 1 }
            '('.code -> { out.add(0x28); start + 1 }
            ')'.code -> { out.add(0x29); start + 1 }
            '\\'.code -> { out.add(0x5C); start + 1 }
            10 -> start + 1                          // line continuation
            13 -> {                                   // CR, possibly CRLF
                var j = start + 1
                if (j < n && (bytes[j].toInt() and 0xFF) == 10) j++
                j
            }
            in '0'.code..'7'.code -> {
                var value = 0
                var j = start
                var count = 0
                while (j < n && count < 3) {
                    val d = bytes[j].toInt() and 0xFF
                    if (d !in '0'.code..'7'.code) break
                    value = (value shl 3) or (d - '0'.code)
                    j++
                    count++
                }
                out.add((value and 0xFF).toByte())
                j
            }
            else -> { out.add(b.toByte()); start + 1 }
        }
    }

    // -----------------------------------------------------------------
    // Arrays and dictionaries (skipped, but their contents can nest)
    // -----------------------------------------------------------------

    private fun skipArray(bytes: ByteArray, start: Int, n: Int): Int {
        var i = start + 1   // skip '['
        var depth = 1
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            when {
                b == '['.code -> { depth++; i++ }
                b == ']'.code -> {
                    depth--
                    i++
                    if (depth == 0) return i
                }
                b == '('.code -> i = parseLiteralString(bytes, i, n).next
                b == '<'.code && i + 1 < n && (bytes[i + 1].toInt() and 0xFF) == '<'.code ->
                    i = skipDictionary(bytes, i, n)
                b == '<'.code -> i = parseHexString(bytes, i, n).next
                b == '%'.code -> i = skipComment(bytes, i, n)
                else -> i++
            }
        }
        return n
    }

    private fun skipDictionary(bytes: ByteArray, start: Int, n: Int): Int {
        var i = start + 2   // skip '<<'
        var depth = 1
        while (i < n) {
            val b = bytes[i].toInt() and 0xFF
            when {
                b == '<'.code && i + 1 < n && (bytes[i + 1].toInt() and 0xFF) == '<'.code -> {
                    depth++
                    i += 2
                }
                b == '>'.code && i + 1 < n && (bytes[i + 1].toInt() and 0xFF) == '>'.code -> {
                    depth--
                    i += 2
                    if (depth == 0) return i
                }
                else -> i++
            }
        }
        return n
    }
}
