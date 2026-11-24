package org.ssa.assistant.models.whisper

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/**
 * Whisper's log-mel front end: 16 kHz mono samples to the `[1, 80, 3000]`
 * `input_features` tensor.
 *
 * A port of transformers.js 3.8.1's WhisperFeatureExtractor
 * (models/whisper/feature_extraction_whisper.js:8-57) and the audio helpers it
 * calls (utils/audio.js). Every formula below names the reference line it
 * copies, because the golden's feature matrix is only matched if they agree
 * value for value.
 */
class WhisperFeatures(
    val samplingRate: Int = 16000,
    val nFft: Int = 400,
    val hopLength: Int = 160,
    val nSamples: Int = 480000,
    val nbMaxFrames: Int = 3000,
    val featureSize: Int = 80,
) {
    /**
     * The analysis window: `window_function(400, 'hann')`, periodic
     * (audio.js:703-738), which is `generalized_cosine_window(401, 0.5)` with
     * its last value dropped (audio.js:89-105).
     */
    val window: DoubleArray = hannPeriodic(nFft)

    /**
     * `mel_filter_bank(201, 80, 0, 8000, 16000, 'slaney', 'slaney')`
     * (audio.js:131-305). preprocessor_config.json pins no `mel_filters`, so the
     * reference computes them, and so do we.
     */
    val melFilters: Array<DoubleArray> =
        melFilterBankSlaney(nFft / 2 + 1, featureSize, 0.0, 8000.0, samplingRate)

    // The reference hands the filter bank to ORT as float32, so its values are
    // rounded before the matrix product (Decision 2).
    private val melFilters32 = Array(featureSize) { m -> FloatArray(nFft / 2 + 1) { melFilters[m][it].toFloat() } }

    /**
     * The log-mel spectrogram of [samples], index = `mel * nbMaxFrames + frame`
     * (featureSize * nbMaxFrames values for the default configuration).
     */
    fun compute(samples: FloatArray): FloatArray {
        require(samples.size <= nSamples) {
            "Whisper takes at most 30 s of audio ($nSamples samples at $samplingRate Hz); " +
                "this clip has ${samples.size} samples, and chunking is not implemented"
        }

        // feature_extraction_whisper.js:66-79: zero-pad (or cut) to n_samples.
        val waveform = FloatArray(nSamples)
        samples.copyInto(waveform)

        // audio.js:505-509: reflect padding of floor((fft_length - 1) / 2) + 1
        // on each side, then frame at hop_length.
        val half = (nFft - 1) / 2 + 1
        val padded = padReflect(waveform, half, half)
        val numFrames = 1 + (padded.size - nFft) / hopLength
        val maxNumFrames = min(nSamples / hopLength, nbMaxFrames)
        var d1 = numFrames
        var d1Max = numFrames
        if (maxNumFrames > numFrames) {
            d1Max = maxNumFrames
        } else {
            d1 = maxNumFrames
            d1Max = maxNumFrames
        }

        val bins = nFft / 2 + 1
        val power = FloatArray(bins * d1Max)
        val fft = MixedRadixFft(nFft)
        val re = DoubleArray(nFft)
        val im = DoubleArray(nFft)
        val outRe = DoubleArray(nFft)
        val outIm = DoubleArray(nFft)

        for (i in 0 until d1) {
            val offset = i * hopLength
            val size = min(padded.size - offset, nFft)
            var nonZero = false
            for (j in 0 until nFft) {
                val v = if (j < size) padded[offset + j].toDouble() else 0.0
                if (v != 0.0) nonZero = true
                re[j] = v * window[j]
                im[j] = 0.0
            }
            // A frame of zeros has a spectrum of exactly zero, which `power`
            // already holds, so the transform can be skipped.
            if (!nonZero) continue
            fft.transform(re, im, outRe, outIm)
            for (j in 0 until bins) {
                // float64 FFT, power re²+im² stored as float32 (audio.js:600-608).
                power[j * d1Max + i] = (outRe[j] * outRe[j] + outIm[j] * outIm[j]).toFloat()
            }
        }

        // mel_spec = float32(mel_filters) @ float32(power), accumulated in
        // double and rounded to float — a few ulp from ORT's float32 MatMul
        // (Decision 2).
        val mel = FloatArray(featureSize * d1Max)
        for (m in 0 until featureSize) {
            val acc = DoubleArray(d1Max)
            for (j in 0 until bins) {
                val weight = melFilters32[m][j].toDouble()
                if (weight == 0.0) continue
                val rowOffset = j * d1Max
                for (f in 0 until d1Max) acc[f] += weight * power[rowOffset + f]
            }
            for (f in 0 until d1Max) mel[m * d1Max + f] = acc[f].toFloat()
        }

        // audio.js:641-645: max(1e-10, x), then log10 over the first
        // d1 * featureSize values, then the reference's dynamic-range squeeze
        // ((max(x, max - 8) + 4) / 4) over every value
        // (feature_extraction_whisper.js:50-56).
        for (k in mel.indices) mel[k] = max(1e-10, mel[k].toDouble()).toFloat()
        val logCount = min(mel.size, d1 * featureSize)
        for (k in 0 until logCount) mel[k] = log10(mel[k].toDouble()).toFloat()

        var maxValue = mel[0]
        for (k in 1 until mel.size) if (mel[k] > maxValue) maxValue = mel[k]
        val floor = maxValue.toDouble() - 8.0
        for (k in mel.indices) {
            mel[k] = ((max(mel[k].toDouble(), floor) + 4.0) / 4.0).toFloat()
        }
        return mel
    }

    companion object {
        /**
         * Reads preprocessor_config.json. A `mel_filters` key is rejected: the
         * pinned packs have none, so accepting one would silently change the
         * front end this port has been checked against (Decision 10).
         */
        fun fromJson(preprocessorConfigJson: String): WhisperFeatures {
            val root = JsonParser.parse(preprocessorConfigJson).asObject()
                ?: throw IllegalArgumentException("preprocessor_config.json is not a JSON object")
            if (root.entries.containsKey("mel_filters")) {
                throw UnsupportedOperationException(
                    "preprocessor_config.json pins its own mel_filters; :models computes the filter bank " +
                        "(audio.js:131-305) and rejects a pinned one",
                )
            }
            val type = root["feature_extractor_type"]?.asString()
            if (type != "WhisperFeatureExtractor") {
                throw IllegalArgumentException(
                    "preprocessor_config.json has feature_extractor_type $type, not WhisperFeatureExtractor",
                )
            }
            fun int(key: String): Int = root[key]?.asDouble()?.toInt()
                ?: throw IllegalArgumentException("preprocessor_config.json has no numeric $key")
            return WhisperFeatures(
                samplingRate = int("sampling_rate"),
                nFft = int("n_fft"),
                hopLength = int("hop_length"),
                nSamples = int("n_samples"),
                nbMaxFrames = int("nb_max_frames"),
                featureSize = int("feature_size"),
            )
        }
    }
}

/** audio.js:89-105 and 703-738: a periodic Hann window. */
internal fun hannPeriodic(len: Int): DoubleArray {
    val m = len + 1
    val factor = 2.0 * PI / (m - 1)
    return DoubleArray(len) { 0.5 - 0.5 * cos(it * factor) }
}

/** The slaney mel scale's hertz→mel, audio.js:131-138. */
internal fun hzToMel(hz: Double): Double =
    if (hz >= 1000.0) 15.0 + ln(hz / 1000.0) * (27.0 / ln(6.4)) else 3.0 * hz / 200.0

/** The slaney mel scale's mel→hertz, audio.js:163-168. */
internal fun melToHz(mel: Double): Double =
    if (mel >= 15.0) 1000.0 * kotlin.math.exp((ln(6.4) / 27.0) * (mel - 15.0)) else 200.0 * mel / 3.0

/** audio.js:224-227: `num` evenly spaced values from [start] to [end] inclusive. */
internal fun linspace(start: Double, end: Double, num: Int): DoubleArray {
    val step = (end - start) / (num - 1)
    return DoubleArray(num) { start + step * it }
}

/** audio.js:245-305: the slaney-normalised triangular filter bank. */
internal fun melFilterBankSlaney(
    bins: Int,
    filters: Int,
    minFrequency: Double,
    maxFrequency: Double,
    samplingRate: Int,
): Array<DoubleArray> {
    require(bins >= 2) { "require num_frequency_bins: $bins >= 2" }
    require(minFrequency <= maxFrequency) { "require min_frequency: $minFrequency <= max_frequency: $maxFrequency" }

    val melMin = hzToMel(minFrequency)
    val melMax = hzToMel(maxFrequency)
    val melFreqs = linspace(melMin, melMax, filters + 2)
    val filterFreqs = DoubleArray(filters + 2) { melToHz(melFreqs[it]) }
    val fftFreqs = linspace(0.0, floor(samplingRate / 2.0), bins)

    // audio.js:194-222: the triangular filters, then the slaney area normalisation.
    val filterDiff = DoubleArray(filters + 1) { filterFreqs[it + 1] - filterFreqs[it] }
    return Array(filters) { i ->
        val enorm = 2.0 / (filterFreqs[i + 2] - filterFreqs[i])
        DoubleArray(bins) { j ->
            val down = -(filterFreqs[i] - fftFreqs[j]) / filterDiff[i]
            val up = (filterFreqs[i + 2] - fftFreqs[j]) / filterDiff[i + 1]
            max(0.0, min(down, up)) * enorm
        }
    }
}

/**
 * audio.js:315-333 with utils/core.js:188-190: reflect-pad [a] by [left] and
 * [right], where `reflect(i) = abs(((i + w) % (2w)) - w)` and `w = a.size - 1`.
 */
internal fun padReflect(a: FloatArray, left: Int, right: Int): FloatArray {
    val padded = FloatArray(a.size + left + right)
    val w = a.size - 1
    fun reflect(i: Int): Int = kotlin.math.abs(((i + w) % (2 * w)) - w)

    for (i in a.indices) padded[left + i] = a[i]
    for (i in 1..left) padded[left - i] = a[reflect(i)]
    for (i in 1..right) padded[w + left + i] = a[reflect(w - i)]
    return padded
}
