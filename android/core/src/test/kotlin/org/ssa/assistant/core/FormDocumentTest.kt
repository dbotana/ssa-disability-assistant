package org.ssa.assistant.core

import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.fixture
import org.ssa.assistant.core.golden.pagesTree
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.pdf.FormDocuments
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * FormDocuments assembles what fillTemplate() and buildWorksheet() hand the
 * layout: the spec's exported wording plus the plan's overflow, tables and
 * sections. The `addendum` golden recorded the pages the reference drew from
 * the same answers, so the assembly — not just the layout — is pinned here.
 */
class FormDocumentTest {
    private val schema = SchemaLoader.load()
    private val golden = Golden.load("addendum").asObject()!!
    private val today = LocalDate.of(2026, 9, 19)   // NOW() in index.mjs

    private fun expectedPages(key: String): Json = golden[key]!!.asObject()!!["pages"]!!

    @Test
    fun starterKitAddendumIsTheReferences() {
        val doc = FormDocuments.plan(schema, "ssa", fixture("both"), today)
        Golden.assertTree("addendum", "ssa pages", pagesTree(doc.addendum), expectedPages("ssa"))
        assertEquals("forms/ssa-adult-disability-starter-kit-64-110.pdf", doc.spec.template)
    }

    @Test
    fun dsAddendumIsTheReferences() {
        // index.mjs overflows the DS form with 14 long diagnoses.
        val answers = fixture("both").also { a ->
            a["conditions"] = Json.Arr((0 until 14).mapTo(mutableListOf()) { i ->
                Json.Obj().also { it["name"] = Json.Str("A fairly long diagnosis name number $i") }
            })
        }
        val doc = FormDocuments.plan(schema, "ds", answers, today)
        Golden.assertTree("addendum", "ds pages", pagesTree(doc.addendum), expectedPages("ds"))
        check(doc.plan.overflowText.isNotEmpty()) { "the DS case overflowed nothing" }
    }

    @Test
    fun worksheetIsTheReferences() {
        val w = FormDocuments.worksheet(schema, fixture("both"), today)
        Golden.assertTree("addendum", "worksheet pages", pagesTree(w.pages), expectedPages("worksheet"))
        assertEquals("Disability Forms Worksheet", w.title)
    }

    @Test
    fun aFormWithNothingToAddHasNoAddendum() {
        val doc = FormDocuments.plan(schema, "ds", fixture("minimal"), today)
        if (doc.plan.overflowText.isEmpty() && doc.plan.tables.isEmpty() && doc.plan.sections.isEmpty()) {
            assertEquals(emptyList<Any>(), doc.addendum)
        }
    }

    @Test
    fun valuesAreWinAnsiBeforeTheyArePlanned() {
        val answers = fixture("both").also { it["first_name"] = Json.Str("Łukasz") }
        val doc = FormDocuments.plan(schema, "ds", answers, today)
        val values = doc.plan.fields.map { it.value }
        check(values.none { it.contains('Ł') }) { "a value reached the plan without toWinAnsi" }
        check(values.any { it.contains("Lukasz") }) { "the folded name is missing" }
    }

    @Test
    fun filenames() {
        val spec = schema.formSpecs["ssa"]!!
        val a = Json.Obj().also { it["first_name"] = Json.Str("José"); it["last_name"] = Json.Str("Ñúñez de la Cruz") }
        assertEquals("ssa-starter-kit-Jose-Nunez-de-la-Cruz-2026-09-19.pdf", FormDocuments.filename(spec, a, today))
        assertEquals("maine-ds-intake-2026-01-02.pdf",
            FormDocuments.filename(schema.formSpecs["ds"]!!, Json.Obj(), LocalDate.of(2026, 1, 2)))
    }
}
