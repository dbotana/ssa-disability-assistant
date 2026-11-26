package org.ssa.assistant.models.mms

import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.testing.ScriptedSession
import org.ssa.assistant.models.testing.runBlockingTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MmsLanguageIdTest {
    /** Five labels, three of them the candidates, in an order unlike the candidates'. */
    private val labels = listOf("ara", "eng", "fra", "lin", "spa")
    private val events = mutableListOf<String>()
    private val opened = mutableListOf<ScriptedSession>()

    private fun languageId(
        logits: FloatArray,
        minProbability: Double = 0.0,
        width: Int = labels.size,
    ) = MmsLanguageId(
        open = {
            events += "open"
            val scripted = ScriptedSession(listOf("input_values"), listOf("logits")) { _, _, _ ->
                mapOf("logits" to FloatTensor(logits.copyOf(), longArrayOf(1, width.toLong())))
            }
            opened += scripted
            CountingSession(scripted) { events += "close" }
        },
        labels = labels,
        features = Wav2Vec2Features(),
        minProbability = minProbability,
    )

    @Test
    fun seesOnlyTheFirstThreeSecondsNormalizedOnTheirOwn() {
        // A quiet first 3 s and a loud rest: normalizing the whole clip and then cutting it
        // would give other values.
        val clip = FloatArray(64_000) { if (it < 48_000) (if (it % 2 == 0) 0.1f else -0.05f) else 0.9f }
        val id = languageId(FloatArray(labels.size))
        val result = id.detectDetailed(clip)
        val input = opened.single().calls.single().inputs.getValue("input_values") as FloatTensor
        assertEquals(listOf(1L, 48_000L), input.shape.toList())
        val expected = Wav2Vec2Features().compute(clip.copyOf(48_000))
        assertContentEquals(expected, input.data)
        assertFalse(expected.contentEquals(Wav2Vec2Features().compute(clip).copyOf(48_000)))
        assertEquals(48_000, result.samples)
        assertEquals(listOf("logits"), opened.single().calls.single().outputs)
    }

    @Test
    fun aShorterClipIsSeenWhole() {
        val clip = FloatArray(16_000) { (it % 5) / 5f }
        languageId(FloatArray(labels.size)).detectDetailed(clip)
        val input = opened.single().calls.single().inputs.getValue("input_values") as FloatTensor
        assertEquals(listOf(1L, 16_000L), input.shape.toList())
        assertContentEquals(Wav2Vec2Features().compute(clip), input.data)
    }

    @Test
    fun theSoftmaxIsOverAllLabelsAndOnlyTheCandidatesCount() {
        // Equal logits: each of the five labels has probability 1/5, so the candidates' are
        // 1/5 too, not 1/3, and the first candidate wins the tie.
        val even = languageId(FloatArray(labels.size)).detectDetailed(FloatArray(1600) { it / 1600f })
        assertEquals(mapOf("lin" to 0.2, "fra" to 0.2, "eng" to 0.2), even.probabilities)
        assertEquals("ara", even.topLabel)
        assertEquals("lin", even.bestLabel)
        assertEquals("ln", even.code)

        // Arabic is the top label overall, but only lin, fra and eng count.
        val logits = floatArrayOf(9f, 1f, 3f, 2f, 8f)
        val result = languageId(logits).detectDetailed(FloatArray(1600) { it / 1600f })
        assertEquals("ara", result.topLabel)
        assertEquals("fra", result.bestLabel)
        assertEquals("fr", result.code)
        assertContentEquals(logits, result.logits)
        assertTrue(result.bestProbability < 0.5, "the softmax counts the other labels")
    }

    @Test
    fun mapsEachCandidateToItsCode() {
        val clip = FloatArray(1600) { it / 1600f }
        assertEquals("en", languageId(floatArrayOf(0f, 5f, 0f, 0f, 0f)).detectDetailed(clip).code)
        assertEquals("fr", languageId(floatArrayOf(0f, 0f, 5f, 0f, 0f)).detectDetailed(clip).code)
        assertEquals("ln", languageId(floatArrayOf(0f, 0f, 0f, 5f, 0f)).detectDetailed(clip).code)
    }

    @Test
    fun belowTheThresholdIsNull() {
        val clip = FloatArray(1600) { it / 1600f }
        // Every candidate at exactly 1/5.
        assertNull(languageId(FloatArray(labels.size), minProbability = 0.5).detectDetailed(clip).code)
        assertEquals("ln", languageId(FloatArray(labels.size), minProbability = 0.2).detectDetailed(clip).code)
        var detected: String? = "unset"
        runBlockingTest { detected = languageId(FloatArray(labels.size), minProbability = 0.5).detect(clip) }
        assertNull(detected)
    }

    @Test
    fun opensOnceAndClosesOnRequest() {
        val id = languageId(FloatArray(labels.size))
        val clip = FloatArray(1600) { it / 1600f }
        assertFalse(id.isOpen)
        id.detectDetailed(clip)
        id.detectDetailed(clip)
        assertEquals(listOf("open"), events)
        id.close()
        assertEquals(listOf("open", "close"), events)
        id.detectDetailed(clip)
        assertEquals(listOf("open", "close", "open"), events)
    }

    @Test
    fun refusesBadSettingsAndAWrongOutput() {
        assertFailsWith<IllegalArgumentException> { languageId(FloatArray(5), minProbability = 1.5) }
        assertFailsWith<IllegalArgumentException> { languageId(FloatArray(5), minProbability = Double.NaN) }
        assertFailsWith<IllegalArgumentException> {
            MmsLanguageId(open = { error("not opened") }, labels = listOf("ara", "eng"), features = Wav2Vec2Features(), minProbability = 0.0)
        }
        val narrow = languageId(FloatArray(4), width = 4)
        assertFailsWith<IllegalStateException> { narrow.detectDetailed(FloatArray(1600) { it / 1600f }) }
        assertFailsWith<IllegalArgumentException> { languageId(FloatArray(5)).detectDetailed(FloatArray(0)) }
    }
}
