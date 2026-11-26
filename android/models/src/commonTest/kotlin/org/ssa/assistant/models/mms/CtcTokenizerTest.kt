package org.ssa.assistant.models.mms

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The decoding rules confirmed against transformers 4.53.3 (see [CtcTokenizer]), on a
 * hand-written two-language vocabulary. Every expected text follows from the rules by hand.
 */
class CtcTokenizerTest {
    private val vocab = """
        {
          "xx": {"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4, "a": 5, "b": 6, ".": 7, "'": 8, "s": 9, ",": 10},
          "yy": {"<pad>": 0, "z": 1}
        }
    """.trimIndent()

    private val defaultAdded = mapOf(0 to "<pad>", 3 to "<unk>")

    private fun config(
        targetLang: String = "xx",
        cleanUp: Boolean = true,
        lowerCase: Boolean = false,
        added: Map<Int, String> = defaultAdded,
    ): String {
        val addedJson = added.entries.joinToString(",\n") { (id, content) ->
            """    "$id": {"content": "$content", "lstrip": true, "normalized": false, "rstrip": true, "single_word": false, "special": false}"""
        }
        return """
            |{
            |  "added_tokens_decoder": {
            |$addedJson
            |  },
            |  "clean_up_tokenization_spaces": $cleanUp,
            |  "do_lower_case": $lowerCase,
            |  "pad_token": "<pad>",
            |  "replace_word_delimiter_char": " ",
            |  "target_lang": "$targetLang",
            |  "tokenizer_class": "Wav2Vec2CTCTokenizer",
            |  "unk_token": "<unk>",
            |  "word_delimiter_token": "|"
            |}
        """.trimMargin()
    }

    private val tokenizer = CtcTokenizer.fromJson(vocab, config())

    @Test
    fun takesTheTargetLanguagesVocabulary() {
        assertEquals("xx", tokenizer.targetLang)
        assertEquals(11, tokenizer.vocabSize)
        assertEquals(0, tokenizer.blankId)
        val other = CtcTokenizer.fromJson(vocab, config(targetLang = "yy", added = mapOf(0 to "<pad>")))
        assertEquals(2, other.vocabSize)
        assertEquals("z", other.decode(intArrayOf(1)))
        assertFailsWith<IllegalArgumentException> { CtcTokenizer.fromJson(vocab, config(targetLang = "zz")) }
    }

    @Test
    fun groupsRepeatsBeforeDroppingTheBlank() {
        assertEquals("a", tokenizer.decode(intArrayOf(5, 5, 5)))
        assertEquals("aa", tokenizer.decode(intArrayOf(5, 5, 0, 5)))
        assertEquals("ab", tokenizer.decode(intArrayOf(0, 5, 0, 0, 6, 6, 0)))
    }

    @Test
    fun theDelimiterBecomesOneSpaceAndTheEndsAreStripped() {
        assertEquals("a b", tokenizer.decode(intArrayOf(4, 4, 5, 4, 4, 6, 4)))
        // Two delimiters with a blank between are two tokens, so two spaces.
        assertEquals("a  b", tokenizer.decode(intArrayOf(5, 4, 0, 4, 6)))
        assertEquals("", tokenizer.decode(intArrayOf(4, 0, 4)))
    }

    @Test
    fun specialTokensStayInTheText() {
        // skip_special_tokens is false on the pipeline's CTC path: only the blank is dropped.
        assertEquals("<s>a<s></s><unk><unk>", tokenizer.decode(intArrayOf(1, 5, 1, 1, 2, 3, 3, 0, 3)))
    }

    @Test
    fun anUnknownIdIsUnkAndGroupsWithIt() {
        assertEquals("<unk>", tokenizer.token(99))
        // Grouping is on the token strings, so <unk> and an unknown id merge.
        assertEquals("a<unk>b", tokenizer.decode(intArrayOf(5, 3, 99, 6)))
    }

    @Test
    fun cleansUpTokenizationSpaces() {
        assertEquals("b.", tokenizer.decode(intArrayOf(6, 4, 7)))
        assertEquals("a,b", tokenizer.decode(intArrayOf(5, 4, 10, 6)))
        assertEquals("a's", tokenizer.decode(intArrayOf(5, 4, 8, 4, 9)))
        val raw = CtcTokenizer.fromJson(vocab, config(cleanUp = false))
        assertEquals("b .", raw.decode(intArrayOf(6, 4, 7)))
        assertEquals("a ' s", raw.decode(intArrayOf(5, 4, 8, 4, 9)))
    }

    @Test
    fun cleanUpIsOffWhenTheConfigDoesNotSayAndEmptyIsEmpty() {
        val noFlag = CtcTokenizer.fromJson("""{"<pad>": 0, "|": 1, ".": 2}""", """{}""")
        assertNull(noFlag.targetLang)
        assertEquals(false, noFlag.cleanUpTokenizationSpaces)
        assertEquals("", noFlag.decode(IntArray(0)))
        assertEquals("", tokenizer.decode(intArrayOf(0, 0, 0)))
    }

    @Test
    fun stripsPythonsWhitespaceOnly() {
        assertEquals("a", pythonStrip("\u0085\u001Ca　 "))
        assertEquals("​a", pythonStrip(" ​a"))
        assertTrue(isPythonWhitespace(' '))
        assertTrue(!isPythonWhitespace('​'))
    }

    @Test
    fun refusesWhatIsNotPorted() {
        assertFailsWith<UnsupportedOperationException> { CtcTokenizer.fromJson(vocab, config(lowerCase = true)) }
        // An added token that is not the vocabulary's token at its id.
        assertFailsWith<UnsupportedOperationException> {
            CtcTokenizer.fromJson(vocab, config(added = mapOf(0 to "<pad>", 3 to "<mask>")))
        }
        assertFailsWith<IllegalArgumentException> {
            CtcTokenizer.fromJson("""{"a": 0}""", """{}""")
        }
    }
}
