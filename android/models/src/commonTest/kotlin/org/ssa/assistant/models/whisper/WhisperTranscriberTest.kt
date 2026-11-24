package org.ssa.assistant.models.whisper

import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.LongTensor
import org.ssa.assistant.models.testing.ScriptedSession
import org.ssa.assistant.models.testing.mergedDecoderNames
import org.ssa.assistant.models.testing.runBlockingTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class WhisperTranscriberTest {
    private val config = WhisperConfig(
        prompt = listOf(3, 4),
        eosTokenId = 2,
        maxLength = 448,
        beginSuppressTokens = emptyList(),
        decoderLayers = 1,
        decoderHeads = 2,
        encoderHeads = 2,
        dModel = 8,
    )

    @Test
    fun rejectsNonEnglishAndLongAudio() {
        val transcriber = transcriber()
        val languageError = assertFailsWith<IllegalArgumentException> {
            transcriber.transcribeDetailed(FloatArray(16000), "ln")
        }
        assertTrue("English-only" in (languageError.message ?: ""), languageError.message ?: "no message")

        val lengthError = assertFailsWith<IllegalArgumentException> {
            transcriber.transcribeDetailed(FloatArray(480001), "en")
        }
        assertTrue("30 s" in (lengthError.message ?: ""), lengthError.message ?: "no message")
    }

    @Test
    fun transcribesWithScriptedSessions() {
        val encoder = ScriptedSession(listOf("input_features"), listOf("last_hidden_state")) { _, _, outputs ->
            outputs.associateWith { FloatTensor(FloatArray(8), longArrayOf(1, 1, 8)) }
        }
        val names = mergedDecoderNames(config.decoderLayers)
        val decoder = ScriptedSession(names.first, names.second) { call, inputs, outputs ->
            val sequence = (inputs["input_ids"] as LongTensor).data.size
            val logits = FloatArray(sequence * VOCAB)
            val token = listOf(0, 1, 2)[call]
            logits[(sequence - 1) * VOCAB + token] = 1f
            val result = LinkedHashMap<String, org.ssa.assistant.models.onnx.Tensor>()
            for (name in outputs) {
                result[name] = if (name == "logits") {
                    FloatTensor(logits, longArrayOf(1, sequence.toLong(), VOCAB.toLong()))
                } else {
                    FloatTensor(FloatArray(1 * 2 * 1 * 4), longArrayOf(1, 2, 1, 4))
                }
            }
            result
        }
        val transcriber = WhisperTranscriber(encoder, decoder, tinyTokenizer(), config)

        var text = ""
        runBlockingTest { text = transcriber.transcribe(FloatArray(16000), "en") }
        assertEquals(" Yes.", text)
        assertEquals(1, encoder.calls.size)
        assertEquals(3, decoder.calls.size)
    }

    private fun transcriber(): WhisperTranscriber {
        val names = mergedDecoderNames(config.decoderLayers)
        val encoder = ScriptedSession(listOf("input_features"), listOf("last_hidden_state")) { _, _, outputs ->
            outputs.associateWith { FloatTensor(FloatArray(8), longArrayOf(1, 1, 8)) }
        }
        val decoder = ScriptedSession(names.first, names.second) { _, _, outputs ->
            outputs.associateWith { FloatTensor(FloatArray(0), longArrayOf(0)) }
        }
        return WhisperTranscriber(encoder, decoder, tinyTokenizer(), config)
    }

    private fun tinyTokenizer(): WhisperTokenizer {
        val tokenizerJson = """
            {
              "model": {
                "type": "BPE",
                "end_of_word_suffix": "",
                "vocab": { "ĠYes": 0, ".": 1 }
              },
              "decoder": { "type": "ByteLevel" },
              "added_tokens": [
                { "id": 2, "content": "<|endoftext|>", "special": true },
                { "id": 3, "content": "<|startoftranscript|>", "special": true },
                { "id": 4, "content": "<|notimestamps|>", "special": true }
              ]
            }
        """.trimIndent()
        val configJson = """
            {
              "clean_up_tokenization_spaces": true,
              "additional_special_tokens": [
                "<|endoftext|>", "<|startoftranscript|>", "<|notimestamps|>"
              ]
            }
        """.trimIndent()
        return WhisperTokenizer.fromJson(tokenizerJson, configJson)
    }

    private companion object {
        const val VOCAB = 8
    }
}
