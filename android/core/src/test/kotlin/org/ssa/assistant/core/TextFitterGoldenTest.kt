package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.pdf.Box
import org.ssa.assistant.core.pdf.Fit
import org.ssa.assistant.core.pdf.HelveticaMetrics
import org.ssa.assistant.core.pdf.fitTextBox
import org.ssa.assistant.core.pdf.wrapLines

/**
 * The `fits` golden: every text box on both templates × ~40 values, fit with
 * the reference's Helvetica. The Kotlin fit decisions — size, cut text,
 * wrapped lines — must agree exactly, because the Android writer draws the
 * same lines inside the same box.
 */
class TextFitterGoldenTest {

    private val golden = Golden.load("fits")
    private val metrics = WrappedMetrics(HelveticaMetrics.HELVETICA)

    private fun fitTree(fit: Fit): Json = Json.Obj().also { o ->
        o["size"] = Json.Num(fit.size)
        o["text"] = Json.Str(fit.text)
        o["cut"] = Json.bool(fit.cut)
        o["lines"] = Json.Arr(fit.lines.mapTo(mutableListOf()) { Json.Str(it) })
    }

    @Test
    fun fits() {
        val entries = golden.asObject()!!["fits"]!!.asArray()!!.items
        check(entries.size > 200) { "only ${entries.size} fit cases" }
        var textBoxes = 0
        var cutSeen = 0
        for ((i, raw) in entries.withIndex()) {
            val e = raw.asObject()!!
            val boxRaw = e["box"]!!.asObject()!!
            val box = Box(
                width = boxRaw["width"]!!.asDouble()!!,
                height = boxRaw["height"]!!.asDouble()!!,
                multiline = boxRaw["multiline"]!!.asBoolean()!!
            )
            textBoxes++
            for ((j, rawCase) in e["fits"]!!.asArray()!!.items.withIndex()) {
                val c = rawCase.asObject()!!
                val value = c["value"]!!.asString()!!
                val fit = fitTextBox(box, org.ssa.assistant.core.pdf.WinAnsi.toWinAnsi(value), metrics)
                if (fit.cut) cutSeen++
                Golden.assertTree("fits", "fits[$i] ${e["field"]?.asString()}[$j] \"${value.take(20)}\"",
                    fitTree(fit), c["fit"]!!)
            }
        }
        check(cutSeen > 0) { "no value was ever cut; the cut path is untested" }
    }

    @Test
    fun wrap() {
        // wrapLines' contract, independently of the goldens: words wrap at
        // spaces, a long word sits on its own line, newlines end lines.
        val wide = 1000.0
        val narrow = metrics.widthOfTextAtSize("aaaa aaaa", 10.0) - 1
        check(wrapLines("aaaa aaaa", wide, metrics, 10.0) == listOf("aaaa aaaa"))
        check(wrapLines("aaaa aaaa", narrow, metrics, 10.0) == listOf("aaaa", "aaaa"))
        check(wrapLines("one\ntwo three", wide, metrics, 10.0) == listOf("one", "two three"))
    }
}
