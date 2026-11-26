package org.ssa.assistant.models.mms

import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.OnnxSession
import org.ssa.assistant.models.onnx.Tensor
import org.ssa.assistant.models.testing.ScriptedSession
import org.ssa.assistant.models.testing.runBlockingTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class MmsTranscriberTest {
    /** `<pad>` 0 (the blank), `|` 1, `a` 2, `b` 3. */
    private val tokenizer = CtcTokenizer.fromJson(
        """{"<pad>": 0, "|": 1, "a": 2, "b": 3}""",
        """{"pad_token": "<pad>", "word_delimiter_token": "|", "clean_up_tokenization_spaces": true}""",
    )
    private val events = mutableListOf<String>()
    private val sessions = mutableMapOf<String, MutableList<ScriptedSession>>()

    /** Frames whose argmax ids are [ids], over a [vocab]-wide vocabulary. */
    private fun logitsFor(ids: IntArray, vocab: Int = 4): FloatTensor {
        val data = FloatArray(ids.size * vocab)
        for ((frame, id) in ids.withIndex()) data[frame * vocab + id] = 1f
        return FloatTensor(data, longArrayOf(1, ids.size.toLong(), vocab.toLong()))
    }

    private fun graph(
        code: String,
        ids: IntArray = intArrayOf(0, 2, 2, 0, 1, 3, 0),
        vocab: Int = 4,
        inputNames: List<String> = listOf("input_values"),
    ) = MmsGraph(
        code = code,
        open = {
            events += "open $code"
            val scripted = ScriptedSession(inputNames, listOf("logits")) { _, _, _ -> mapOf("logits" to logitsFor(ids, vocab)) }
            sessions.getOrPut(code) { mutableListOf() } += scripted
            CountingSession(scripted) { events += "close $code" }
        },
        tokenizer = tokenizer,
    )

    @Test
    fun feedsTheNormalizedClipAndDecodesTheLogits() {
        val transcriber = MmsTranscriber(listOf(graph("ln")), Wav2Vec2Features())
        val samples = FloatArray(1600) { if (it % 2 == 0) 0.25f else -0.125f }
        var seen: FloatTensor? = null
        val result = transcriber.transcribeDetailed(samples, "ln") { seen = it }

        val call = sessions.getValue("ln").single().calls.single()
        assertEquals(listOf("input_values"), call.inputs.keys.toList())
        assertEquals(listOf("logits"), call.outputs)
        val input = call.inputs.getValue("input_values") as FloatTensor
        assertEquals(listOf(1L, 1600L), input.shape.toList())
        assertContentEquals(Wav2Vec2Features().compute(samples), input.data)

        assertSame(call.result["logits"], seen)
        assertContentEquals(intArrayOf(0, 2, 2, 0, 1, 3, 0), result.frameIds)
        assertContentEquals(intArrayOf(2, 1, 3), result.ids)
        assertEquals("a b", result.text)
    }

    @Test
    fun switchingLanguageClosesTheOldGraphFirst() {
        val transcriber = MmsTranscriber(listOf(graph("ln"), graph("fr"), graph("en")), Wav2Vec2Features())
        val clip = FloatArray(800) { (it % 7) / 7f }
        assertNull(transcriber.openLanguage)
        transcriber.transcribeDetailed(clip, "ln")
        transcriber.transcribeDetailed(clip, "ln")
        assertEquals("ln", transcriber.openLanguage)
        transcriber.transcribeDetailed(clip, "fr")
        transcriber.transcribeDetailed(clip, "fr")
        transcriber.transcribeDetailed(clip, "ln")
        assertEquals(listOf("open ln", "close ln", "open fr", "close fr", "open ln"), events)
        assertEquals(2, sessions.getValue("ln").size)
        assertEquals(2, sessions.getValue("ln")[0].calls.size)
        assertEquals(2, sessions.getValue("fr").single().calls.size)
        assertEquals(listOf("ln", "fr", "en"), transcriber.languages)

        transcriber.close()
        assertEquals("close ln", events.last())
        assertNull(transcriber.openLanguage)
    }

    @Test
    fun refusesAnUnknownLanguageAndLongClipsBeforeOpeningAnything() {
        val transcriber = MmsTranscriber(listOf(graph("ln"), graph("fr")), Wav2Vec2Features())
        val unknown = assertFailsWith<IllegalArgumentException> { transcriber.transcribeDetailed(FloatArray(1600), "de") }
        assertTrue("de" in (unknown.message ?: ""), unknown.message ?: "no message")
        val long = assertFailsWith<IllegalArgumentException> {
            transcriber.transcribeDetailed(FloatArray(MmsTranscriber.MAX_SAMPLES + 1) { 0.1f * (it % 3) }, "ln")
        }
        assertTrue("30 s" in (long.message ?: ""), long.message ?: "no message")
        assertEquals(emptyList<String>(), events)

        // Exactly 30 s is accepted.
        transcriber.transcribeDetailed(FloatArray(MmsTranscriber.MAX_SAMPLES) { 0.1f * (it % 3) }, "ln")
        assertEquals(listOf("open ln"), events)
    }

    @Test
    fun refusesLogitsWiderOrNarrowerThanTheVocabulary() {
        val transcriber = MmsTranscriber(listOf(graph("ln", ids = intArrayOf(0, 1), vocab = 5)), Wav2Vec2Features())
        val error = assertFailsWith<IllegalStateException> { transcriber.transcribeDetailed(FloatArray(1600) { it / 1600f }, "ln") }
        assertTrue("vocabulary" in (error.message ?: ""), error.message ?: "no message")
    }

    @Test
    fun refusesAGraphWithOtherInputsAndClosesIt() {
        val transcriber = MmsTranscriber(
            listOf(graph("ln", inputNames = listOf("input_values", "attention_mask"))),
            Wav2Vec2Features(),
        )
        val error = assertFailsWith<IllegalArgumentException> { transcriber.transcribeDetailed(FloatArray(1600) { it / 1600f }, "ln") }
        assertTrue("input_values" in (error.message ?: ""), error.message ?: "no message")
        assertEquals(listOf("open ln", "close ln"), events)
        assertNull(transcriber.openLanguage)
    }

    @Test
    fun refusesTwoGraphsForOneLanguage() {
        assertFailsWith<IllegalArgumentException> { MmsTranscriber(listOf(graph("ln"), graph("ln")), Wav2Vec2Features()) }
    }

    @Test
    fun transcribeReturnsTheRawText() {
        val transcriber = MmsTranscriber(listOf(graph("en", ids = intArrayOf(2, 0, 2, 1, 1, 3))), Wav2Vec2Features())
        var text = ""
        runBlockingTest { text = transcriber.transcribe(FloatArray(1600) { it / 1600f }, "en") }
        assertEquals("aa b", text)
    }
}

/** An [OnnxSession] that reports its close, over a [ScriptedSession]. */
internal class CountingSession(
    private val inner: ScriptedSession,
    private val onClose: () -> Unit,
) : OnnxSession by inner {
    override fun run(inputs: Map<String, Tensor>, outputs: List<String>): Map<String, Tensor> = inner.run(inputs, outputs)

    override fun close() = onClose()
}
