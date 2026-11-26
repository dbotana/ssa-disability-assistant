package org.ssa.assistant.models.mms

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CtcGreedyTest {
    @Test
    fun tiesTakeTheFirstIndex() {
        assertContentEquals(intArrayOf(1), CtcGreedy.argmax(floatArrayOf(1f, 3f, 3f, 0f), frames = 1, vocab = 4))
        assertContentEquals(intArrayOf(0), CtcGreedy.argmax(FloatArray(5), frames = 1, vocab = 5))
        // -0.0 and 0.0 compare equal, so the first is kept.
        assertContentEquals(intArrayOf(0), CtcGreedy.argmax(floatArrayOf(-0f, 0f), frames = 1, vocab = 2))
        val allNegativeInfinity = FloatArray(3) { Float.NEGATIVE_INFINITY }
        assertContentEquals(intArrayOf(0), CtcGreedy.argmax(allNegativeInfinity, frames = 1, vocab = 3))
    }

    @Test
    fun theFirstNanWins() {
        val nan = Float.NaN
        assertContentEquals(intArrayOf(1), CtcGreedy.argmax(floatArrayOf(1f, nan, 5f, nan), frames = 1, vocab = 4))
        assertContentEquals(intArrayOf(0), CtcGreedy.argmax(floatArrayOf(nan, 1f, 5f), frames = 1, vocab = 3))
        assertContentEquals(intArrayOf(3), CtcGreedy.argmax(floatArrayOf(0f, 9f, 2f, nan), frames = 1, vocab = 4))
    }

    @Test
    fun takesOneArgmaxPerFrame() {
        val logits = floatArrayOf(
            0f, 2f, 1f,
            5f, 0f, 0f,
            0f, 0f, 7f,
            1f, 1f, 1f,
        )
        assertContentEquals(intArrayOf(1, 0, 2, 0), CtcGreedy.argmax(logits, frames = 4, vocab = 3))
        assertContentEquals(IntArray(0), CtcGreedy.argmax(FloatArray(0), frames = 0, vocab = 3))
        assertFailsWith<IllegalArgumentException> { CtcGreedy.argmax(logits, frames = 3, vocab = 3) }
    }

    @Test
    fun collapseMergesRepeatsBeforeDroppingBlanks() {
        // A repeat merges; a repeat across a blank stays two tokens; blanks go.
        assertContentEquals(intArrayOf(5, 5, 6), CtcGreedy.collapse(intArrayOf(0, 5, 5, 0, 5, 6, 6, 0), blank = 0))
        assertContentEquals(intArrayOf(7), CtcGreedy.collapse(intArrayOf(7, 7, 7), blank = 0))
        assertContentEquals(IntArray(0), CtcGreedy.collapse(intArrayOf(0, 0, 0), blank = 0))
        assertContentEquals(IntArray(0), CtcGreedy.collapse(IntArray(0), blank = 0))
        assertContentEquals(intArrayOf(1, 1), CtcGreedy.collapse(intArrayOf(1, 2, 1), blank = 2))
    }

    @Test
    fun anAllBlankClipDecodesToNothing() {
        val tokenizer = CtcTokenizer.fromJson(
            """{"<pad>": 0, "|": 1, "a": 2}""",
            """{"pad_token": "<pad>", "word_delimiter_token": "|", "clean_up_tokenization_spaces": true}""",
        )
        val logits = FloatArray(4 * 3)
        for (frame in 0 until 4) logits[frame * 3] = 1f
        val frameIds = CtcGreedy.argmax(logits, frames = 4, vocab = 3)
        assertContentEquals(intArrayOf(0, 0, 0, 0), frameIds)
        assertContentEquals(IntArray(0), CtcGreedy.collapse(frameIds, tokenizer.blankId))
        assertEquals("", tokenizer.decode(frameIds))
    }

    @Test
    fun topGapsAreTopOneMinusTopTwo() {
        val logits = floatArrayOf(
            1f, 3f, 3f, 0f,
            1f, 5f, 2f, 0f,
            -1f, -4f, -2f, -3f,
            0f, Float.NaN, 9f, 1f,
        )
        val gaps = CtcGreedy.topGaps(logits, frames = 4, vocab = 4)
        assertEquals(0f, gaps[0])
        assertEquals(3f, gaps[1])
        assertEquals(1f, gaps[2])
        assertTrue(gaps[3].isNaN(), "a frame holding a NaN has a NaN gap")
    }
}
