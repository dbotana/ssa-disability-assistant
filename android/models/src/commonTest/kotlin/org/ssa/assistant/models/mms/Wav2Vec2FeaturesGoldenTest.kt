package org.ssa.assistant.models.mms

import org.ssa.assistant.models.testing.MmsGolden
import org.ssa.assistant.models.testing.firstWindow
import org.ssa.assistant.models.testing.goldenWav2Vec2Features
import org.ssa.assistant.models.testing.littleEndianBytes
import org.ssa.assistant.models.testing.readMmsClip
import org.ssa.assistant.models.testing.runtimeName
import org.ssa.assistant.models.testing.settings
import org.ssa.assistant.models.testing.sha256Hex
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.TimeSource

/**
 * Decision 4: the normalized clip must be bit-identical to `Wav2Vec2FeatureExtractor`'s, on all
 * 9 clips and on their first 3 s. Where a SHA-256 differs, the largest difference against the
 * golden's full `yes` array is recorded and must be at most [BOUND]; a clip with no array to
 * measure against fails. The bound is never raised.
 */
class Wav2Vec2FeaturesGoldenTest {
    @Test
    fun matchesTheReferenceBitForBit() {
        val features = goldenWav2Vec2Features()
        assertEquals(features.settings(), Wav2Vec2Features().settings(), "Wav2Vec2Features' defaults against features.config")
        assertEquals(48_000, MmsGolden.lidWindowSamples, "features.lidWindowSamples")
        val yes = MmsGolden.yesNormalized
        assertTrue(yes != null, "the golden has no features.yes, so a differing SHA-256 could not be measured")

        val failures = mutableListOf<String>()
        var exactCount = 0
        var total = 0
        for (clip in MmsGolden.clips) {
            val samples = readMmsClip(clip)
            for ((window, x) in listOf("full" to samples, "first3s" to firstWindow(samples, MmsGolden.lidWindowSamples))) {
                total++
                val stats = MmsGolden.featureStats(clip.name, window)
                assertEquals(stats.sampleCount, x.size, "${clip.name} $window sample count")

                val start = TimeSource.Monotonic.markNow()
                val out = features.compute(x)
                val ms = start.elapsedNow().inWholeMilliseconds
                val moments = features.moments(x)

                // The golden's meanStd[1] is the divisor np.sqrt(x.var() + 1e-7) (tools/golden/mms.py),
                // which is [Wav2Vec2Moments.denominator], not x.std().
                val meanExact = moments.mean.toRawBits() == stats.mean.toRawBits()
                val stdExact = moments.denominator.toRawBits() == stats.std.toRawBits()
                if (!meanExact || !stdExact) {
                    failures += "${clip.name} $window: mean ${moments.mean} (${moments.mean.hexBits()}) against the " +
                        "golden's ${stats.mean} (${stats.mean.hexBits()}); sqrt(var + eps) ${moments.denominator} " +
                        "(${moments.denominator.hexBits()}) against ${stats.std} (${stats.std.hexBits()}); " +
                        "for reference sqrt(var) without eps is ${moments.std} (${moments.std.hexBits()})"
                }

                val exact = sha256Hex(littleEndianBytes(out)) == stats.sha256
                if (exact) exactCount++
                var detail = ""
                val reference = yes?.takeIf { clip.name == "yes" && it.size == out.size }
                if (reference != null) {
                    var maxDiff = 0.0
                    var differing = 0
                    for (i in out.indices) {
                        if (out[i].toRawBits() != reference[i].toRawBits()) differing++
                        maxDiff = maxOf(maxDiff, abs(out[i].toDouble() - reference[i].toDouble()))
                    }
                    detail = ", against features.yes: $differing values differ, max |diff| $maxDiff"
                    if (exact && differing != 0) failures += "${clip.name} $window: the SHA-256 matches but features.yes does not"
                    if (!exact && maxDiff > BOUND) failures += "${clip.name} $window: max |diff| $maxDiff exceeds $BOUND"
                } else if (!exact) {
                    failures += "${clip.name} $window: the SHA-256 differs, and the golden has no array to measure by how much"
                }
                println(
                    "MMS-FEATURES[$runtimeName] ${clip.name} $window: ${x.size} samples, $ms ms, exact: $exact, " +
                        "mean bits equal: $meanExact, std bits equal: $stdExact$detail",
                )
            }
        }
        println("MMS-FEATURES[$runtimeName] bit-exact normalized clips: $exactCount/$total")
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    private companion object {
        const val BOUND = 1e-6
    }
}

private fun Float.hexBits(): String = "0x" + toRawBits().toUInt().toString(16).padStart(8, '0')
