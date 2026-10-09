package org.ssa.assistant.pdf

import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import java.io.ByteArrayOutputStream
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * A content stream written operator by operator. Text goes in as hex strings
 * of WinAnsi bytes (as pdf-lib writes it), so no PDFBox text encoder sits
 * between the plan and the page: what PdfSelfCheck reads back is exactly
 * what was written.
 */
internal class Content {
    private val out = ByteArrayOutputStream()

    fun op(vararg parts: Any): Content {
        out.write(parts.joinToString(" ") { if (it is Double) num(it) else it.toString() }.toByteArray(Charsets.US_ASCII))
        out.write('\n'.code)
        return this
    }

    fun bytes(): ByteArray = out.toByteArray()

    companion object {
        /** A PDF real: plain decimal, at most 6 places, never "1E-7" or "-0". */
        fun num(x: Double): String {
            val s = BigDecimal(x).setScale(6, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()
            return if (s == "-0") "0" else s
        }

        fun hex(bytes: ByteArray): String =
            bytes.joinToString("", prefix = "<", postfix = ">") { "%02X".format(it.toInt() and 0xff) }
    }
}

/** The standard Helvetica pair with WinAnsiEncoding, as fresh dictionaries per document. */
internal object Fonts {
    /** The name filled fields' DAs and appearances use; added to /DR. */
    val HELV_WA: COSName = COSName.getPDFName("HelvWA")

    fun winAnsi(baseFont: String): PDType1Font = PDType1Font(COSDictionary().apply {
        setItem(COSName.TYPE, COSName.FONT)
        setItem(COSName.SUBTYPE, COSName.TYPE1)
        setItem(COSName.BASE_FONT, COSName.getPDFName(baseFont))
        setItem(COSName.ENCODING, COSName.WIN_ANSI_ENCODING)
    })
}
