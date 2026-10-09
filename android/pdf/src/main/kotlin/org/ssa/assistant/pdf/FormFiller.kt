package org.ssa.assistant.pdf

import com.tom_roush.pdfbox.pdmodel.PDDocument
import java.io.ByteArrayOutputStream
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.WorksheetDocument

/**
 * One export, end to end: load the pinned template, apply the plan, append
 * the addendum, save to memory, and self-check the saved bytes. Nothing is
 * written to disk. A form whose self-check fails is never offered: the
 * caller gets [Outcome.Worksheet] and says why.
 */
class FormFiller(private val templates: TemplateLoader) {

    /** Milliseconds for each stage, for the spike's budget table. */
    data class Timings(val loadMs: Long, val fillMs: Long, val saveMs: Long, val checkMs: Long) {
        val totalMs: Long get() = loadMs + fillMs + saveMs + checkMs
    }

    class Filled(val bytes: ByteArray, val check: PdfSelfCheck.Result, val missing: List<String>, val timings: Timings, val templateSize: Int)

    sealed interface Outcome {
        class Form(val filled: Filled) : Outcome
        /** The form could not be produced; [reason] names a check, never a value. */
        class Worksheet(val bytes: ByteArray, val reason: String) : Outcome
    }

    /** Fill one form. Throws only if the template itself is unusable ([TemplateException]). */
    fun fill(fd: FormDocument): Filled {
        var t = System.nanoTime()
        fun lap(): Long { val now = System.nanoTime(); val ms = (now - t) / 1_000_000; t = now; return ms }

        val template = templates.bytes(fd.spec.template)
        val (bytes, missing, times) = PdfThread.run {
            TemplateLoader.open(template).use { doc ->
                val load = lap()
                val missing = AcroFormWriter.apply(doc, fd)
                AddendumRenderer.render(doc, fd.addendum)
                val fill = lap()
                val out = ByteArrayOutputStream(template.size * 2)
                doc.save(out)
                Triple(out.toByteArray(), missing, load to fill)
            }
        }
        val save = lap()
        val check = PdfSelfCheck.check(bytes, template, fd)
        val checkMs = lap()
        val problems = if (missing.isEmpty()) check else PdfSelfCheck.Result(
            check.problems + missing.map { PdfSelfCheck.Problem(it, "is not in the template") },
            check.pages, check.fields, check.readBack
        )
        return Filled(bytes, problems, missing, Timings(times.first, times.second, save, checkMs), template.size)
    }

    /**
     * What the user is offered: the filled form when its self-check is clean,
     * otherwise the plain worksheet of the same answers.
     */
    fun export(fd: FormDocument, worksheet: () -> WorksheetDocument): Outcome {
        val filled = try { fill(fd) } catch (e: TemplateException) {
            return Outcome.Worksheet(WorksheetBuilder.build(worksheet()), "the template could not be loaded")
        }
        if (filled.check.ok) return Outcome.Form(filled)
        val first = filled.check.problems.first()
        return Outcome.Worksheet(WorksheetBuilder.build(worksheet()), "${first.field ?: "the form"} ${first.check}")
    }
}

/** buildWorksheet(): the answers on plain pages, from nothing. */
object WorksheetBuilder {
    fun build(w: WorksheetDocument): ByteArray = PdfThread.run {
        PDDocument().use { doc ->
            doc.documentInformation.title = w.title
            doc.documentInformation.subject = w.subject
            doc.documentInformation.creator = w.creator
            AddendumRenderer.render(doc, w.pages)
            ByteArrayOutputStream().also { doc.save(it) }.toByteArray()
        }
    }
}
