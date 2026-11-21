package org.ssa.assistant.core

import org.ssa.assistant.core.pdf.HelveticaMetrics
import org.ssa.assistant.core.pdf.Metrics
import org.ssa.assistant.core.pdf.WinAnsi

/**
 * The width-measuring wrapper every caller uses, exactly as metricsOf() in
 * the golden generator builds it: the text is WinAnsi-encoded before it is
 * measured, because pdf-lib's Helvetica throws on anything else and the real
 * fillers encode the whole mapping up front.
 */
class WrappedMetrics(private val font: HelveticaMetrics) : Metrics {
    override fun widthOfTextAtSize(text: String, size: Double): Double =
        font.widthOfTextAtSize(WinAnsi.toWinAnsi(text), size)

    override fun heightAtSize(size: Double): Double = font.heightAtSize(size)
}
