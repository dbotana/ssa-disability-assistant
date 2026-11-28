package org.ssa.assistant.core.app

import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.pdf.ExportNames
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.FormVersions
import org.ssa.assistant.core.pdf.PdfReadPort
import org.ssa.assistant.core.pdf.PdfSelfCheck
import org.ssa.assistant.core.pdf.WriterJson
import org.ssa.assistant.core.schema.Schema

/**
 * The platform's PDF fill: the JS writer in JavaScriptCore on iOS, pdf-lib in
 * a WebView on Android (plan, Phase A4).
 *
 * A callback interface, never `suspend`: Swift implements it, and a Swift
 * method cannot suspend a Kotlin coroutine. `ExportJob` wraps the callback in
 * `suspendCancellableCoroutine` (AGENTS.md, "Swift implements only callback
 * interfaces").
 */
interface PdfFillService {
    /**
     * Fill [template] with the plan and draw list, both as the JSON the writer
     * reads ([WriterJson]). Exactly one of [done]'s arguments is non-null.
     */
    fun fill(
        template: ByteArray,
        planJson: String,
        drawListJson: String?,
        title: String,
        creator: String,
        done: (bytes: ByteArray?, error: String?) -> Unit,
    )
}

/**
 * Exporting both forms (plan, Phase A4): plan every version of each chosen
 * form, fill it, re-read the finished bytes with [PdfSelfCheck], and name the
 * file.
 *
 * A self-check problem outside [KNOWN_CONVENTION_CHECKS] fails that file. The
 * six allowed problems are pdf-lib's documented deviation from the Android
 * writer's `/HelvWA` convention (ios/SPIKES.md §1 and §8, spike 3a's
 * provisional fallback); every other problem is a real defect.
 */
class ExportJob(
    private val schema: Schema,
    private val today: CivilDate,
    private val i18n: I18n = I18n(schema),
    /** The template bytes for a form id ("ssa" or "ds"), as the app has them. */
    private val templateFor: (String) -> ByteArray,
    private val fill: PdfFillService,
    private val read: PdfReadPort,
) {
    /** A finished, self-checked file the shell can save or share. */
    class Ready(
        val formId: String,
        /** "lingala" (version A) or "english" (version B), or null for a single English version. */
        val version: String?,
        val fileName: String,
        val bytes: ByteArray,
        val selfCheck: PdfSelfCheck.Result,
    )

    /** A file that was not produced. [check] is a self-check string, never an answer. */
    class Failed(val formId: String, val version: String?, val check: String)

    class Outcome(val ready: List<Ready>, val failed: List<Failed>) {
        val ok: Boolean get() = failed.isEmpty() && ready.isNotEmpty()
    }

    /**
     * Fill [forms] from [answers]. A missing template or a fill that throws
     * fails that form; the others still go ahead.
     */
    suspend fun export(
        forms: List<String>,
        answers: Json.Obj,
        overlay: FormVersions.Overlay = FormVersions.Overlay(),
        lang: String = "en",
    ): Outcome {
        val ready = mutableListOf<Ready>()
        val failed = mutableListOf<Failed>()

        for (formId in forms) {
            val spec = schema.formSpecs[formId]
            if (spec == null) {
                failed.add(Failed(formId, null, "unknown form"))
                continue
            }
            val template = try {
                templateFor(formId)
            } catch (e: Exception) {
                failed.add(Failed(formId, null, "template unavailable"))
                continue
            }
            val versions = try {
                FormVersions.plan(schema, formId, answers, overlay, today, lang, i18n)
            } catch (e: Exception) {
                failed.add(Failed(formId, null, "cannot be planned"))
                continue
            }
            val both = versions.b != null
            val toTry = mutableListOf<Pair<FormVersions.Version, String?>>()
            // A Lingala session ships version A as "-lingala" and version B as
            // "-english" (ExportNames.VERSION_SUFFIXES); a single English
            // version keeps the plain name, as the web does today.
            toTry.add(versions.a to if (both) "lingala" else null)
            versions.b?.let { toTry.add(it to "english") }

            val title = i18n.translate(spec.title, lang)
            val creator = i18n.translate(FORM_CREATOR, lang)

            for ((version, suffix) in toTry) {
                val document: FormDocument = version.document
                val bytes = try {
                    fillAsync(
                        template = template,
                        planJson = WriterJson.plan(version.plan).writeJson(),
                        drawListJson = WriterJson.drawList(document)?.writeJson(),
                        title = title,
                        creator = creator,
                    )
                } catch (e: Exception) {
                    failed.add(Failed(formId, suffix, "could not be written"))
                    continue
                }
                val check = PdfSelfCheck.check(bytes, template, document, read)
                val unexpected = check.problems.firstOrNull { it.check !in KNOWN_CONVENTION_CHECKS }
                if (unexpected != null) {
                    failed.add(Failed(formId, suffix, unexpected.check))
                    continue
                }
                val name = ExportNames.exportFileName(schema, formId, version.answers, today, suffix)
                ready.add(Ready(formId, suffix, name, bytes, check))
            }
        }
        return Outcome(ready, failed)
    }

    private suspend fun fillAsync(
        template: ByteArray,
        planJson: String,
        drawListJson: String?,
        title: String,
        creator: String,
    ): ByteArray = suspendCancellableCoroutine { cont ->
        var answered = false
        try {
            fill.fill(template, planJson, drawListJson, title, creator) { bytes, error ->
                if (answered) return@fill
                answered = true
                if (bytes != null) cont.resume(bytes)
                else cont.resumeWithException(IllegalStateException(error ?: "the writer returned nothing"))
            }
        } catch (e: Exception) {
            if (!answered) {
                answered = true
                cont.resumeWithException(e)
            }
        }
    }

    companion object {
        /** The creator string every filled form records (src/fill.js). */
        const val FORM_CREATOR = "Voice Assistant for Disability Forms"

        /**
         * The six self-check problems pdf-lib is known to produce, copied
         * verbatim from `knownConventionChecks` in
         * ios/CoreCrypto/Tests/SsaPdfTests/PdfSpikeTests.swift.
         */
        val KNOWN_CONVENTION_CHECKS: Set<String> = setOf(
            "/DR has no WinAnsi /HelvWA",
            "DA is not /HelvWA at the planned size",
            "widget DA is not /HelvWA at the planned size",
            "appearance has no WinAnsi /HelvWA",
            "appearance font is not /HelvWA at the planned size",
            "appearance changed though the plan left it alone",
        )
    }
}
