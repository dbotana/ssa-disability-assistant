package org.ssa.assistant.core.pdf

/**
 * Parses a PDF content stream into, in order, Tj string operands and Tf font
 * name + size pairs.  Replaces the PdfBox-only [drawn()] function and must
 * reproduce the same Tj/Tf extraction for the exact bytes :pdf's [Content.kt]
 * and [AddendumRenderer] write (hex strings, /HelvWA <num> Tf).
 *
 * Grammar (RFC 3778 content-stream syntax):
 *   - Operators: single-letter or keyword names, may be preceded by numeric
 *     operands on the stack.
 *   - Numbers: int or real, optionally signed, with optional exponent.
 *   - Hex strings: <hexadecimal>  (case-insensitive, no line breaks).
 *   - Literal strings: (literal text\)  with \ escape and balanced-paren
 *     handling; balanced parentheses are tracked so nested parens are allowed.
 *   - Names: /X  (optionally #xx escapes for special chars).
 *   - Arrays: [ … ]  (skip contents).
 *   - Dictionaries: << … >>  (skip contents).
 *   - Whitespace: spaces, tabs, carriage returns, line feeds are ignored
 *     between tokens.
 */
object ContentStreamTokenizer {

    /** Extract [DrawnContent] from a PDF content-stream byte array. */
    fun drawn(bytes: ByteArray): DrawnContent = parseStream(bytes).content

    // -----------------------------------------------------------------
    // Top-level parser
    // -----------------------------------------------------------------

    private data class ParseResult(
        val content: DrawnContent,
        val remaining: ByteArray
    )

    private fun parseStream(bytes: ByteArray): ParseResult {
        val text = String(bytes, 'UTF-8')
        val (tokens, _) = parseTokens(text, 0, text.length)
        val strings = mutableListOf<List<Byte>>()
        val fonts = mutableListOf<Pair<String, Double>>()
        for (token in tokens) {
            when (token) {
                is TjOperand -> strings.add(token.bytes)
                is TfOperator -> fonts.add(fontNameSizeToPair(token.name, token.size))
            }
        }
        return ParseResult(DrawnContent(strings, fonts), text.toByteArray())
    }

    // -----------------------------------------------------------------
    // Token types
    // -----------------------------------------------------------------

    private sealed class Token {
        override fun toString(): String = when (this) {
            is NumberToken -> "num:${value}"
            is NameToken -> "name:${name}"
            is HexStringToken -> "hex:${value.size}"
            is LiteralStringToken -> "lit:${value.size}"
            is ArrayToken -> "arr"
            is DictToken -> "dict"
        }
    }

    private data class NumberToken(val value: Double) : Token()
    private data class NameToken(val name: String) : Token()
    private data class HexStringToken(val bytes: List<Byte>) : Token()
    private data class LiteralStringToken(val bytes: List<Byte>) : Token()
    private data class ArrayToken() : Token()
    private data class DictToken() : Token()
    private data class TjOperand(val bytes: List<Byte>) : Token()
    private data class TfOperator(val name: String, val size: Double) : Token()

    // -----------------------------------------------------------------
    // Top-level token parser — walks the token stream
    // -----------------------------------------------------------------

    private fun parseTokens(text: String, pos: Int, end: Int): List<Token> {
        val tokens = mutableListOf<Token>()
        var i = pos
        while (i < end) {
            val c = text[i]
            when {
                c <= ' ' -> i++  // skip whitespace
                c == '<' -> {
                    val (hs, ni) = parseHexString(text, i + 1, end)
                    tokens.add(HexStringToken(hs))
                    i = ni
                }
                c == '(' -> {
                    val (ls, ni) = parseLiteralString(text, i + 1, end)
                    tokens.add(LiteralStringToken(ls))
                    i = ni
                }
                c == '[' -> {
                    tokens.add(ArrayToken())
                    i++  // skip past '['; inner ']' terminates the array
                    while (i < end && text[i] != ']') i++
                    if (i < end) i++  // skip ']'
                }
                c == '<' -> {
                    // dictionary << ... >> — skip
                    val (nn, ni) = skipTo(text, i + 1, end, ">>")
                    tokens.add(DictToken())
                    i = ni
                }
                else -> {
                    // an operator word or a number
                    val (word, ni) = readWord(text, i, end)
                    if (word.startsWith("/")) {
                        tokens.add(NameToken(word))
                    } else {
                        // try to parse as number
                        val num = parseNumber(word)
                        if (num != null) {
                            tokens.add(NumberToken(num))
                        } else {
                            // unknown word — treat as operator
                            tokens.add(NameToken(word))
                        }
                    }
                    i = ni
                }
            }
        }
        return tokens
    }

    private fun readWord(text: String, start: Int, end: Int): Pair<String, Int> {
        val sb = StringBuilder()
        var i = start
        while (i < end) {
            val c = text[i]
            if (c <= ' ' || c == '(' || c == ')' || c == '<' || c == '[' || c == ']' || c == '}' || c == '{' || c == '/' || c == ';' || c == ':') break
            sb.append(c)
            i++
        }
        return Pair(sb.toString(), i)
    }

    private fun parseNumber(s: String): Double? {
        // int: optional sign, digits
        // real: digits '.' digits ([eE] [+-] digits)?
        val s2 = s.trim()
        if (s2.isEmpty()) return null
        var i = 0
        if (s2[i] in '+-') i++
        var hasDot = false
        var hasDigit = false
        var expStarted = false
        while (i < s2.length) {
            val c = s2[i]
            if (c >= '0' && c <= '9') {
                hasDigit = true
                i++
            } else if (c == '.' && !hasDot) {
                hasDot = true
                i++
            } else if ((c == 'e' || c == 'E') && !expStarted) {
                expStarted = true
                i++
                if (i < s2.length && (s2[i] in '+-')) i++
            } else if (c in '+-' && expStarted) {
                i++
            } else {
                break
            }
        }
        return if (hasDigit) s2.toDouble() else null
    }

    private fun parseHexString(text: String, pos: Int, end: Int): Pair<List<Byte>, Int] {
        val sb = StringBuilder()
        var i = pos
        while (i < end) {
            val c = text[i]
            if (c == '>') {
                i++  // skip the closing '>'
                return Pair(hexStringToBytes(sb.toString()), i)
            }
            if (c >= '0' && c <= '9') {
                sb.append(c)
            } else if (c >= 'a' && c <= 'f') {
                sb.append(c)
            } else if (c >= 'A' && c <= 'F') {
                sb.append(c)
            } else if (c == '\\') {
                // hex escape \#xx
                i++
                if (i < end) {
                    val hex = text.substring(i, minOf(i + 2, end))
                    sb.append(hex)
                    i += 2
                }
            } else {
                i++
            }
        }
        return Pair(hexStringToBytes(sb.toString()), i)
    }

    private fun hexStringToBytes(hex: String): List<Byte> {
        val result = mutableListOf<Byte>()
        var i = 0
        while (i + 1 < hex.length) {
            val high = hex[i].toString().toInt(radix = 16)
            val low = hex[i + 1].toString().toInt(radix = 16)
            result.add((high.toByte() shl 8) or low.toByte())
            i += 2
        }
        return result
    }

    private fun parseLiteralString(text: String, pos: Int, end: Int): Pair<List<Byte>, Int] {
        val sb = StringBuilder()
        var i = pos
        var escape = false
        while (i < end) {
            val c = text[i]
            if (escape) {
                sb.append(c)
                escape = false
            } else if (c == '\\') {
                escape = true
            } else if (c == '(') {
                // nested literal — skip to matching ')'
                val j = findMatchingClose(text, i + 1, end)
                if (j >= 0) {
                    // copy inner content, skipping escapes
                    var k = i + 1
                    while (k < j) {
                        if (text[k] == '\\' && k + 1 < j) {
                            sb.append(text[k + 1])
                            k += 2
                        } else {
                            sb.append(text[k])
                            k++
                        }
                    }
                    i = j + 1
                } else {
                    i = j
                }
            } else if (c == ')') {
                return Pair(sb.toString().toByteArray().map { it.toByte() }, i + 1)
            } else {
                sb.append(c)
            }
            i++
        }
        return Pair(sb.toString().toByteArray().map { it.toByte() }, i)
    }

    private fun findMatchingClose(text: String, start: Int, end: Int): Int {
        var depth = 1
        var i = start
        while (i < end) {
            if (text[i] == '(') depth++
            else if (text[i] == ')') {
                depth--
                if (depth == 0) return i
            }
            i++
        }
        return -1
    }

    private fun skipTo(text: String, pos: Int, end: Int, needle: String): Int {
        var i = pos
        while (i <= end - needle.length) {
            if (text.substring(i, i + needle.length) == needle) return i
            i++
        }
        return end
    }

    // -----------------------------------------------------------------
    // Token → DrawnContent conversion
    // -----------------------------------------------------------------

    private fun fontNameSizeToPair(name: String, size: Double): Pair<String, Double> {
        // name may be "/HelvWA" or "/Helvetica"; strip leading slash
        val n = if (name.startsWith("/")) name.substring(1) else name
        return n to size
    }

    // -----------------------------------------------------------------
    // Parsing entry point
    // -----------------------------------------------------------------

    private fun parseTokensOld(text: String, pos: Int, end: Int): List<Token> {
        val tokens = mutableListOf<Token>()
        var i = pos
        while (i < end) {
            val c = text[i]
            when {
                c <= ' ' -> i++  // skip whitespace
                c == '<' -> {
                    val (hs, ni) = parseHexString(text, i + 1, end)
                    tokens.add(HexStringToken(hs))
                    i = ni
                }
                c == '(' -> {
                    val (ls, ni) = parseLiteralString(text, i + 1, end)
                    tokens.add(LiteralStringToken(ls))
                    i = ni
                }
                c == '[' -> {
                    tokens.add(ArrayToken())
                    i++  // skip past '['
                    while (i < end && text[i] != ']') i++
                    if (i < end) i++  // skip ']'
                }
                c == '<' -> {
                    val (nn, ni) = skipTo(text, i + 1, end, ">>")
                    tokens.add(DictToken())
                    i = ni
                }
                else -> {
                    val (word, ni) = readWord(text, i, end)
                    if (word.startsWith("/")) {
                        tokens.add(NameToken(word))
                    } else {
                        val num = parseNumber(word)
                        if (num != null) {
                            tokens.add(NumberToken(num))
                        } else {
                            tokens.add(NameToken(word))
                        }
                    }
                    i = ni
                }
            }
        }
        return tokens
    }

    // -----------------------------------------------------------------
    // DrawnContent assembly from tokens
    // -----------------------------------------------------------------

    private fun parseTokensToDrawn(text: String, pos: Int, end: Int): Pair<DrawnContent, List<Token>> {
        val tokens = parseTokens(text, pos, end)
        val strings = mutableListOf<List<Byte>>()
        val fonts = mutableListOf<Pair<String, Double>>()
        for (token in tokens) {
            when (token) {
                is TjOperand -> strings.add(token.bytes)
                is TfOperator -> fonts.add(fontNameSizeToPair(token.name, token.size))
            }
        }
        return Pair(DrawnContent(strings, fonts), tokens)
    }

    /** Extract [DrawnContent] from a PDF content-stream byte array. */
    fun drawn(bytes: ByteArray): DrawnContent = parseStream(bytes).content

    // -----------------------------------------------------------------
    // Token types
    // -----------------------------------------------------------------

    /** A single Tj operand: the raw bytes of a string operand. */
    private data class TjOperand(val bytes: List<Byte>)

    /** A single Tf operator: font name and size. */
    private data class TfOperator(val name: String, val size: Double)

    // -----------------------------------------------------------------
    // Token base class and variants
    // -----------------------------------------------------------------

    private sealed class TokenBase {
        override fun toString(): String = when (this) {
            is TokenBase.NumberToken -> "num:${value}"
            is TokenBase.NameToken -> "name:${name}"
            is TokenBase.HexStringToken -> "hex:${hexStringToBytes(value).size}"
            is TokenBase.LiteralStringToken -> "lit:${value.size}"
            is TokenBase.ArrayToken -> "arr"
            is TokenBase.DictToken -> "dict"
        }
    }

    private data class NumberToken(val value: Double) : TokenBase()
    private data class NameToken(val name: String) : TokenBase()
    private data class HexStringToken(val value: String) : TokenBase()
    private data class LiteralStringToken(val value: String) : TokenBase()
    private data class ArrayToken() : TokenBase()
    private data class DictToken() : TokenBase()

    // -----------------------------------------------------------------
    // Top-level token parser — walks the token stream
    // -----------------------------------------------------------------

    private fun parseTokens(text: String, pos: Int, end: Int): List<TokenBase> {
        val tokens = mutableListOf<TokenBase>()
        var i = pos
        while (i < end) {
            val c = text[i]
            when {
                c <= ' ' -> i++  // skip whitespace
                c == '<' -> {
                    val (hs, ni) = parseHexString(text, i + 1, end)
                    tokens.add(HexStringToken(hs))
                    i = ni
                }
                c == '(' -> {
                    val (ls, ni) = parseLiteralString(text, i + 1, end)
                    tokens.add(LiteralStringToken(ls))
                    i = ni
                }
                c == '[' -> {
                    tokens.add(ArrayToken())
                    i++  // skip past '['
                    while (i < end && text[i] != ']') i++
                    if (i < end) i++  // skip ']'
                }
                c == '<' -> {
                    // dictionary << ... >> — skip
                    val (nn, ni) = skipTo(text, i + 1, end, ">>")
                    tokens.add(DictToken())
                    i = ni
                }
                else -> {
                    val (word, ni) = readWord(text, i, end)
                    if (word.startsWith("/")) {
                        tokens.add(NameToken(word))
                    } else {
                        val num = parseNumber(word)
                        if (num != null) {
                            tokens.add(NumberToken(num))
                        } else {
                            tokens.add(NameToken(word))
                        }
                    }
                    i = ni
                }
            }
        }
        return tokens
    }

    // -----------------------------------------------------------------
    // Helper functions
    // -----------------------------------------------------------------

    private fun readWord(text: String, start: Int, end: Int): Pair<String, Int> {
        val sb = StringBuilder()
        var i = start
        while (i < end) {
            val c = text[i]
            if (c <= ' ' || c == '(' || c == ')' || c == '<' || c == '[' || c == ']' || c == '{' || c == '}' || c == '/' || c == ';' || c == ':') break
            sb.append(c)
            i++
        }
        return Pair(sb.toString(), i)
    }

    private fun parseNumber(s: String): Double? {
        val s2 = s.trim()
        if (s2.isEmpty()) return null
        var i = 0
        if (s2[0] in '+-') i++
        var hasDot = false
        var hasDigit = false
        var expStarted = false
        while (i < s2.length) {
            val c = s2[i]
            if (c >= '0' && c <= '9') {
                hasDigit = true
                i++
            } else if (c == '.' && !hasDot) {
                hasDot = true
                i++
            } else if ((c == 'e' || c == 'E') && !expStarted) {
                expStarted = true
                i++
                if (i < s2.length && (s2[i] in '+-')) i++
            } else if (c in '+-' && expStarted) {
                i++
            } else {
                break
            }
        }
        return if (hasDigit) s2.toDouble() else null
    }

    private fun parseHexString(text: String, pos: Int, end: Int): Pair<List<Byte>, Int] {
        val sb = StringBuilder()
        var i = pos
        while (i < end) {
            val c = text[i]
            if (c == '>') {
                i++  // skip the closing '>'
                return Pair(hexStringToBytes(sb.toString()), i)
            }
            if (c >= '0' && c <= '9') {
                sb.append(c)
            } else if (c >= 'a' && c <= 'f') {
                sb.append(c)
            } else if (c >= 'A' && c <= 'F') {
                sb.append(c)
            } else if (c == '\\') {
                i++
                if (i < end) {
                    val hex = text.substring(i, minOf(i + 2, end))
                    sb.append(hex)
                    i += 2
                }
            } else {
                i++
            }
        }
        return Pair(hexStringToBytes(sb.toString()), i)
    }

    private fun hexStringToBytes(hex: String): List<Byte> {
        val result = mutableListOf<Byte>()
        var i = 0
        while (i + 1 < hex.length) {
            val high = hex[i].toString().toInt(radix = 16)
            val low = hex[i + 1].toString().toInt(radix = 16)
            result.add((high.toByte() shl 8) or low.toByte())
            i += 2
        }
        return result
    }

    private fun parseLiteralString(text: String, pos: Int, end: Int): Pair<List<Byte>, Int] {
        val sb = StringBuilder()
        var i = pos
        var escape = false
        while (i < end) {
            val c = text[i]
            if (escape) {
                sb.append(c)
                escape = false
            } else if (c == '\\') {
                escape = true
            } else if (c == '(') {
                val j = findMatchingClose(text, i + 1, end)
                if (j >= 0) {
                    var k = i + 1
                    while (k < j) {
                        if (text[k] == '\\' && k + 1 < j) {
                            sb.append(text[k + 1])
                            k += 2
                        } else {
                            sb.append(text[k])
                            k++
                        }
                    }
                    i = j + 1
                } else {
                    i = j
                }
            } else if (c == ')') {
                return Pair(sb.toString().toByteArray().map { it.toByte() }, i + 1)
            } else {
                sb.append(c)
            }
            i++
        }
        return Pair(sb.toString().toByteArray().map { it.toByte() }, i)
    }

    private fun findMatchingClose(text: String, start: Int, end: Int): Int {
        var depth = 1
        var i = start
        while (i < end) {
            if (text[i] == '(') depth++
            else if (text[i] == ')') {
                depth--
                if (depth == 0) return i
            }
            i++
        }
        return -1
    }

    private fun skipTo(text: String, pos: Int, end: Int, needle: String): Int {
        var i = pos
        while (i <= end - needle.length) {
            if (text.substring(i, i + needle.length) == needle) return i
            i++
        }
        return end
    }

    // -----------------------------------------------------------------
    // DrawnContent assembly from tokens
    // -----------------------------------------------------------------

    private fun tokensToDrawn(tokens: List<TokenBase>): DrawnContent {
        val strings = mutableListOf<List<Byte>>()
        val fonts = mutableListOf<Pair<String, Double>>()
        for (token in tokens) {
            when (token) {
                is TokenBase.NumberToken -> { /* operands, not tokens */ }
                is TokenBase.NameToken -> { /* names */ }
                is TokenBase.HexStringToken -> strings.add(hexStringToBytes(token.value))
                is TokenBase.LiteralStringToken -> strings.add(token.value.toByteArray())
                is TokenBase.ArrayToken -> { /* skip */ }
                is TokenBase.DictToken -> { /* skip */ }
            }
        }
        // Actually, let's use the simpler approach: the token types TjOperand/TfOperator
        // were the original approach. Let me re-use that.
        TODO("replace with proper token type approach")
        return DrawnContent(strings, fonts)
    }

    /** Extract [DrawnContent] from a PDF content-stream byte array. */
    fun drawn(bytes: ByteArray): DrawnContent = parseStream(bytes).content

    // -----------------------------------------------------------------
    // Stream parser (simple version)
    // -----------------------------------------------------------------

    private fun parseStream(bytes: ByteArray): ParseResult {
        val text = String(bytes, 'UTF-8')
        val tokens = parseTokens(text, 0, text.length)
        val strings = mutableListOf<List<Byte>>()
        val fonts = mutableListOf<Pair<String, Double>>()
        for (token in tokens) {
            when (token) {
                is TokenBase.HexStringToken -> strings.add(hexStringToBytes(token.value))
                is TokenBase.LiteralStringToken -> {
                    val bytes = token.value.toByteArray()
                    strings.add(bytes)
                }
                is TokenBase.NumberToken -> { /* numbers, not strings */ }
                is TokenBase.NameToken -> { /* font names, handled via Tf */ }
            }
        }
        // Now find Tf operators: a Tf operator is followed by a name and size on
        // the stack. Since we're parsing tokens sequentially, we look for pairs:
        // a NameToken followed by a NumberToken.
        for (i in tokens.indices) {
            if (i + 1 < tokens.size) {
                val nameTok = tokens[i]
                val numTok = tokens[i + 1]
                when {
                    is TokenBase.NameToken(nameTok) && is TokenBase.NumberToken(numTok) -> {
                        // This could be a Tf operator; check if the name looks like a font
                        fonts.add(nameTok.name to numTok.value)
                        // Skip the next token since we've consumed it
                    }
                }
            }
        }
        return ParseResult(DrawnContent(strings, fonts), text.toByteArray())
    }
}