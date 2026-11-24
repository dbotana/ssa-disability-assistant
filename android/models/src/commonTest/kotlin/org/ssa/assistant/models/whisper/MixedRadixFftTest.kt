package org.ssa.assistant.models.whisper

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MixedRadixFftTest {
    @Test
    fun matchesDirectDft() {
        for (n in listOf(1, 2, 3, 5, 8, 12, 400, 401)) {
            val random = Random(42)
            val inRe = DoubleArray(n) { random.nextDouble(-1.0, 1.0) }
            val inIm = DoubleArray(n) { random.nextDouble(-1.0, 1.0) }
            val outRe = DoubleArray(n)
            val outIm = DoubleArray(n)
            MixedRadixFft(n).transform(inRe, inIm, outRe, outIm)

            for (k in 0 until n) {
                var wantRe = 0.0
                var wantIm = 0.0
                for (t in 0 until n) {
                    val angle = -2.0 * PI * k * t / n
                    val c = cos(angle)
                    val s = sin(angle)
                    wantRe += inRe[t] * c - inIm[t] * s
                    wantIm += inRe[t] * s + inIm[t] * c
                }
                val bound = 1e-9 * n
                assertTrue(
                    abs(outRe[k] - wantRe) <= bound,
                    "n=$n k=$k real: got ${outRe[k]}, want $wantRe, bound $bound",
                )
                assertTrue(
                    abs(outIm[k] - wantIm) <= bound,
                    "n=$n k=$k imag: got ${outIm[k]}, want $wantIm, bound $bound",
                )
            }
        }
    }

    @Test
    fun factorizesFourHundred() {
        assertEquals(listOf(2, 2, 2, 2, 5, 5), factorize(400).toList())
        assertEquals(emptyList<Int>(), factorize(1).toList())
    }
}
