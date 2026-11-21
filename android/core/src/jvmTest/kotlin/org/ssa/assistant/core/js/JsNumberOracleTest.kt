package org.ssa.assistant.core.js

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.util.Locale
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json

/**
 * The common number printer against the JVM's BigDecimal, which the port
 * used before :core went multiplatform. Both must give the same text for
 * every number in the goldens and for seeded random doubles, and
 * [fixedHalfUp] must give what String.format does.
 */
class JsNumberOracleTest {

    /** The former jsNumberToString(), kept as the reference. */
    private fun bigDecimalReference(x: Double): String {
        if (x.isNaN()) return "NaN"
        if (x == 0.0) return "0"
        if (x.isInfinite()) return if (x > 0) "Infinity" else "-Infinity"
        if (x < 0) return "-" + bigDecimalReference(-x)

        val exact = BigDecimal(x)
        var shortest: BigDecimal? = null
        for (precision in 1..17) {
            val r = exact.round(MathContext(precision, RoundingMode.HALF_EVEN))
            if (r.toDouble() == x) { shortest = r; break }
        }
        val r = shortest ?: exact.round(MathContext(17, RoundingMode.HALF_EVEN))
        val unscaled = r.unscaledValue().toString()
        val digits = unscaled.trimEnd('0')
        val k = digits.length
        val n = k + (unscaled.length - digits.length) - r.scale()
        return when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                val sign = if (e >= 0) "+" else "-"
                val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
                "${mantissa}e$sign${Math.abs(e)}"
            }
        }
    }

    private fun assertSame(x: Double) =
        assertEquals(bigDecimalReference(x), jsNumberToString(x), "jsNumberToString(${x.toRawBits().toString(16)})")

    private fun numbersIn(j: Json, out: MutableList<Double>) {
        when (j) {
            is Json.Num -> out.add(j.value)
            is Json.Arr -> j.items.forEach { numbersIn(it, out) }
            is Json.Obj -> j.entries.values.forEach { numbersIn(it, out) }
            else -> {}
        }
    }

    @Test
    fun everyGoldenNumberPrintsAsBefore() {
        val names = listOf(
            "addendum", "choice", "fillplans", "fits", "i18n", "import", "metrics",
            "parse", "templateManifest", "tts", "turn", "walks", "winansi",
        )
        val numbers = mutableListOf<Double>()
        for (name in names) numbersIn(Golden.load(name), numbers)
        check(numbers.size > 10_000) { "only ${numbers.size} numbers in the goldens" }
        numbers.forEach(::assertSame)
    }

    @Test
    fun seededRandomDoublesPrintAsBefore() {
        val random = Random(20261121)
        repeat(RANDOM_DOUBLES) {
            // Every bit pattern, so subnormals and huge exponents come up too.
            val x = Double.fromBits(random.nextLong())
            if (x.isFinite()) assertSame(x)
            // And numbers of the size answers have.
            assertSame(random.nextDouble() * 10_000)
        }
        for (e in -1074..1023) assertSame(Math.scalb(1.0, e))
    }

    @Test
    fun fixedHalfUpIsStringFormat() {
        val random = Random(7)
        repeat(100_000) {
            val frac = random.nextDouble()
            assertEquals(String.format(Locale.ROOT, "%.3f", frac), fixedHalfUp(frac, 3), "fixedHalfUp($frac)")
        }
        for (frac in listOf(0.0005, 0.0004, 0.9996, 0.25, 0.125, 0.5599999999999454)) {
            assertEquals(String.format(Locale.ROOT, "%.3f", frac), fixedHalfUp(frac, 3), "fixedHalfUp($frac)")
        }
    }

    @Test
    fun jsRoundIsMathRound() {
        val random = Random(11)
        val samples = listOf(0.5, -0.5, 1.5, -1.5, 2.5, 0.49999999999999994, -0.49999999999999994, 4503599627370497.0, Double.NaN) +
            List(100_000) { (random.nextDouble() - 0.5) * 1e6 }
        for (x in samples) assertEquals(Math.round(x), jsRound(x), "jsRound($x)")
    }

    private companion object {
        const val RANDOM_DOUBLES = 1_000_000
    }
}
