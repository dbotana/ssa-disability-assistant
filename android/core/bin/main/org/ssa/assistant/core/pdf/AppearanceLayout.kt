package org.ssa.assistant.core.pdf

/**
 * Where a text field's appearance stream draws its lines: pdf-lib's own
 * layout (layoutMultilineText / layoutSinglelineText in the vendored bundle),
 * applied to the fit's lines. The Android writer draws exactly `fit.lines`,
 * and this puts each one where pdf-lib's appearance would have put it, so a
 * form filled on the phone looks like the same form filled on the web. The
 * `fits` golden records pdf-lib's positions for every box × value; the
 * arithmetic below keeps its order of operations so the doubles agree.
 */

/** The text area inside the widget: inset by the border width plus 1. */
data class Bounds(val x: Double, val y: Double, val width: Double, val height: Double)

/** One line's text and its baseline origin, in the widget's form space. */
data class PlacedLine(val text: String, val x: Double, val y: Double)

data class TextAppearance(val bounds: Bounds, val size: Double, val lines: List<PlacedLine>)

object AppearanceLayout {
    /** pdf-lib's TextAlignment: the field's /Q. */
    const val LEFT = 0
    const val CENTER = 1
    const val RIGHT = 2

    fun layout(entry: ManifestEntry, fit: Fit, font: HelveticaMetrics = HelveticaMetrics.HELVETICA): TextAppearance =
        layout(entry.box, entry.quadding ?: LEFT, entry.borderWidth, fit, font)

    fun layout(box: Box, quadding: Int, borderWidth: Double, fit: Fit, font: HelveticaMetrics): TextAppearance {
        // Not combed, so pdf-lib's padding is 1.
        val inset = borderWidth + 1
        val bounds = Bounds(inset, inset, box.width - 2 * inset, box.height - 2 * inset)
        fun xFor(width: Double): Double = when (quadding) {
            CENTER -> bounds.x + bounds.width / 2 - width / 2
            RIGHT -> bounds.x + bounds.width - width
            else -> bounds.x
        }
        val size = fit.size

        if (box.multiline) {
            val height = font.heightAtSize(size)
            val lineHeight = height + 0.2 * height
            var y = bounds.y + bounds.height
            val lines = fit.lines.map { text ->
                val width = font.widthOfTextAtSize(text, size)
                y -= lineHeight
                PlacedLine(text, xFor(width), y)
            }
            return TextAppearance(bounds, size, lines)
        }

        // A single-line box has one line, centred vertically on the ascent.
        val text = fit.lines.firstOrNull() ?: ""
        val width = font.widthOfTextAtSize(text, size)
        val ascent = font.heightAtSize(size, descender = false)
        val y = bounds.y + (bounds.height / 2 - ascent / 2)
        return TextAppearance(bounds, size, listOf(PlacedLine(text, xFor(width), y)))
    }
}
