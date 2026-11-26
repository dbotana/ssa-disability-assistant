package org.ssa.assistant.models.mms

import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import kotlin.math.sqrt

/**
 * The MMS front end: 16 kHz mono float samples (Run 8, Decision 6) to the values of the
 * `[1, n]` `input_values` tensor.
 *
 * A port of transformers 4.53.3's `Wav2Vec2FeatureExtractor` for one clip with no padding, as
 * the ASR pipeline (pipelines/automatic_speech_recognition.py:453-458) and the
 * audio-classification pipeline (pipelines/audio_classification.py:215-217) call it
 * (Decision 4). In models/wav2vec2/feature_extraction_wav2vec2.py:
 *  - :199-219: a float32 array stays float32 (`pad` turns only float64 into float32,
 *    feature_extraction_sequence_utils.py:220-221);
 *  - :227-235: the padding strategy is DO_NOT_PAD, so no attention mask reaches the
 *    normalization, and :98 computes `(x - x.mean()) / np.sqrt(x.var() + 1e-7)`.
 *
 * That line in numpy 2.4.6 (numpy/_core/_methods.py), in float32 throughout:
 *  - `x.mean()`: :132 `umr_sum` (np.add.reduce, see [pairwiseSum]) in float32, then :142
 *    `ret.dtype.type(ret / rcount)`: float32 / intp promotes to float64 (NEP 50), and the
 *    quotient is rounded to float32;
 *  - `x.var()`: :168-183 the same mean, :188 `x - mean` and :190 its square in float32, :201
 *    their float32 pairwise sum, and :211 `float32(sum / n)` through float64 again;
 *  - `+ 1e-7`: a Python float is weak under NEP 50, so it is `float32(1e-7)` added in float32,
 *    and `np.sqrt` is the float32 square root;
 *  - `(x - mean) / denominator`: elementwise float32 subtraction and division.
 *
 * Run 9 checked this formula bit for bit against `Wav2Vec2FeatureExtractor(...)` on all 9 fixture
 * clips and their first 48,000 samples, in the export venv (see the Run 9 record).
 */
class Wav2Vec2Features(
    val samplingRate: Int = 16000,
    val doNormalize: Boolean = true,
    /** The `1e-7` of feature_extraction_wav2vec2.py:98, as NEP 50 casts a Python float: double to float32. */
    val epsilon: Float = 1e-7.toFloat(),
    val featureSize: Int = 1,
    val paddingValue: Double = 0.0,
    val returnAttentionMask: Boolean = true,
) {
    init {
        require(featureSize == 1) { "Wav2Vec2 takes mono audio (feature_size 1), not feature_size $featureSize" }
        require(samplingRate > 0) { "sampling_rate must be positive, got $samplingRate" }
    }

    /** The normalized clip: as many values as [samples], or a copy of it when [doNormalize] is off. */
    fun compute(samples: FloatArray): FloatArray {
        if (!doNormalize) return samples.copyOf()
        val moments = moments(samples)
        val centered = moments.centered
        val denominator = moments.denominator
        return FloatArray(centered.size) { centered[it] / denominator }
    }

    /** The float32 statistics [compute] uses, and the centred clip. */
    internal fun moments(samples: FloatArray): Wav2Vec2Moments {
        require(samples.isNotEmpty()) { "Wav2Vec2 normalization needs at least one sample" }
        val n = samples.size
        // _methods.py:132,142: float32(float64(sum) / n).
        val mean = (pairwiseSum(samples).toDouble() / n.toDouble()).toFloat()
        // _methods.py:188-190: subtract, then square into a separate array, as numpy does.
        // Squaring first and summing afterwards also keeps the compiler from fusing x*x + acc.
        val centered = FloatArray(n) { samples[it] - mean }
        val squares = FloatArray(n) { centered[it] * centered[it] }
        // _methods.py:201,211.
        val variance = (pairwiseSum(squares).toDouble() / n.toDouble()).toFloat()
        val denominator = sqrt(variance + epsilon)
        return Wav2Vec2Moments(mean, variance, sqrt(variance), denominator, centered)
    }

    companion object {
        /** Reads `preprocessor_config.json`; only `Wav2Vec2FeatureExtractor` with mono audio. */
        fun fromJson(preprocessorConfigJson: String): Wav2Vec2Features {
            val root = JsonParser.parse(preprocessorConfigJson).asObject()
                ?: throw IllegalArgumentException("preprocessor_config.json is not a JSON object")
            val type = root["feature_extractor_type"]?.asString()
            if (type != "Wav2Vec2FeatureExtractor") {
                throw IllegalArgumentException(
                    "preprocessor_config.json has feature_extractor_type $type, not Wav2Vec2FeatureExtractor",
                )
            }
            fun number(key: String, default: Double): Double = when (val value = root[key]) {
                null -> default
                else -> value.asDouble()
                    ?: throw IllegalArgumentException("preprocessor_config.json's $key is not a number")
            }
            fun int(key: String, default: Int): Int {
                val value = number(key, default.toDouble())
                require(value == value.toInt().toDouble()) { "preprocessor_config.json's $key is not an integer" }
                return value.toInt()
            }
            fun bool(key: String, default: Boolean): Boolean = when (val value = root[key]) {
                null -> default
                else -> value.asBoolean()
                    ?: throw IllegalArgumentException("preprocessor_config.json's $key is not a boolean")
            }
            // The defaults are Wav2Vec2FeatureExtractor.__init__'s (feature_extraction_wav2vec2.py:67-75).
            return Wav2Vec2Features(
                samplingRate = int("sampling_rate", 16000),
                doNormalize = bool("do_normalize", true),
                featureSize = int("feature_size", 1),
                paddingValue = number("padding_value", 0.0),
                returnAttentionMask = bool("return_attention_mask", false),
            )
        }
    }
}

/** The float32 values of feature_extraction_wav2vec2.py:98 for one clip. */
internal class Wav2Vec2Moments(
    val mean: Float,
    /** The population variance, `x.var()`. */
    val variance: Float,
    /** `x.std()`: the float32 square root of [variance] (_methods.py:217-225), without epsilon. */
    val std: Float,
    /** `np.sqrt(x.var() + 1e-7)`, what each centred value is divided by. */
    val denominator: Float,
    /** `x - x.mean()`, in float32. */
    val centered: FloatArray,
)

/**
 * `np.add.reduce` over a contiguous float32 vector, as numpy 2.4.6 computes it: the identity
 * `0.0f` plus ONE pairwise sum over all [count] values, with no splitting into buffer-sized
 * blocks. Run 9 found this rule bit-exact against `np.sum` on 3,315 random float32 arrays of
 * lengths 1 to 300,000; seeding with the first element, or summing 8,192-value blocks, was not.
 */
internal fun pairwiseSum(values: FloatArray, offset: Int = 0, count: Int = values.size - offset): Float {
    require(offset >= 0 && count >= 0 && offset + count <= values.size) {
        "pairwiseSum range $offset+$count is outside an array of ${values.size}"
    }
    return 0f + pairwise(values, offset, count)
}

/**
 * numpy's `FLOAT_pairwise_sum` (umath/loops_utils.h.src), with float32 accumulators:
 *  - under 8 values, a plain loop from `0.0f`;
 *  - up to 128 (PW_BLOCKSIZE), eight accumulators seeded with the first eight values and
 *    advanced 8 at a time, combined as `((r0+r1)+(r2+r3))+((r4+r5)+(r6+r7))`, then the
 *    remainder added one by one;
 *  - otherwise split at `n2 = n/2 - (n/2) % 8` and the two halves' sums added.
 */
private fun pairwise(a: FloatArray, lo: Int, n: Int): Float {
    if (n < 8) {
        var res = 0f
        for (i in 0 until n) res += a[lo + i]
        return res
    }
    if (n <= 128) {
        var r0 = a[lo]
        var r1 = a[lo + 1]
        var r2 = a[lo + 2]
        var r3 = a[lo + 3]
        var r4 = a[lo + 4]
        var r5 = a[lo + 5]
        var r6 = a[lo + 6]
        var r7 = a[lo + 7]
        val unrolled = n - n % 8
        var i = 8
        while (i < unrolled) {
            val p = lo + i
            r0 += a[p]
            r1 += a[p + 1]
            r2 += a[p + 2]
            r3 += a[p + 3]
            r4 += a[p + 4]
            r5 += a[p + 5]
            r6 += a[p + 6]
            r7 += a[p + 7]
            i += 8
        }
        var res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7))
        while (i < n) {
            res += a[lo + i]
            i++
        }
        return res
    }
    var n2 = n / 2
    n2 -= n2 % 8
    return pairwise(a, lo, n2) + pairwise(a, lo + n2, n - n2)
}
