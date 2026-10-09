package org.ssa.assistant.pdf

import android.content.Context
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import java.security.MessageDigest

/** A template that is missing, unpinned, or not the bytes that were pinned. */
class TemplateException(message: String) : Exception(message)

/**
 * The blank official forms, from this module's assets.
 *
 * The build copies forms/ into the assets only after checking every file
 * against forms.SHA256SUMS, and copies the pins beside them; this re-checks
 * the bytes against those same pins at load time, so a corrupted install
 * cannot quietly produce a form from the wrong template.
 *
 * Documents are opened in main memory only: no scratch file with a
 * claimant's answers in it is ever written to the cache directory.
 */
class TemplateLoader(context: Context) {
    private val assets = context.applicationContext.assets

    init {
        PdfThread.init(context)
    }

    private val pins: Map<String, String> by lazy {
        assets.open("forms/SHA256SUMS").bufferedReader().readLines()
            .filter { it.isNotBlank() && !it.startsWith("#") }
            .associate { line ->
                val m = Regex("^([0-9a-f]{64}) [ *](\\S+)$").matchEntire(line)
                    ?: throw TemplateException("forms/SHA256SUMS: not a pin line")
                m.groupValues[2] to m.groupValues[1]
            }
    }

    /**
     * The template's bytes, verified. [path] is the spec's TEMPLATE
     * ("forms/<file>.pdf"), which is also its path in the assets.
     */
    fun bytes(path: String): ByteArray {
        val name = path.removePrefix("forms/")
        val want = pins[name] ?: throw TemplateException("$path is not pinned")
        val bytes = try {
            assets.open(path).use { it.readBytes() }
        } catch (e: java.io.IOException) {
            throw TemplateException("$path is missing")
        }
        val got = sha256(bytes)
        if (got != want) throw TemplateException("$path does not match its pin")
        return bytes
    }

    companion object {
        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

        /** Opens PDF bytes in main memory only. Call on the PDF thread. */
        fun open(bytes: ByteArray): PDDocument =
            PDDocument.load(bytes, "", null, null, MemoryUsageSetting.setupMainMemoryOnly())
    }
}
