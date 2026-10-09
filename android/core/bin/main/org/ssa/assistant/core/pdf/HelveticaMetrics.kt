package org.ssa.assistant.core.pdf

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.loadResource

/**
 * Helvetica and Helvetica-Bold metrics, the numbers pdf-lib's standard fonts
 * carry, read from the `metrics` golden — which ships as a :core main resource
 * so the app itself measures with the reference's numbers, never with
 * PDFBox's.
 *
 * widthOfTextAtSize() reproduces pdf-lib's kerned measurement: for each glyph
 * (WinAnsi-encoded), width + the kerning pair with the next glyph, summed, all
 * times size/1000. The callers apply [WinAnsi.toWinAnsi] first, exactly as the
 * JS metricsOf() wrapper does, so an unencodable character throws here rather
 * than silently mis-measuring.
 *
 * heightAtSize() is pdf-lib's heightOfFontAtSize() with its default
 * `descender: true`: (Ascender - Descender) / 1000 * size — 0.925 * size for
 * Helvetica. A zero Ascender or Descender falls back to the font bbox, as
 * pdf-lib's `||` does.
 */
class HelveticaMetrics private constructor(
    private val charWidths: Map<String, Double>,
    private val kernPairs: Map<String, Map<String, Double>>,
    private val ascender: Double,
    private val descender: Double,
    private val bbox: List<Double>,
) {
    companion object {
        private const val MISSING_GLYPH = 250.0

        /** The metrics golden, shipped as a main resource. */
        private val GOLDEN: Json.Obj by lazy {
            loadResource("golden/metrics.json").asObject()
                ?: throw IllegalStateException("golden/metrics.json is not an object")
        }

        val HELVETICA: HelveticaMetrics by lazy { fromGolden("helvetica") }
        val HELVETICA_BOLD: HelveticaMetrics by lazy { fromGolden("helveticaBold") }

        fun fromGolden(name: String): HelveticaMetrics {
            val table = GOLDEN[name]?.asObject()
                ?: throw IllegalStateException("metrics golden has no $name")
            val widths = table["CharWidths"]!!.asObject()!!.entries
                .mapValues { it.value.asDouble()!! }
            val kerns = table["KernPairXAmounts"]!!.asObject()!!.entries
                .mapValues { (_, v) -> v.asObject()!!.entries.mapValues { e -> e.value.asDouble()!! } }
            val bbox = table["FontBBox"]!!.asArray()!!.items.map { it.asDouble()!! }
            return HelveticaMetrics(
                charWidths = widths,
                kernPairs = kerns,
                ascender = table["Ascender"]!!.asDouble()!!,
                descender = table["Descender"]!!.asDouble()!!,
                bbox = bbox
            )
        }
    }

    /** pdf-lib's widthOfGlyph: CharWidths[name] || 250. */
    fun widthOfGlyph(name: String): Double = charWidths[name] ?: MISSING_GLYPH

    /** pdf-lib's getXAxisKerningForPair: KernPairXAmounts[left]?.[right] || 0. */
    fun kernBetween(left: String, right: String?): Double =
        right?.let { kernPairs[left]?.get(it) } ?: 0.0

    fun heightAtSize(size: Double): Double = heightAtSize(size, descender = true)

    /**
     * pdf-lib's heightOfFontAtSize(size, { descender }). Without the
     * descender it adds `Descender || 0` back, which is the ascent; a
     * single-line field's appearance centres on that.
     */
    fun heightAtSize(size: Double, descender: Boolean): Double {
        // (Ascender || FontBBox[3]) - (Descender || FontBBox[1]), as doubles.
        val a = if (ascender == 0.0) bbox.getOrElse(3) { 0.0 } else ascender
        val d = if (this.descender == 0.0) bbox.getOrElse(1) { 0.0 } else this.descender
        var height = a - d
        if (!descender) height += this.descender
        return height / 1000.0 * size
    }

    /**
     * pdf-lib's widthOfTextAtSize: every code point encoded through WinAnsi,
     * then for each glyph its width plus the kern pair with the next glyph,
     * summed left to right, then scaled.
     */
    fun widthOfTextAtSize(text: String, size: Double): Double {
        val names = mutableListOf<String>()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            names.add(WinAnsi.glyphFor(cp).second)
        }
        var total = 0.0
        for (j in names.indices) {
            total += widthOfGlyph(names[j]) + kernBetween(names[j], names.getOrNull(j + 1))
        }
        return total * (size / 1000.0)
    }
}
