package org.ssa.assistant.models.mms

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class Wav2Vec2FeaturesTest {
    @Test
    fun readsThePreprocessorConfig() {
        val features = Wav2Vec2Features.fromJson(
            """
            {
              "do_normalize": true,
              "feature_extractor_type": "Wav2Vec2FeatureExtractor",
              "feature_size": 1,
              "padding_side": "right",
              "padding_value": 0,
              "processor_class": "Wav2Vec2Processor",
              "return_attention_mask": true,
              "sampling_rate": 16000
            }
            """.trimIndent(),
        )
        assertEquals(16000, features.samplingRate)
        assertEquals(true, features.doNormalize)
        assertEquals(1, features.featureSize)
        assertEquals(0.0, features.paddingValue)
        assertEquals(true, features.returnAttentionMask)
        // NEP 50 casts the Python float 1e-7 to float32 as a double-to-float conversion.
        assertEquals((1e-7).toFloat().toRawBits(), features.epsilon.toRawBits())

        assertFailsWith<IllegalArgumentException> {
            Wav2Vec2Features.fromJson("""{"feature_extractor_type": "WhisperFeatureExtractor"}""")
        }
        assertFailsWith<IllegalArgumentException> {
            Wav2Vec2Features.fromJson("""{"feature_extractor_type": "Wav2Vec2FeatureExtractor", "feature_size": 2}""")
        }
    }

    @Test
    fun pairwiseSumUnderEightIsAPlainLoop() {
        // 2^24 + 1 rounds back to 2^24 in float32 (ties to even), so each 1 is lost in order.
        val big = 16_777_216f
        assertEquals(big, pairwiseSum(floatArrayOf(big, 1f, 1f)))
        assertEquals(6f, pairwiseSum(floatArrayOf(1f, 2f, 3f)))
        assertEquals(0f, pairwiseSum(FloatArray(0)))
    }

    @Test
    fun pairwiseSumUsesEightAccumulators() {
        // 16 values: r0 = 2^24 then + 1 (lost); r1..r7 = 1 + 1 = 2 each. The sum is
        // ((2^24 + 2) + (2 + 2)) + ((2 + 2) + (2 + 2)) = 2^24 + 14, every step exact; a plain
        // loop would lose all fifteen 1s.
        val big = 16_777_216f
        val values = FloatArray(16) { if (it == 0) big else 1f }
        assertEquals(big + 14f, pairwiseSum(values))
        var plain = 0f
        for (value in values) plain += value
        assertEquals(big, plain)
    }

    @Test
    fun normalizesAConstantClipToZero() {
        val features = Wav2Vec2Features()
        assertContentEquals(FloatArray(4), features.compute(FloatArray(4) { 0.5f }))
        val moments = features.moments(FloatArray(4) { 0.5f })
        assertEquals(0.5f, moments.mean)
        assertEquals(0f, moments.variance)
        assertEquals(kotlin.math.sqrt(features.epsilon), moments.denominator)
        assertFailsWith<IllegalArgumentException> { features.compute(FloatArray(0)) }
    }

    @Test
    fun withoutNormalizationTheSamplesPassThrough() {
        val samples = floatArrayOf(0.25f, -0.5f, 1f)
        val out = Wav2Vec2Features(doNormalize = false).compute(samples)
        assertContentEquals(samples, out)
        out[0] = 9f
        assertEquals(0.25f, samples[0], "compute must return a copy")
    }
}
