package org.ssa.assistant.models.whisper

import org.ssa.assistant.models.testing.WhisperGolden
import org.ssa.assistant.models.testing.readTestBytes
import org.ssa.assistant.models.testing.runtimeName
import org.ssa.assistant.models.testing.sha256Hex
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.TimeSource

class WhisperFeaturesGoldenTest {
    @Test
    fun matchesTheGoldenFrontEnd() {
        val feature = WhisperFeatures()
        val config = WhisperGolden.obj(WhisperGolden.features, "config")
        assertEquals(WhisperGolden.int(config, "sampling_rate"), feature.samplingRate)
        assertEquals(WhisperGolden.int(config, "n_fft"), feature.nFft)
        assertEquals(WhisperGolden.int(config, "hop_length"), feature.hopLength)
        assertEquals(WhisperGolden.int(config, "n_samples"), feature.nSamples)
        assertEquals(WhisperGolden.int(config, "nb_max_frames"), feature.nbMaxFrames)
        assertEquals(WhisperGolden.int(config, "feature_size"), feature.featureSize)

        val expectedWindow = WhisperGolden.doubles(WhisperGolden.features["window"])
        var windowMax = 0.0
        for (i in expectedWindow.indices) {
            windowMax = maxOf(windowMax, abs(feature.window[i] - expectedWindow[i]))
        }
        val expectedMel = WhisperGolden.doubles(WhisperGolden.features["melFilters"])
        var melMax = 0.0
        var k = 0
        for (row in feature.melFilters) {
            for (value in row) {
                melMax = maxOf(melMax, abs(value - expectedMel[k++]))
            }
        }
        assertEquals(expectedMel.size, k)

        var matrixMax = 0.0
        var frameSumMax = 0.0
        var frameMaxMax = 0.0
        val matrixClips = mutableListOf<String>()
        for (clip in WhisperGolden.clips) {
            val name = WhisperGolden.string(clip, "name")
            val file = WhisperGolden.string(clip, "file")
            val wav = readTestBytes("fixtures/speech/$file")
            assertEquals(WhisperGolden.string(clip, "sha256"), sha256Hex(wav), "$file SHA-256")
            val samples = readWav16kForFeatures(wav)
            assertEquals(WhisperGolden.int(clip, "sampleCount"), samples.size, "$file sample count")

            val start = TimeSource.Monotonic.markNow()
            val actual = feature.compute(samples)
            val ms = start.elapsedNow().inWholeMilliseconds
            println("FEATURES[$runtimeName] $name: $ms ms")

            val clipFeatures = WhisperGolden.obj(clip, "features")
            val frames = WhisperGolden.int(config, "nb_max_frames")
            val expectedFrameSum = WhisperGolden.doubles(clipFeatures["frameSum"])
            val expectedFrameMax = WhisperGolden.floats(clipFeatures["frameMax"])
            for (f in expectedFrameSum.indices) {
                var sum = 0.0
                var maximum = Double.NEGATIVE_INFINITY
                for (m in 0 until feature.featureSize) {
                    val value = actual[m * frames + f].toDouble()
                    sum += value
                    maximum = maxOf(maximum, value)
                }
                frameSumMax = maxOf(frameSumMax, abs(sum - expectedFrameSum[f]))
                frameMaxMax = maxOf(frameMaxMax, abs(maximum - expectedFrameMax[f]))
            }

            clipFeatures["matrix"]?.let { packed ->
                matrixClips += name
                val expectedMatrix = WhisperGolden.floats(packed)
                assertEquals(expectedMatrix.size, actual.size, "$name matrix size")
                for (i in actual.indices) {
                    matrixMax = maxOf(matrixMax, abs(actual[i].toDouble() - expectedMatrix[i].toDouble()))
                }
            }
        }

        println(
            "FEATURES[$runtimeName] yes matrix max |diff| $matrixMax; " +
                "frameSum max |diff| $frameSumMax; frameMax max |diff| $frameMaxMax; " +
                "window max |diff| $windowMax; melFilters max |diff| $melMax",
        )
        // tools/golden/models.mjs writes the full matrix for yes.wav; without it the
        // matrix bound below would hold with nothing compared.
        assertTrue("yes" in matrixClips, "the golden has no features.matrix for yes, so the matrix check compared nothing")
        assertTrue(windowMax <= 1e-12, "window max |diff| $windowMax exceeds 1e-12")
        assertTrue(melMax <= 1e-12, "melFilters max |diff| $melMax exceeds 1e-12")
        assertTrue(matrixMax <= 1e-4, "yes matrix max |diff| $matrixMax exceeds 1e-4")
        assertTrue(frameMaxMax <= 1e-4, "frameMax max |diff| $frameMaxMax exceeds 1e-4")
        assertTrue(frameSumMax <= 8e-3, "frameSum max |diff| $frameSumMax exceeds 8e-3")
    }
}

private fun readWav16kForFeatures(bytes: ByteArray) =
    org.ssa.assistant.models.testing.readWav16k(bytes)
