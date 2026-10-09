package org.ssa.assistant.pdf

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import java.time.LocalDate
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.pdf.FillPlan
import org.ssa.assistant.core.pdf.FormDocument

/** Test inputs and outputs shared by the :pdf instrumented tests. */
object Fixtures {
    /** NOW() in tools/golden/index.mjs, as a date. */
    val TODAY: LocalDate = LocalDate.of(2026, 9, 19)

    val NAMES = listOf("both", "starter-kit", "ds-only", "minimal")

    fun answers(name: String): Json.Obj {
        val stream = Fixtures::class.java.classLoader!!.getResourceAsStream("fixtures/answers/$name.json")
            ?: error("missing fixture $name.json")
        return JsonParser.parse(stream.readBytes().toString(Charsets.UTF_8)).asObject()!!
    }

    /**
     * The long case TODO.md asks for: 20 providers and 15 jobs (both kinds),
     * 14 long diagnoses, on top of the full answer set — well past the 12
     * providers anyone had checked.
     */
    fun long(): Json.Obj = answers("both").also { a ->
        fun grow(key: String, n: Int, edit: (Json.Obj, Int) -> Unit) {
            val seed = a[key]?.asArray()?.items?.mapNotNull { it.asObject() }.orEmpty()
            if (seed.isEmpty()) return
            a[key] = Json.Arr((0 until n).mapTo(mutableListOf()) { i ->
                Json.Obj(LinkedHashMap(seed[i % seed.size].entries)).also { edit(it, i + 1) }
            })
        }
        grow("providers", 20) { o, i -> o["name"] = Json.Str("Dr. Provider Number $i") }
        grow("jobs", 15) { o, i -> o["employer"] = Json.Str("Employer Number $i") }
        grow("ds_jobs", 15) { o, i -> o["employer"] = Json.Str("DS Employer Number $i") }
        a["conditions"] = Json.Arr((0 until 14).mapTo(mutableListOf()) { i ->
            Json.Obj().also { it["name"] = Json.Str("A fairly long diagnosis name number $i") }
        })
    }

    /** The plan as the fillplans golden records it, plus what was drawn. */
    fun planJson(plan: FillPlan): Json = Json.Obj().also { o ->
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

    /**
     * Writes a PDF and its record through TestStorage; AGP pulls them into
     * build/outputs/connected_android_test_additional_output/ after the run.
     */
    fun publish(case: String, fd: FormDocument, answers: Json.Obj, filled: FormFiller.Filled) {
        val storage = TestStorage()
        val base = "pdfs/$case-${fd.formId}"
        storage.openOutputFile("$base.pdf").use { it.write(filled.bytes) }
        val record = Json.Obj().also { o ->
            o["case"] = Json.Str(case)
            o["form"] = Json.Str(fd.formId)
            o["today"] = Json.Str(TODAY.toString())
            o["answers"] = answers
            o["plan"] = planJson(fd.plan)
            o["addendumPages"] = Json.Num(fd.addendum.size.toDouble())
            o["templateBytes"] = Json.Num(filled.templateSize.toDouble())
            o["bytes"] = Json.Num(filled.bytes.size.toDouble())
            o["timings"] = Json.Obj().also { t ->
                t["loadMs"] = Json.Num(filled.timings.loadMs.toDouble())
                t["fillMs"] = Json.Num(filled.timings.fillMs.toDouble())
                t["saveMs"] = Json.Num(filled.timings.saveMs.toDouble())
                t["checkMs"] = Json.Num(filled.timings.checkMs.toDouble())
            }
            o["device"] = Json.Str("${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} API ${android.os.Build.VERSION.SDK_INT}")
        }
        storage.openOutputFile("$base.json").use { it.write(record.writeJson().toByteArray(Charsets.UTF_8)) }
    }

    val context get() = InstrumentationRegistry.getInstrumentation().targetContext
}
