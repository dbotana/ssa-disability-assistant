package org.ssa.assistant.core.pdf

import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.deepCopy
import org.ssa.assistant.core.schema.Schema

/**
 * Port of src/versions.js (Step 2 item 5): the two versions of a form in a
 * Lingala session (plan 4.7). Version A is the answers as given; version B
 * replaces each Lingala free-text answer on a `translate: true` question with
 * its English translation, marked [MT], and lists the originals in an
 * appendix. B exists only when a translation changes the plan.
 *
 * Both versions are planned by FormDocuments, the path a single-version
 * export already takes, so each goes through the same FillPlanner and, in
 * :pdf, the same PdfSelfCheck. Pinned by the `versions` cases of the
 * fillplans golden (FormVersionsGoldenTest).
 */
object FormVersions {
    const val MT_MARK = "[MT]"
    const val NOTE_A = "Some answers were given in Lingala and are written as spoken. The applicant's preferred language is Lingala. Please provide an interpreter."
    const val NOTE_B = "Answers marked [MT] were translated from Lingala by software on the applicant's phone and have not been checked by a translator. The applicant's own words follow in the appendix."
    const val APPENDIX_TITLE = "Answers in the applicant's own words (Lingala)"

    /**
     * The translations a session holds: [inputLangs] are { id, loopId?,
     * loopIndex?, lang } and [translations] are { id, loopId?, loopIndex?,
     * source, text, by }, as in src/versions.js.
     */
    data class Overlay(val inputLangs: List<Json.Obj> = emptyList(), val translations: List<Json.Obj> = emptyList()) {
        companion object {
            fun fromJson(j: Json?): Overlay {
                val o = j?.asObject() ?: return Overlay()
                fun list(k: String) = o[k]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()
                return Overlay(list("inputLangs"), list("translations"))
            }
        }
    }

    data class Field(val id: String, val loopId: String?, val loopIndex: Int?)

    /** A Lingala free-text answer, and its English when version B uses one. */
    data class Entry(val field: Field, val question: String, val original: String, val english: String? = null)

    class Version(
        val version: String,
        val answers: Json.Obj,
        val document: FormDocument,
        val notes: List<String>,
        val appendix: List<Pair<String, String>>,
    ) {
        val plan: FillPlan get() = document.plan
    }

    class Versions(val a: Version, val b: Version?)

    private class Translatable(val id: String, val loopId: String?, val prompt: String, val itemLabel: String?)

    private fun translatable(schema: Schema): List<Translatable> {
        val out = mutableListOf<Translatable>()
        for (section in schema.sections) {
            for (q in section["questions"]?.asArray()?.items ?: emptyList()) {
                val node = q.asObject() ?: continue
                if (node["type"]?.asString() == "loop") {
                    val loopId = node["id"]?.asString() ?: continue
                    val label = node["itemLabel"]?.asString() ?: loopId
                    for (f in node["fields"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()) {
                        if (f["translate"] === Json.True) out.add(Translatable(f["id"]!!.asString()!!, loopId, f["prompt"]?.asString() ?: "", label))
                    }
                } else if (node["translate"] === Json.True) {
                    out.add(Translatable(node["id"]!!.asString()!!, null, node["prompt"]?.asString() ?: "", null))
                }
            }
        }
        return out
    }

    private fun sameField(o: Json.Obj, f: Field): Boolean {
        val loopId = o["loopId"]?.asString()
        if (o["id"]?.asString() != f.id || loopId != f.loopId) return false
        if (loopId == null) return true
        return ((o["loopIndex"] as? Json.Num)?.value ?: 0.0) == (f.loopIndex ?: 0).toDouble()
    }

    /** lingalaFreeText() in src/versions.js, in schema order. */
    fun lingalaFreeText(schema: Schema, answers: Json.Obj, overlay: Overlay): List<Entry> {
        val out = mutableListOf<Entry>()
        fun lingala(f: Field) = overlay.inputLangs.any { it["lang"]?.asString() == "ln" && sameField(it, f) }
        fun text(v: Json?) = (v as? Json.Str)?.value?.takeIf { it.isNotBlank() }
        for (t in translatable(schema)) {
            if (t.loopId == null) {
                val v = text(answers[t.id]) ?: continue
                val f = Field(t.id, null, null)
                if (lingala(f)) out.add(Entry(f, t.prompt, v))
                continue
            }
            val items = (answers[t.loopId] as? Json.Arr)?.items ?: continue
            items.forEachIndexed { i, item ->
                val v = text(item.asObject()?.get(t.id)) ?: return@forEachIndexed
                val f = Field(t.id, t.loopId, i)
                if (lingala(f)) out.add(Entry(f, "${t.itemLabel} ${i + 1}: ${t.prompt}", v))
            }
        }
        return out
    }

    /** overlayAnswers() in src/versions.js: version B's answers, and what was translated. */
    fun overlayAnswers(schema: Schema, answers: Json.Obj, overlay: Overlay): Pair<Json.Obj, List<Entry>> {
        val out = answers.deepCopy() as Json.Obj
        val translated = mutableListOf<Entry>()
        for (e in lingalaFreeText(schema, answers, overlay)) {
            val t = overlay.translations.firstOrNull { sameField(it, e.field) } ?: continue
            val text = (t["text"] as? Json.Str)?.value?.trim() ?: ""
            if (t["source"]?.asString() != e.original || text.isEmpty() || text == e.original) continue
            val english = if (t["by"]?.asString() == "person") text else "$MT_MARK $text"
            if (e.field.loopId != null) {
                ((out[e.field.loopId] as Json.Arr).items[e.field.loopIndex!!] as Json.Obj)[e.field.id] = Json.Str(english)
            } else {
                out[e.field.id] = Json.Str(english)
            }
            translated.add(e.copy(english = english))
        }
        return out to translated
    }

    /** planVersions() in src/versions.js, for one form. */
    fun plan(
        schema: Schema,
        formId: String,
        answers: Json.Obj,
        overlay: Overlay,
        today: CivilDate,
        lang: String = "en",
        i18n: I18n = I18n(schema),
    ): Versions {
        val lingala = lingalaFreeText(schema, answers, overlay)
        val planA = FormDocuments.planOnly(schema, formId, answers, today, lang, i18n)
        val notesA = if (lingala.isNotEmpty()) listOf(NOTE_A) else emptyList()
        val a = Version("a", answers, FormDocuments.document(schema, formId, planA, notesA, emptyList(), lang, i18n), notesA, emptyList())
        if (lingala.isEmpty()) return Versions(a, null)
        val (answersB, translated) = overlayAnswers(schema, answers, overlay)
        if (translated.isEmpty()) return Versions(a, null)
        val planB = FormDocuments.planOnly(schema, formId, answersB, today, lang, i18n)
        if (planB == planA) return Versions(a, null)
        val appendix = translated.map { it.question to it.original }
        val notesB = listOf(NOTE_B)
        return Versions(a, Version("b", answersB, FormDocuments.document(schema, formId, planB, notesB, appendix, lang, i18n), notesB, appendix))
    }
}
