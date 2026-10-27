package org.ssa.assistant.pdf

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.services.storage.TestStorage
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import java.io.File
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import org.junit.Test
import org.junit.runner.RunWith
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The viewer question M1a has to answer: does Android's own renderer — the
 * one a native preview would use — actually draw the widget appearances the
 * writer produced? The test fills both forms, renders the filled PDF and the
 * blank template through [PdfRenderer], crops every planned widget's box on
 * both, and counts how many differ. The answer, with the PNGs, is published
 * for the report.
 */
@RunWith(AndroidJUnit4::class)
class ViewerTest {
    private val schema = SchemaLoader.load()
    private val templates = TemplateLoader(Fixtures.context)
    private val filler = FormFiller(templates)

    /**
     * A planned widget's /Rect in PDF user space, plus the transform of the
     * page it sits on: PdfRenderer draws the page's CropBox, turned clockwise
     * by /Rotate, scaled to the bitmap.
     */
    private data class Region(
        val pageIndex: Int,
        val rect: PDRectangle,
        val rotation: Int,
        val cropBox: PDRectangle,
    )

    private fun render(bytes: ByteArray, name: String): List<Bitmap> {
        val file = File(Fixtures.context.cacheDir, "viewer-$name.pdf")
        file.writeBytes(bytes)
        try {
            val pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            val renderer = PdfRenderer(pfd)
            try {
                val pages = mutableListOf<Bitmap>()
                for (i in 0 until renderer.pageCount) {
                    val page = renderer.openPage(i)
                    try {
                        val b = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
                        b.eraseColor(Color.WHITE)
                        page.render(b, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        pages.add(b)
                    } finally {
                        page.close()
                    }
                }
                return pages
            } finally {
                renderer.close()
                pfd.close()
            }
        } finally {
            file.delete()
        }
    }

    private fun ink(b: Bitmap): Int {
        val pixels = IntArray(b.width * b.height)
        b.getPixels(pixels, 0, b.width, 0, 0, b.width, b.height)
        return pixels.count { (it and 0xff) < 250 }
    }

    private fun regions(bytes: ByteArray, fd: FormDocument): List<Pair<String, Region>> = PdfThread.run {
        TemplateLoader.open(bytes).use { doc ->
            val acro = doc.documentCatalog.acroForm!!
            val pages = doc.pages.toList()
            fd.plan.fields.mapNotNull { pf ->
                val field = acro.getField(pf.name) as? PDTextField ?: return@mapNotNull null
                val widget = field.widgets.firstOrNull() ?: return@mapNotNull null
                val index = pages.indexOf(widget.page)
                if (index < 0) return@mapNotNull null
                val page = pages[index]
                pf.name to Region(index, widget.rectangle, page.rotation, page.cropBox)
            }
        }
    }

    /**
     * PDF user-space point -> pixel in a bitmap of [w]×[h] that holds the
     * page's CropBox turned clockwise by [rotation] degrees.
     */
    private fun toBitmap(x: Double, y: Double, rotation: Int, box: PDRectangle, w: Int, h: Int): Pair<Double, Double> {
        val llx = box.lowerLeftX.toDouble()
        val lly = box.lowerLeftY.toDouble()
        val urx = box.upperRightX.toDouble()
        val ury = box.upperRightY.toDouble()
        val r = ((rotation % 360) + 360) % 360
        // Unrotated page space, origin top-left, in points.
        val (px, py, pw, ph) = when (r) {
            90 -> listOf(y - lly, x - llx, ury - lly, urx - llx)
            180 -> listOf(urx - x, y - lly, urx - llx, ury - lly)
            270 -> listOf(ury - y, urx - x, ury - lly, urx - llx)
            else -> listOf(x - llx, ury - y, urx - llx, ury - lly)
        }
        return px * w / pw to py * h / ph
    }

    private fun crop(page: Bitmap, region: Region): Bitmap? {
        val r = region.rect
        val (ax, ay) = toBitmap(r.lowerLeftX.toDouble(), r.lowerLeftY.toDouble(), region.rotation, region.cropBox, page.width, page.height)
        val (bx, by) = toBitmap(r.upperRightX.toDouble(), r.upperRightY.toDouble(), region.rotation, region.cropBox, page.width, page.height)
        val left = max(0, min(page.width, floor(min(ax, bx)).toInt()))
        val top = max(0, min(page.height, floor(min(ay, by)).toInt()))
        val right = max(0, min(page.width, ceil(max(ax, bx)).toInt()))
        val bottom = max(0, min(page.height, ceil(max(ay, by)).toInt()))
        if (right - left <= 0 || bottom - top <= 0) return null
        return Bitmap.createBitmap(page, left, top, right - left, bottom - top)
    }

    private fun publish(fd: FormDocument, pages: List<Bitmap>, planned: Int, drawn: Int) {
        val storage = TestStorage()
        fun png(index: Int, path: String) {
            storage.openOutputFile(path).use { pages[index].compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        png(0, "viewer/${fd.formId}-page-1.png")
        png(pages.size - 1, "viewer/${fd.formId}-page-${pages.size}.png")
        val record = Json.Obj().also { o ->
            o["form"] = Json.Str(fd.formId)
            o["sdk"] = Json.Num(Build.VERSION.SDK_INT.toDouble())
            o["pages"] = Json.Num(pages.size.toDouble())
            o["planned"] = Json.Num(planned.toDouble())
            o["drawn"] = Json.Num(drawn.toDouble())
        }
        storage.openOutputFile("viewer/viewer-${fd.formId}.json")
            .use { it.write(record.writeJson().toByteArray(Charsets.UTF_8)) }
    }

    @Test
    fun countsPlannedValuesTheRendererDraws() {
        val answers = Fixtures.answers("both")
        var planned = 0
        var drawn = 0
        for (formId in listOf("ssa", "ds")) {
            val fd = FormDocuments.plan(schema, formId, answers, Fixtures.TODAY)
            val filled = filler.fill(fd)
            val filledPages = render(filled.bytes, "$formId-filled")
            val blankPages = render(templates.bytes(fd.spec.template), "$formId-blank")
            check(filledPages.size == blankPages.size + fd.addendum.size) {
                "$formId: ${filledPages.size} filled pages, ${blankPages.size} blank + ${fd.addendum.size} addendum"
            }
            check(filledPages.all { ink(it) > 0 } && blankPages.all { ink(it) > 0 }) {
                "$formId: a rendered page is blank"
            }

            var formPlanned = 0
            var formDrawn = 0
            for ((_, region) in regions(filled.bytes, fd)) {
                if (region.pageIndex >= filledPages.size || region.pageIndex >= blankPages.size) continue
                val fc = crop(filledPages[region.pageIndex], region) ?: continue
                val tc = crop(blankPages[region.pageIndex], region)
                if (tc == null) {
                    fc.recycle()
                    continue
                }
                formPlanned++
                if (!fc.sameAs(tc)) formDrawn++
                fc.recycle()
                tc.recycle()
            }
            planned += formPlanned
            drawn += formDrawn
            publish(fd, filledPages, formPlanned, formDrawn)
            filledPages.forEach { it.recycle() }
            blankPages.forEach { it.recycle() }
        }
        check(planned > 0) { "no planned widget was on a rendered page" }
        // API 35's PdfRenderer draws none of the widget appearances (measured
        // below and published in viewer-*.json). That is M1a's answer to the
        // preview question, not a test bug, and it is recorded in pdf/M1A.md:
        // the app must not rely on a native visual preview. What this test
        // still asserts is that every page renders with ink on it, above.
        println("viewer: PdfRenderer drew $drawn of $planned planned widgets on API ${Build.VERSION.SDK_INT}")
    }
}
