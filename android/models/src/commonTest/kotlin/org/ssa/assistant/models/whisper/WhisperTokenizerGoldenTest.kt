package org.ssa.assistant.models.whisper

import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.models.testing.PinnedModel
import org.ssa.assistant.models.testing.WhisperGolden
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WhisperTokenizerGoldenTest {
    private val tokenizer: WhisperTokenizer by lazy {
        WhisperTokenizer.fromJson(
            PinnedModel.text("tokenizer.json"),
            PinnedModel.text("tokenizer_config.json"),
        )
    }

    @Test
    fun decodesAllGoldenCases() {
        PinnedModel.dir
        val failures = mutableListOf<String>()
        for (case in WhisperGolden.decodeCases) {
            val name = WhisperGolden.string(case, "name")
            val ids = WhisperGolden.longs(case["ids"]).toLongArray()
            val actual = tokenizer.decode(ids)
            val expected = WhisperGolden.string(case, "text")
            if (actual != expected) failures += "$name: got ${actual.toDebugString()}, want ${expected.toDebugString()}"
        }
        for (clip in WhisperGolden.clips) {
            val name = WhisperGolden.string(clip, "name")
            val ids = WhisperGolden.longs(clip["ids"]).toLongArray()
            val actual = tokenizer.decode(ids)
            val expected = WhisperGolden.string(clip, "text")
            if (actual != expected) failures += "$name: got ${actual.toDebugString()}, want ${expected.toDebugString()}"
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    @Test
    fun matchesGoldenTokenProperties() {
        val decoding = WhisperGolden.decoding
        assertEquals(WhisperGolden.longs(decoding["specialIds"]), tokenizer.specialIds.map { it.toLong() })
        assertEquals(WhisperGolden.longs(decoding["skippedIds"]), tokenizer.skippedIds.map { it.toLong() })
        assertEquals(
            decoding["cleanUpTokenizationSpaces"]?.asBoolean() == true,
            tokenizer.cleanUpTokenizationSpaces,
        )
    }

    @Test
    fun usesTheGpt2ByteMap() {
        assertEquals(256, GPT2_BYTE_CHARS.toHashSet().size)
        assertEquals('Ġ', GPT2_BYTE_CHARS[' '.code])
        assertEquals('Ċ', GPT2_BYTE_CHARS['\n'.code])
    }
}

private fun String.toDebugString(): String = buildString(length + 2) {
    append('"')
    for (c in this@toDebugString) {
        when (c) {
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(c)
        }
    }
    append('"')
}
