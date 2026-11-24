package org.ssa.assistant.models.whisper

import org.ssa.assistant.models.onnx.BoolTensor
import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.LongTensor
import org.ssa.assistant.models.onnx.OnnxSession
import org.ssa.assistant.models.onnx.Tensor
import org.ssa.assistant.models.testing.ScriptedSession
import org.ssa.assistant.models.testing.mergedDecoderNames
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.test.assertTrue

class WhisperDecoderTest {
    private val config = WhisperConfig(
        prompt = listOf(50257, 50362),
        eosTokenId = 50256,
        maxLength = 448,
        beginSuppressTokens = listOf(220, 50256),
        decoderLayers = 2,
        decoderHeads = 2,
        encoderHeads = 2,
        dModel = 8,
    )
    private val names = mergedDecoderNames(config.decoderLayers)
    private val inputNames = names.first
    private val outputNames = names.second
    private val decoderPresents = outputNames.filter { ".decoder." in it }
    private val hidden = FloatTensor(FloatArray(8), longArrayOf(1, 1, 8))

    @Test
    fun wiresThePromptAndCache() {
        val tokens = listOf(3363, 13, config.eosTokenId)
        val session = scriptedSession(tokens, decoyInRowZero = true)
        val ids = WhisperDecoder(session, config).generate(hidden)
        assertEquals(listOf(50257L, 50362L, 3363L, 13L, 50256L), ids.toList())
        assertEquals(3, session.calls.size)

        val first = session.calls[0]
        val firstIds = first.inputs["input_ids"] as LongTensor
        assertShape(firstIds, 1, 2)
        assertEquals(listOf(50257L, 50362L), firstIds.data.toList())
        assertEquals(listOf(false), (first.inputs["use_cache_branch"] as BoolTensor).data.toList())
        assertSame(hidden, first.inputs["encoder_hidden_states"])
        for (i in 0 until config.decoderLayers) {
            for (part in listOf("decoder.key", "decoder.value", "encoder.key", "encoder.value")) {
                val past = first.inputs["past_key_values.$i.$part"] as FloatTensor
                assertShape(past, 1, 2, 0, 4)
                assertEquals(0, past.data.size)
            }
        }
        assertEquals(outputNames, first.outputs)

        for (callIndex in 1..2) {
            val call = session.calls[callIndex]
            val oneId = call.inputs["input_ids"] as LongTensor
            assertShape(oneId, 1, 1)
            assertEquals(listOf(tokens[callIndex - 1].toLong()), oneId.data.toList())
            assertEquals(listOf(true), (call.inputs["use_cache_branch"] as BoolTensor).data.toList())
            assertSame(hidden, call.inputs["encoder_hidden_states"])
            assertEquals(listOf("logits") + decoderPresents, call.outputs)

            for (i in 0 until config.decoderLayers) {
                for (part in listOf("decoder.key", "decoder.value")) {
                    val presentName = "present.$i.$part"
                    val pastName = "past_key_values.$i.$part"
                    assertSame(
                        session.calls[callIndex - 1].result[presentName],
                        call.inputs[pastName],
                        "$pastName must be the previous step's $presentName",
                    )
                }
                for (part in listOf("encoder.key", "encoder.value")) {
                    val presentName = "present.$i.$part"
                    val pastName = "past_key_values.$i.$part"
                    assertSame(
                        first.result[presentName],
                        call.inputs[pastName],
                        "$pastName must stay at the first step's $presentName",
                    )
                }
            }
        }
    }

    @Test
    fun suppressesBeginTokensOnlyAtTheFirstGeneratedPosition() {
        val positions = mutableListOf<Int>()
        val firstScores = mutableListOf<Float>()
        val session = ScriptedSession(inputNames, outputNames) { call, inputs, outputs ->
            val sequence = (inputs["input_ids"] as LongTensor).data.size
            val data = FloatArray(sequence * VOCAB)
            when (call) {
                0 -> {
                    data[(sequence - 1) * VOCAB + 220] = 5f
                    data[(sequence - 1) * VOCAB + 50256] = 4f
                    data[(sequence - 1) * VOCAB + 9] = 3f
                }
                1 -> data[(sequence - 1) * VOCAB + 220] = 2f
                else -> data[(sequence - 1) * VOCAB + 50256] = 1f
            }
            resultWithPresents(data, sequence, call, outputs)
        }
        val ids = WhisperDecoder(session, config).generate(hidden) { position, scores ->
            positions += position
            if (firstScores.isEmpty()) firstScores += scores.toList()
        }
        assertEquals(listOf(50257L, 50362L, 9L, 220L, 50256L), ids.toList())
        assertEquals(listOf(2, 3, 4), positions)
        assertTrue(firstScores[220].isInfinite() && firstScores[220] < 0f, "220 must be -Infinity")
        assertTrue(firstScores[50256].isInfinite() && firstScores[50256] < 0f, "eos must be -Infinity")
        assertEquals(3f, firstScores[9])
    }

    @Test
    fun stopsAtEosWithoutAnotherCall() {
        val session = scriptedSession(listOf(11, config.eosTokenId), decoyInRowZero = false)
        val ids = WhisperDecoder(session, config).generate(hidden)
        assertEquals(listOf(50257L, 50362L, 11L, 50256L), ids.toList())
        assertEquals(2, session.calls.size)
    }

    @Test
    fun stopsAtMaxLength() {
        val session = scriptedSession(List(446) { 11 }, decoyInRowZero = false)
        val ids = WhisperDecoder(session, config).generate(hidden)
        assertEquals(448, ids.size)
        assertEquals(11L, ids.last())
        assertEquals(446, session.calls.size)
    }

    @Test
    fun argmaxKeepsTheFirstMaximum() {
        val tie = FloatArray(41)
        tie[30] = 1f
        tie[40] = 1f
        assertEquals(30, argmaxFirst(tie))
        assertEquals(0, argmaxFirst(FloatArray(8)))
        val nanFirst = FloatArray(3) { Float.NaN }
        assertEquals(0, argmaxFirst(nanFirst))
        val nanLater = floatArrayOf(0f, 0f, 0f, Float.NaN, 0f, 2f)
        assertEquals(5, argmaxFirst(nanLater))
        val oneFinite = FloatArray(6) { Float.NEGATIVE_INFINITY }
        oneFinite[4] = 0f
        assertEquals(4, argmaxFirst(oneFinite))
    }

    @Test
    fun rejectsASessionWithoutTheCacheBranchInput() {
        val missingNames = inputNames.filter { it != "use_cache_branch" }
        val session = object : OnnxSession {
            override val inputNames: List<String> = missingNames
            override val outputNames: List<String> = this@WhisperDecoderTest.outputNames
            override fun run(inputs: Map<String, Tensor>, outputs: List<String>): Map<String, Tensor> =
                throw AssertionError("the decoder must reject the session before running it")
            override fun close() = Unit
        }
        val error = assertFailsWith<IllegalArgumentException> { WhisperDecoder(session, config) }
        assertTrue("use_cache_branch" in (error.message ?: ""), error.message ?: "no message")
    }

    private fun scriptedSession(
        tokens: List<Int>,
        decoyInRowZero: Boolean,
    ): ScriptedSession = ScriptedSession(inputNames, outputNames) { call, inputs, outputs ->
        val sequence = (inputs["input_ids"] as LongTensor).data.size
        val data = FloatArray(sequence * VOCAB)
        if (decoyInRowZero && sequence == 2) data[7] = 10f
        data[(sequence - 1) * VOCAB + tokens[call]] = 1f
        resultWithPresents(data, sequence, call, outputs)
    }

    private fun resultWithPresents(
        logits: FloatArray,
        sequence: Int,
        call: Int,
        outputs: List<String>,
    ): Map<String, Tensor> {
        val result = LinkedHashMap<String, Tensor>()
        for (name in outputs) {
            result[name] = if (name == "logits") {
                FloatTensor(logits, longArrayOf(1, sequence.toLong(), VOCAB.toLong()))
            } else {
                FloatTensor(
                    FloatArray(1 * 2 * 1 * 4) { (call + 1).toFloat() },
                    longArrayOf(1, 2, 1, 4),
                )
            }
        }
        return result
    }

    private fun assertShape(tensor: Tensor, vararg dims: Long) {
        assertEquals(dims.toList(), tensor.shape.toList())
    }

    private companion object {
        const val VOCAB = 51864
    }
}
