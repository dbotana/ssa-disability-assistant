package org.ssa.assistant.models.whisper

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * X[k] = Σ x[n]·e^(−2πi·kn/N), any N: recursive mixed-radix Cooley–Tukey,
 * decimation in time, float64.
 *
 * Decision 1: transformers.js uses a Bluestein FFT (utils/audio.js's `FFT`),
 * which agrees with this one to about 1e-13 relative — far below the 1e-4
 * bound the feature golden is checked at — so this simpler transform is used
 * instead. 400 = 2⁴·5², so its factors are 2, 2, 2, 2, 5, 5.
 *
 * Not thread-safe (shared scratch); WhisperFeatures makes one per compute().
 */
internal class MixedRadixFft(val n: Int) {
    private val factors: IntArray = factorize(n) // smallest prime first: 400 -> 2,2,2,2,5,5; 1 -> []
    private val cosT = DoubleArray(n) { cos(2.0 * PI * it / n) }
    private val sinT = DoubleArray(n) { sin(2.0 * PI * it / n) }
    private val sRe = DoubleArray(factors.maxOrNull() ?: 1)
    private val sIm = DoubleArray(factors.maxOrNull() ?: 1)

    fun transform(inRe: DoubleArray, inIm: DoubleArray, outRe: DoubleArray, outIm: DoubleArray) =
        step(inRe, inIm, 0, 1, outRe, outIm, 0, n, 0)

    private fun step(
        inRe: DoubleArray, inIm: DoubleArray, inStart: Int, inStride: Int,
        outRe: DoubleArray, outIm: DoubleArray, outStart: Int, len: Int, f: Int,
    ) {
        if (len == 1) {
            outRe[outStart] = inRe[inStart]
            outIm[outStart] = inIm[inStart]
            return
        }
        val p = factors[f]
        val m = len / p
        for (q in 0 until p) {
            step(inRe, inIm, inStart + q * inStride, inStride * p, outRe, outIm, outStart + q * m, m, f + 1)
        }
        val tableStep = n / len
        for (k in 0 until m) {
            for (q in 0 until p) {
                sRe[q] = outRe[outStart + q * m + k]
                sIm[q] = outIm[outStart + q * m + k]
            }
            for (s in 0 until p) {
                val kk = k + s * m
                var re = 0.0
                var im = 0.0
                for (q in 0 until p) {
                    val t = ((q * kk) % len) * tableStep
                    val c = cosT[t]
                    val sn = sinT[t]
                    re += sRe[q] * c + sIm[q] * sn
                    im += sIm[q] * c - sRe[q] * sn
                }
                outRe[outStart + kk] = re
                outIm[outStart + kk] = im
            }
        }
    }
}

/** The prime factors of [n], smallest first; 1 has none. */
internal fun factorize(n: Int): IntArray {
    require(n >= 1) { "cannot factorize $n" }
    val factors = mutableListOf<Int>()
    var remaining = n
    var d = 2
    while (d * d <= remaining) {
        while (remaining % d == 0) {
            factors += d
            remaining /= d
        }
        d++
    }
    if (remaining > 1) factors += remaining
    return factors.toIntArray()
}
