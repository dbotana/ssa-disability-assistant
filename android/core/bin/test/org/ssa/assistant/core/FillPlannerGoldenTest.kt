package org.ssa.assistant.core

import java.time.LocalDate
import org.junit.Test
import org.ssa.assistant.core.forms.mapDsIntake
import org.ssa.assistant.core.forms.mapSsaStarterKit
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.pdf.FillPlan
import org.ssa.assistant.core.pdf.HelveticaMetrics
import org.ssa.assistant.core.pdf.TemplateManifest
import org.ssa.assistant.core.pdf.planFill
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The `fillplans` golden: the answer fixtures plus ~200 seeded random answer
 * sets, each re-planned from the answers it records. The plan — fit
 * decisions, overflow, tables and sections — must agree exactly, because the
 * Android writer draws the same fields at the same sizes.
 */
class FillPlannerGoldenTest {

    private val schema = SchemaLoader.load()
    private val golden = Golden.load("fillplans")
    private val metrics = WrappedMetrics(HelveticaMetrics.HELVETICA)
    private val today = LocalDate.of(2026, 9, 19)   // NOW() in index.mjs, as a local date

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
            Json.Obj().also { e ->
                e["label"] = Json.Str(label)
                e["value"] = Json.Str(value)
            }
        })
        o["radios"] = Json.Obj().also { r ->
            plan.radios.forEach { (k, v) -> r[k] = Json.Str(v) }
        }
        o["checks"] = Json.Arr(plan.checks.mapTo(mutableListOf()) { Json.Str(it) })
        o["tables"] = Json.Arr(plan.tables.toMutableList())
        o["sections"] = Json.Arr(plan.sections.toMutableList())
    }

    @Test
    fun fillplans() {
        val plans = golden.asObject()!!["plans"]!!.asArray()!!.items
        check(plans.size >= 400) { "only ${plans.size} fill plans" }
        for ((i, raw) in plans.withIndex()) {
            val p = raw.asObject()!!
            val form = p["form"]!!.asString()!!
            val answers = p["answers"]!!.asObject()!!
            val where = "fillplans[$i] ${p["fixture"]?.asString()} $form"

            val mapping = when (form) {
                "ssa" -> mapSsaStarterKit(schema, answers)
                else -> mapDsIntake(schema, answers, today)
            }
            val plan = planFill(mapping, TemplateManifest.forForm(form), metrics)
            Golden.assertTree("fillplans", where, planTree(plan), p["plan"]!!)
        }
    }

    @Test
    fun manifestContract() {
        // Neither form may grow comb fields, MaxLen or /Opt: the appearance
        // writer draws free text inside the box and knows nothing of them.
        for (form in listOf("ssa", "ds")) {
            val manifest = TemplateManifest.forForm(form)
            for ((name, entry) in manifest.fields) {
                if (entry.type != "text") continue
                check(!entry.comb) { "$form \"$name\" grew a comb flag" }
                check(entry.maxLen == null) { "$form \"$name\" grew MaxLen" }
                check(entry.box.width > 0 && entry.box.height > 0) { "$form \"$name\" has no box" }
            }
            val kinds = manifest.fields.values.groupingBy { it.type }.eachCount()
            check(kinds.containsKey("text")) { "$form has no text fields" }
        }
    }

    @Test
    fun manifestDasAreParsed() {
        // The golden records each DA as parseDa()'s { font, size, raw }; the
        // Kotlin entry must carry the same font and size, field and widgets.
        val raw = org.ssa.assistant.core.schema.loadResource("golden/templateManifest.json").asObject()!!
        var seen = 0
        for (form in listOf("ssa", "ds")) {
            val manifest = TemplateManifest.forForm(form)
            for ((name, v) in raw[form]!!.asObject()!!["fields"]!!.asObject()!!.entries) {
                val entry = manifest.field(name)!!
                val o = v.asObject()!!
                fun same(where: String, golden: Json?, da: org.ssa.assistant.core.pdf.Da?) {
                    val g = golden?.asObject()
                    check((g == null) == (da == null)) { "$form \"$name\" $where DA present: golden ${g != null}, Kotlin ${da != null}" }
                    if (g != null && da != null) {
                        check(g["font"]!!.asString() == da.font) { "$form \"$name\" $where DA font" }
                        check((g["size"] as? Json.Num)?.value == da.size) { "$form \"$name\" $where DA size" }
                        seen++
                    }
                }
                same("field", o["da"]?.takeIf { it !== Json.Null }, entry.da)
                o["widgets"]!!.asArray()!!.items.forEachIndexed { i, w ->
                    same("widget $i", w.asObject()!!["da"]?.takeIf { it !== Json.Null }, entry.widgets[i])
                }
            }
        }
        check(seen > 100) { "only $seen DAs parsed" }
    }
}
