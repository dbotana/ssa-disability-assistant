package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.fixture
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.pdf.FormDocument
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.pdf.FormVersions
import org.ssa.assistant.core.pdf.TemplateManifest
import org.ssa.assistant.core.pdf.WriterJson
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * Plan A2: the writer's two JSON documents, against the `versions` cases of
 * the `fillplans` golden, matched exactly.
 */
class WriterJsonGoldenTest {
    private val schema = SchemaLoader.load()
    private val i18n = I18n(schema)
    private val today = CivilDate(2026, 9, 19)

    @Test
    fun everyGoldenVersionHasTheSamePlanAndDrawList() {
        val versions = Golden.load("fillplans").asObject()!!["versions"]!!.asArray()!!.items
            .map { it.asObject()!! }
        assertTrue(versions.size >= 6, "only ${versions.size} version cases")
        var checked = 0
        for (v in versions) {
            val form = v["form"]!!.asString()!!
            val out = FormVersions.plan(
                schema, form, v["answers"]!!.asObject()!!,
                FormVersions.Overlay.fromJson(v["overlay"]), today, "en", i18n,
            )
            for ((label, version) in listOf("a" to out.a, "b" to out.b)) {
                val expected = v[label]!!
                if (expected === Json.Null) {
                    assertNull(version, "$form $label: JS made no version")
                    continue
                }
                assertNotNull(version)
                val e = expected.asObject()!!
                Golden.assertTree("fillplans", "${v["fixture"]!!.asString()} $form $label plan", WriterJson.plan(version.plan), e["plan"]!!)
                val drawList = WriterJson.drawList(version.document)
                assertNotNull(drawList, "$form $label: the golden has addendum pages")
                Golden.assertTree(
                    "fillplans", "${v["fixture"]!!.asString()} $form $label draw list",
                    drawList, Json.Obj().also { it["pages"] = e["pages"]!! },
                )
                checked++
            }
        }
        assertTrue(checked >= 6, "only $checked versions checked")
    }

    @Test
    fun anEmptyAddendumHasNoDrawList() {
        // The JS writer is handed no draw list at all when there is nothing to
        // append (`if (drawList && drawList.pages.length)` in src/pdf-writer.js).
        val plan = FormDocuments.planOnly(schema, "ssa", fixture("both"), today, "en", i18n)
        val spec = schema.formSpecs.getValue("ssa")
        val doc = FormDocument("ssa", spec, TemplateManifest.forForm("ssa"), plan, emptyList())
        assertNull(WriterJson.drawList(doc))
    }

    @Test
    fun thePlanJsonIsParseableAndCarriesEveryField() {
        val plan = FormDocuments.planOnly(schema, "ssa", fixture("both"), today, "en", i18n)
        val parsed = org.ssa.assistant.core.json.JsonParser.parse(WriterJson.plan(plan).writeJson()).asObject()!!
        assertEquals(plan.fields.size, parsed["fields"]!!.asArray()!!.items.size)
        assertEquals(plan.missing, parsed["missing"]!!.asArray()!!.items.map { it.asString() })
    }
}
