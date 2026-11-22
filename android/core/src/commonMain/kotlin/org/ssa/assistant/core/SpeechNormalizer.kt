package org.ssa.assistant.core

/**
 * Port of src/speech-normalize.js: turn a Lingala string into text
 * Simba-TTS-lin can actually say (plan 4.3, Step 2 item 3). Pinned to the JS
 * reference by the `speech` golden (SpeechNormalizerGoldenTest).
 *
 * Common Kotlin only: NFKD comes from Platform.kt's [nfkd], and every
 * character class is spelled out, so the JVM, Android's ICU and
 * Kotlin/Native agree with JS.
 */
object SpeechNormalizer {
    /** The 39 symbols Simba-TTS-lin's tokenizer knows, in vocabulary order. */
    const val SIMBA_VOCABULARY = "abcdefghijklmnopqrstuvwyz012345678 '-_ʼ"

    /** The same set as a list of one-character strings, as the golden records it. */
    val SIMBA_SYMBOLS: List<String> = SIMBA_VOCABULARY.map { it.toString() }

    /**
     * Digit words, by the language a session reads numbers in, indexed by the
     * digit. Data, because reviewers have not decided (plan 4.1).
     */
    val NUMBER_WORDS: Map<String, List<String>> = mapOf(
        "ln" to listOf("zero", "moko", "mibale", "misato", "minei", "mitano", "motoba", "nsambo", "mwambe", "libwa"),
        "fr" to listOf("zero", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"),
    )

    const val DEFAULT_NUMBER_LANGUAGE = "ln"

    /** Respelling rules for letters the model cannot spell. */
    val RESPELL: Map<String, String> = mapOf("x" to "ks")

    /** Combining marks, as JS's \p{M} after NFKD: the Unicode M categories. */
    private fun isMark(c: Char): Boolean = when (c.category) {
        CharCategory.NON_SPACING_MARK, CharCategory.COMBINING_SPACING_MARK, CharCategory.ENCLOSING_MARK -> true
        else -> false
    }

    /** What the model has, besides digits: a-z, space, ' - _ and ʼ. */
    private fun isKept(c: Char): Boolean =
        (c in 'a'..'z') || c == ' ' || c == '\'' || c == '-' || c == '_' || c == 'ʼ'

    /** JS's \s: the Unicode white space and line terminator set. */
    internal fun isJsSpace(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ',
        ' ', ' ', '　', '﻿' -> true
        else -> c in ' '..' '
    }

    /** Normalize one string for Simba, as normalizeForSpeech() in JS. */
    fun normalizeForSpeech(
        text: String?,
        numberLanguage: String = DEFAULT_NUMBER_LANGUAGE,
        respell: Map<String, String> = RESPELL,
    ): String {
        // Decompose, drop the marks, lowercase.
        var s = buildString { for (c in nfkd(text ?: "")) if (!isMark(c)) append(c) }.lowercase()

        // The parser's fold: the model was trained without the open vowels.
        s = s.replace('ɛ', 'e').replace('ɔ', 'o')

        // Typographic apostrophes and dashes become the symbols the model has.
        s = buildString {
            for (c in s) append(
                when (c) {
                    '’', '‘', '`', '´' -> '\''
                    '‐', '‑', '‒', '–', '—', '―' -> '-'
                    else -> c
                }
            )
        }

        // Every digit becomes a word, in the session's number language.
        val words = NUMBER_WORDS[numberLanguage] ?: NUMBER_WORDS.getValue(DEFAULT_NUMBER_LANGUAGE)
        s = buildString {
            for (c in s) if (c in '0'..'9') append(' ').append(words[c - '0']).append(' ') else append(c)
        }

        // Respell letters the model lacks, as whole symbols.
        for ((from, to) in respell) s = s.replace(from, " $to ")

        // Everything else is a word gap; a digit never passes.
        val out = buildString { for (c in s) append(if (isKept(c)) c else ' ') }
        return collapseSpaces(out)
    }

    /** `s.replace(/\s+/g, ' ').trim()`, for a string whose only white space is ' '. */
    private fun collapseSpaces(s: String): String {
        val b = StringBuilder()
        var gap = false
        for (c in s) {
            if (c == ' ') { gap = true; continue }
            if (gap && b.isNotEmpty()) b.append(' ')
            gap = false
            b.append(c)
        }
        return b.toString()
    }

    /** `text.split(/(?<=[.!?])\s+/u)`. */
    private fun splitSentences(text: String): List<String> {
        val out = mutableListOf<String>()
        var start = 0
        var i = 0
        while (i < text.length) {
            if (isJsSpace(text[i]) && i > 0 && text[i - 1] in ".!?") {
                var j = i
                while (j < text.length && isJsSpace(text[j])) j++
                out.add(text.substring(start, i))
                start = j
                i = j
            } else i++
        }
        out.add(text.substring(start))
        return out
    }

    /** `text.split(/\s+/)`, empty pieces at the ends included, as in JS. */
    private fun splitWords(text: String): List<String> {
        val out = mutableListOf<String>()
        val b = StringBuilder()
        var i = 0
        while (i < text.length) {
            if (isJsSpace(text[i])) {
                out.add(b.toString()); b.clear()
                while (i < text.length && isJsSpace(text[i])) i++
            } else { b.append(text[i]); i++ }
        }
        out.add(b.toString())
        return out
    }

    /**
     * Split at sentence ends (a sentence still too long, at word gaps),
     * normalize each piece, and drop the empty ones, as speechSegments() in JS.
     */
    fun speechSegments(
        text: String?,
        maxLength: Int = 220,
        numberLanguage: String = DEFAULT_NUMBER_LANGUAGE,
        respell: Map<String, String> = RESPELL,
    ): List<String> {
        val pieces = splitSentences(text ?: "").flatMap { part ->
            if (part.length <= maxLength) return@flatMap listOf(part)
            val out = mutableListOf<String>()
            var line = ""
            for (word in splitWords(part)) {
                if (line.isNotEmpty() && line.length + 1 + word.length > maxLength) { out.add(line); line = word }
                else line = if (line.isNotEmpty()) "$line $word" else word
            }
            if (line.isNotEmpty()) out.add(line)
            out
        }
        return pieces.map { normalizeForSpeech(it, numberLanguage, respell) }.filter { it.isNotEmpty() }
    }

    /** The distinct characters (code points) of [normalized] the model cannot say, in order. */
    fun unknownSymbols(normalized: String?): List<String> {
        val s = normalized ?: ""
        val out = LinkedHashSet<String>()
        var i = 0
        while (i < s.length) {
            val n = if (s[i].isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate()) 2 else 1
            val ch = s.substring(i, i + n)
            if (ch !in SIMBA_SYMBOLS) out.add(ch)
            i += n
        }
        return out.toList()
    }
}
