package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.fixture
import org.ssa.assistant.core.golden.pagesTree
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.pdf.ExportNames
import org.ssa.assistant.core.pdf.FillPlan
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.pdf.FormVersions
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * Step 2 items 5 and 8, against the JS reference:
 *  - the `versions` cases of the fillplans golden: plan A and plan B from a
 *    fixed translation overlay, each with its notes, appendix, addendum
 *    content and addendum pages;
 *  - the `exportnames` golden: file names with the version suffix;
 *  - the input matrix of Step 2 item 4, read from the i18n golden.
 */
class FormVersionsGoldenTest {
    private val schema = SchemaLoader.load()
    private val i18n = I18n(schema)
    private val today = CivilDate(2026, 9, 19)

    private fun planTree(plan: FillPlan): Json = Json.Obj().also { o ->
        o["fields"] = Json.Arr(plan.fields.mapTo(mutableListOf()) { f ->
            Json.Obj().also { e ->
                e["name"] = Json.Str(f.name)
                e["value"] = Json.Str(f.value)
                e["fit"] = Json.Obj().also { fit ->
                    fit["size"] = Json.Num(f.fit.size)
                    fit["text"] = Json.Str(f.fit.text)
                    fit["cut"] = Json.bool(f.fit.cut)
                    fit["lines"] = Json.Arr(f.fit.lines.mapTo(mutableListOf()) { Json.Str(it) })
                }
                e["label"] = Json.Str(f.label)
            }
        })
        o["missing"] = Json.Arr(plan.missing.mapTo(mutableListOf()) { Json.Str(it) })
        o["overflowText"] = Json.Arr(plan.overflowText.mapTo(mutableListOf()) { (label, value) ->
            Json.Obj().also { e -> e["label"] = Json.Str(label); e["value"] = Json.Str(value) }
        })
        o["radios"] = Json.Obj().also { r -> plan.radios.forEach { (k, v) -> r[k] = Json.Str(v) } }
        o["checks"] = Json.Arr(plan.checks.mapTo(mutableListOf()) { Json.Str(it) })
        o["tables"] = Json.Arr(plan.tables.toMutableList())
        o["sections"] = Json.Arr(plan.sections.toMutableList())
    }

    private fun assertVersion(where: String, form: String, actual: FormVersions.Version?, expected: Json) {
        if (expected === Json.Null) {
            assertNull(actual, "$where: JS made no version, Kotlin did")
            return
        }
        assertNotNull(actual, "$where: JS made this version, Kotlin did not")
        val e = expected.asObject()!!
        Golden.assertTree("fillplans", "$where answers", actual.answers, e["answers"]!!)
        Golden.assertTree("fillplans", "$where plan", planTree(actual.plan), e["plan"]!!)
        assertEquals(e["notes"]!!.asArray()!!.items.map { it.asString() }, actual.notes, "$where notes")
        assertEquals(
            e["appendix"]!!.asArray()!!.items.map { it.asObject()!!.let { r -> r["label"]!!.asString() to r["value"]!!.asString() } },
            actual.appendix, "$where appendix",
        )
        val content = FormDocuments.addendumContentJson(schema.formSpecs.getValue(form), actual.plan, "en", i18n, actual.notes, actual.appendix)
        Golden.assertTree("fillplans", "$where addendum content", content, e["content"]!!)
        Golden.assertTree("fillplans", "$where addendum pages", pagesTree(actual.document.addendum), e["pages"]!!)
    }

    @Test
    fun bothVersionsMatchTheJsReference() {
        val versions = Golden.load("fillplans").asObject()!!["versions"]!!.asArray()!!.items.map { it.asObject()!! }
        assertTrue(versions.size >= 6, "only ${versions.size} version cases")
        var withB = 0
        for (v in versions) {
            val form = v["form"]!!.asString()!!
            val where = "versions ${v["fixture"]!!.asString()} $form"
            val out = FormVersions.plan(schema, form, v["answers"]!!.asObject()!!, FormVersions.Overlay.fromJson(v["overlay"]), today, "en", i18n)
            assertVersion("$where A", form, out.a, v["a"]!!)
            assertVersion("$where B", form, out.b, v["b"]!!)
            if (out.b != null) withB++
        }
        assertTrue(withB >= 2, "the golden pins version B for both forms")
    }

    @Test
    fun aSingleVersionIsExactlyTheOldDocument() {
        // English sessions keep today's export: no note, no appendix, and the
        // same addendum FormDocuments.plan() always made.
        val answers = fixture("both")
        for (form in listOf("ssa", "ds")) {
            val out = FormVersions.plan(schema, form, answers, FormVersions.Overlay(), today, "en", i18n)
            assertNull(out.b)
            val old = FormDocuments.plan(schema, form, answers, today, "en", i18n)
            assertEquals(old.plan, out.a.plan)
            assertEquals(old.addendum, out.a.document.addendum)
        }
    }

    @Test
    fun exportNamesMatchTheJsReference() {
        val cases = Golden.load("exportnames").asObject()!!["cases"]!!.asArray()!!.items.map { it.asObject()!! }
        assertTrue(cases.size >= 60)
        for (c in cases) {
            val d = c["date"]!!.asObject()!!
            val date = CivilDate(
                (d["year"] as Json.Num).value.toInt(), (d["month"] as Json.Num).value.toInt(), (d["day"] as Json.Num).value.toInt(),
            )
            val version = c["version"]?.takeIf { it !== Json.Null }?.asString()
            assertEquals(c["name"]!!.asString(), ExportNames.exportFileName(schema, c["formId"]!!.asString()!!, c["answers"]!!.asObject()!!, date, version), "$c")
        }
    }

    @Test
    fun theInputMatrixIsReadFromTheLanguageTable() {
        val languages = Golden.load("i18n").asObject()!!["languages"]!!.asObject()!!
        for ((lang, entry) in languages.entries) {
            val stt = entry.asObject()!!["stt"]!!.asObject()!!
            val m = i18n.inputMatrix(lang)
            assertEquals(stt["engine"]!!.asString(), m.engine, "$lang engine")
            assertEquals(stt["lid"] === Json.True, m.lid, "$lang lid")
            assertEquals(stt["adapters"]!!.asArray()!!.items.map { it.asString() }, m.adapters, "$lang adapters")
            assertEquals(stt["alwaysReadBack"] === Json.True, m.alwaysReadBack, "$lang alwaysReadBack")
            assertEquals(stt["lexicons"]!!.asArray()!!.items.map { it.asString() }, m.lexicons, "$lang lexicons")
            assertEquals(stt["voiceTypes"]!!.asString() == "all", m.voiceTypes == null, "$lang voiceTypes")
        }
        val ln = i18n.inputMatrix("ln")
        assertEquals("mms", ln.engine)
        assertEquals(listOf("lin", "fra", "eng"), ln.adapters)
        assertTrue(ln.lid && ln.alwaysReadBack && ln.voiceOffered("ssn") && ln.voiceOffered("text"))
        assertEquals(listOf("ln", "fr"), ln.lexicons)
    }
}
