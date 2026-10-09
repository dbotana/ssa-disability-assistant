package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.pdf.HelveticaMetrics
import org.ssa.assistant.core.pdf.WinAnsi

/**
 * The `metrics` golden: pdf-lib's Helvetica and Helvetica-Bold tables, plus
 * probes — widthOfTextAtSize over the WinAnsi text and heightAtSize — that
 * pin [HelveticaMetrics] to pdf-lib directly. A width computed over the wrong
 * glyph names or kerning would fail here before it could poison a fit.
 */
class MetricsGoldenTest {

    private val golden = Golden.load("metrics")

    private fun table(name: String): HelveticaMetrics = HelveticaMetrics.fromGolden(name)

    @Test
    fun probes() {
        val probes = golden.asObject()!!["probes"]!!.asArray()!!.items
        check(probes.size > 100) { "only ${probes.size} metric probes" }
        for ((i, raw) in probes.withIndex()) {
            val p = raw.asObject()!!
            val font = table(p["font"]!!.asString()!!)
            val ansi = p["ansi"]!!.asString()!!
            val size = p["size"]!!.asDouble()!!
            val where = "probes[$i] ${p["font"]?.asString()} ${p["text"]?.asString()?.take(30)} @$size"
            val wantWidth = p["width"]!!.asDouble()!!
            val wantHeight = p["height"]!!.asDouble()!!
            check(java.lang.Double.doubleToLongBits(font.widthOfTextAtSize(ansi, size)) ==
                java.lang.Double.doubleToLongBits(wantWidth)) {
                "$where: width ${font.widthOfTextAtSize(ansi, size)} != $wantWidth"
            }
            check(java.lang.Double.doubleToLongBits(font.heightAtSize(size)) ==
                java.lang.Double.doubleToLongBits(wantHeight)) {
                "$where: height ${font.heightAtSize(size)} != $wantHeight"
            }
        }
    }

    @Test
    fun tables() {
        // The tables the probes measure with: enough widths and kern pairs
        // that a truncated extraction would show up as a probe failure, but
        // assert the shape is real anyway.
        for (name in listOf("helvetica", "helveticaBold")) {
            val raw = golden.asObject()!![name]!!.asObject()!!
            check((raw["CharWidths"]!!.asObject()!!.entries).size > 200) { "$name CharWidths too small" }
            check((raw["KernPairXAmounts"]!!.asObject()!!.entries).size > 100) { "$name kern pairs too small" }
            check(raw["Ascender"]!!.asDouble()!! == 718.0) { "$name Ascender" }
            check(raw["Descender"]!!.asDouble()!! == -207.0) { "$name Descender" }
        }
    }

    @Test
    fun toWinAnsi() {
        // The conversion every measurement runs through: accented letters
        // outside Latin-1 lose their accent, stroked letters map, and
        // anything else becomes "?".
        check(WinAnsi.toWinAnsi("José Ñúñez") == "José Ñúñez")
        check(WinAnsi.toWinAnsi("Łukasz Wałęsa") == "Lukasz Walesa")
        check(WinAnsi.toWinAnsi("ő ű") == "o u")
        check(WinAnsi.toWinAnsi("Zażółć") == "Zazólc")   // ż -> z, ó is Latin-1, ł -> l, ć -> c
        check(WinAnsi.toWinAnsi("日本語") == "???")
        check(WinAnsi.toWinAnsi("tab\there") == "tab here")
        check(WinAnsi.toWinAnsi("a—b") == "a—b")   // em dash is in WinAnsi
        check(WinAnsi.toWinAnsi("") == "")
    }
}
