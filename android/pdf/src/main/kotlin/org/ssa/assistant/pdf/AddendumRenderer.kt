package org.ssa.assistant.pdf

import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDResources
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.common.PDStream
import org.ssa.assistant.core.pdf.COLORS
import org.ssa.assistant.core.pdf.Op
import org.ssa.assistant.core.pdf.Page
import org.ssa.assistant.core.pdf.RULE
import org.ssa.assistant.core.pdf.WinAnsi

/**
 * Replays an addendum draw list (AddendumLayout, golden-pinned) onto new US
 * Letter pages at the end of [doc], as renderAddendum() in pdf.js does with
 * pdf-lib: each text op in Helvetica or Helvetica-Bold, each rule a line. The
 * layout decided everything; this only writes it down.
 */
object AddendumRenderer {
    internal val REGULAR: COSName = COSName.getPDFName("F1")
    internal val BOLD: COSName = COSName.getPDFName("F2")

    fun render(doc: PDDocument, pages: List<List<Op>>): Int {
        if (pages.isEmpty()) return 0
        val regular = Fonts.winAnsi("Helvetica")
        val bold = Fonts.winAnsi("Helvetica-Bold")
        for (ops in pages) {
            val page = PDPage(PDRectangle(Page.W.toFloat(), Page.H.toFloat()))
            page.resources = PDResources().apply {
                put(REGULAR, regular)
                put(BOLD, bold)
            }
            val c = Content()
            for (op in ops) when (op) {
                is Op.Text -> {
                    val color = COLORS[op.color] ?: COLORS.getValue("ink")
                    c.op("q").op("BT")
                        .op(color.r, color.g, color.b, "rg")
                        .op("/${(if (op.font == "bold") BOLD else REGULAR).name}", op.size, "Tf")
                        .op(1.0, 0.0, 0.0, 1.0, op.x, op.y, "Tm")
                        .op(Content.hex(WinAnsi.encode(WinAnsi.toWinAnsi(op.text))), "Tj")
                        .op("ET").op("Q")
                }
                is Op.Rule -> {
                    val color = COLORS.getValue(RULE)
                    c.op("q")
                        .op(color.r, color.g, color.b, "RG")
                        .op(op.thickness, "w")
                        .op(op.x, op.y, "m")
                        .op(op.x + op.width, op.y, "l")
                        .op("S").op("Q")
                }
            }
            val stream = PDStream(doc)
            stream.createOutputStream(COSName.FLATE_DECODE).use { it.write(c.bytes()) }
            page.setContents(stream)
            doc.addPage(page)
        }
        return pages.size
    }
}
