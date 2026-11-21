package org.ssa.assistant.core.pdf

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsTrim

/**
 * Port of src/plan.js: fit decisions for one box. Pure — the Android writer
 * draws its own appearance streams from the same plan pdf-lib renders on the
 * web, so both sides are pinned to identical numbers by the goldens.
 */

const val MAX_SIZE = 10.0
const val MIN_SIZE = 7.0
const val SEE_ATTACHED = " (see attached)"
// Room kept between the text and the box's edge, plus a margin so our line
// wrapping never produces fewer lines than pdf-lib's own does. Android draws
// inside the same inset.
const val INSET_X = 8.0
const val INSET_Y = 3.0

/** A box as the template manifest records it — never read from a live PDF. */
data class Box(val width: Double, val height: Double, val multiline: Boolean)

/** One fit decision: the size to draw at, the text to draw, and its lines. */
data class Fit(val size: Double, val text: String, val cut: Boolean, val lines: List<String>)

/** A text-measuring port; HelveticaMetrics implements it. */
interface Metrics {
    fun widthOfTextAtSize(text: String, size: Double): Double
    fun heightAtSize(size: Double): Double
}

/**
 * Wrap a string to a width, returning the lines.
 *
 * Words wrap at spaces; an explicit newline ends a line. A word wider than the
 * box goes on a line of its own — pdf-lib does not break words, and neither
 * does the Android appearance writer, so measured lines match drawn lines.
 */
fun wrapLines(str: String, width: Double, metrics: Metrics, size: Double): List<String> {
    val lines = mutableListOf<String>()
    for (para in str.split("\n")) {
        var line = ""
        for (word in para.split(js("\\s+")).filter { it.isNotEmpty() }) {
            val test = if (line.isNotEmpty()) "$line $word" else word
            if (metrics.widthOfTextAtSize(test, size) > width && line.isNotEmpty()) {
                lines.add(line)
                line = word
            } else {
                line = test
            }
        }
        lines.add(line)
    }
    return lines
}

/**
 * Fit a value into a box. Returns { size, text, cut, lines }.
 *
 * The value is shrunk down to MIN_SIZE; below that it would be unreadable, so
 * it is cut short, marked "(see attached)", and written out in full on an
 * addendum page. `box` is { width, height, multiline }, as the manifest
 * records it — never read from a live PDF, so the Android side never depends
 * on PDFBox's 32-bit floats.
 */
fun fitTextBox(box: Box, rawValue: Any?, metrics: Metrics): Fit {
    // A single-line box cannot render a newline; pdf-lib throws on one.
    val value = if (box.multiline) rawValue.toString()
    else jsTrim(rawValue.toString().replace("\n", " ").replace(js("\\s+"), " "))

    val width = max(box.width - INSET_X, 10.0)
    val height = max(box.height - INSET_Y, 6.0)
    fun lineHeight(size: Double): Double = metrics.heightAtSize(size) * 1.2

    fun fits(str: String, size: Double): Boolean {
        if (!box.multiline) {
            return metrics.widthOfTextAtSize(str, size) <= width && metrics.heightAtSize(size) <= height
        }
        return wrapLines(str, width, metrics, size).size * lineHeight(size) <= height
    }

    // Single-line boxes are sized for their printed type; never go larger than
    // the box is tall.
    val top = if (box.multiline) MAX_SIZE else min(MAX_SIZE, floor(height / 1.05))
    var size = top
    while (size >= MIN_SIZE) {
        if (fits(value, size)) {
            return Fit(size, value, false, wrapLines(value, width, metrics, size))
        }
        size -= 0.5
    }

    // Too long at the smallest legible size: keep what fits, point to the rest.
    var keep = value
    while (keep.isNotEmpty() && !fits("$keep…$SEE_ATTACHED", MIN_SIZE)) {
        val lastSpace = keep.lastIndexOf(' ')
        keep = if (lastSpace > keep.length / 2) keep.substring(0, lastSpace)
        else keep.substring(0, keep.length - 1)
        keep = keep.replace(js("[\\s,;:.-]+$"), "")
    }
    val text = if (keep.isNotEmpty()) "$keep…$SEE_ATTACHED" else SEE_ATTACHED.trim()
    return Fit(MIN_SIZE, text, true, wrapLines(text, width, metrics, MIN_SIZE))
}
