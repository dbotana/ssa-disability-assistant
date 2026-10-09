package org.ssa.assistant.core.forms

import org.ssa.assistant.core.Option
import org.ssa.assistant.core.pdf.Mapping
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.parse.choiceLabel
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.findQuestion
import org.ssa.assistant.core.schema.optionsFromSchema

/**
 * Port of src/forms/ssa-starter-kit.js: answers -> fields of Social
 * Security's Adult Disability Starter Kit (Publication No. 64-110, June 2024).
 *
 * Field names are the PDF's own. The first row of each worksheet table is
 * named after the instruction text above it, cut at 100 characters, so those
 * names are copied here exactly rather than generated.
 */

private val CHECKLIST = mapOf(
    "identity" to "Your date of birth, place of birth, and Social Security Number",
    "spouses" to "The name, Social Security Number, and date of birth or age of your current spouse and any former spo",
    "references" to "If available, the name, address, and phone number of two people (other than your healthcare provider",
    "bank" to "Checking or savings account number, including the bank’s 9-digit routing number, for electronic depo",
    "workersComp" to "If applicable, workers’ compensation or other disability benefit information including the date of i",
    "records" to "Records already in your possession related to your medical condition(s). You do not need to ask for ",
    "providers" to "Names, addresses, and phone numbers of healthcare providers (e.g., doctors, psychiatrists, therapist",
    "medicines" to "List of medicine(s) you take and why you take them, if known. For prescription medicines, include th",
    "tests" to "Names and dates of medical tests you have had or are scheduled to have related to your medical condi",
    "jobs" to "A list of the jobs you had in the 5 years before you became unable to work due to your medical condi",
    "education" to "Information about your highest level of education completed, and when and where you completed it. If",
    "training" to "A list of specialized job, trade, or vocational training and dates completed"
)

private val FIRST_ROW = mapOf(
    "condition" to "List each physical or mental condition (including emotional or learning difficulties) that limits yo",
    "provider" to "Please list healthcare providers (e.g., doctors, psychiatrists, therapists, nurse practitioners, hos",
    "medicine" to "Please list any medicine(s) you take (prescribed and over-the counter) and why you take them (if kn",
    "test" to "Please list any medical tests you had or are going to have in the future. Examples include biopsies,",
    "job" to "List the jobs you had in the 5 years before you became unable to work due to your medical condition("
)

private fun firstOr(first: String, rest: String): (Int) -> String =
    { n -> if (n == 1) first else "$rest $n" }

private fun numbered(name: String): (Int) -> String = { n -> "$name $n" }

private fun phoneCell(value: Any?): String {
    val d = (value?.toString() ?: "").replace(Regex("\\D"), "")
    return if (d.length == 10) "(${d.substring(0, 3)}) ${d.substring(3, 6)}-${d.substring(6)}" else text(value)
}

private fun fieldOf(item: Json.Obj?, id: String): Any? = item?.get(id)?.let { kotlinValue(it) }

/** One column: its label, its PDF field name, and how it reads the item. */
private data class ColumnSpec(
    val label: String,
    val field: (Int) -> String,
    val value: (Json.Obj) -> String
)

private data class TableSpec(
    val loop: String,
    val title: String,
    val itemLabel: String,
    val capacity: Int,
    val columns: List<ColumnSpec>
)

/** The worksheet's five tables. */
private fun tables(payOptions: List<Option>?): List<TableSpec> = listOf(
    TableSpec("conditions", "A. Medical conditions", "condition", 6, listOf(
        ColumnSpec("Condition", firstOr(FIRST_ROW["condition"]!!, "Condition")) { it -> text(fieldOf(it, "name")) }
    )),
    TableSpec("providers", "B. Medical sources", "provider", 5, listOf(
        ColumnSpec("Name of healthcare provider", firstOr(FIRST_ROW["provider"]!!, "Name of Healthcare provider")) { it -> text(fieldOf(it, "name")) },
        ColumnSpec("Address", numbered("Address")) { it -> text(fieldOf(it, "address")) },
        ColumnSpec("Phone number", numbered("Phone number")) { it -> phoneCell(fieldOf(it, "phone")) },
        ColumnSpec("Date first seen or admission date", numbered("Date First Seen by Provider or Admission Date")) { it -> my(fieldOf(it, "first_seen")) },
        ColumnSpec("Date last seen or discharge date", numbered("Date Last Seen by Provider or Discharge Date")) { it -> my(fieldOf(it, "last_seen")) }
    )),
    TableSpec("medications", "C. Medicines", "medicine", 6, listOf(
        ColumnSpec("Name of medicine", firstOr(FIRST_ROW["medicine"]!!, "Name of medicine")) { it -> text(fieldOf(it, "name")) },
        ColumnSpec("Why you take it", numbered("Why you take it")) { it -> text(fieldOf(it, "reason")) },
        ColumnSpec("Prescribed by", numbered("Prescribed by")) { it -> text(fieldOf(it, "prescribed_by")) }
    )),
    TableSpec("tests", "D. Medical tests", "test", 5, listOf(
        ColumnSpec("Name of test", firstOr(FIRST_ROW["test"]!!, "Name of test")) { it -> text(fieldOf(it, "name")) },
        ColumnSpec("Provider who sent you", numbered("Provider who sent you")) { it -> text(fieldOf(it, "ordered_by")) },
        ColumnSpec("Date", numbered("Date")) { it -> mdy(fieldOf(it, "date")) }
    )),
    TableSpec("jobs", "E. Job history", "job", 5, listOf(
        ColumnSpec("Job title", firstOr(FIRST_ROW["job"]!!, "Job title")) { it -> text(fieldOf(it, "job_title")) },
        ColumnSpec("Type of business", numbered("Type of business")) { it -> text(fieldOf(it, "business_type")) },
        ColumnSpec("From (month/year)", numbered("Date worked from month/year")) { it -> my(fieldOf(it, "start")) },
        ColumnSpec("To (month/year)", numbered("Date worked to month/year")) { it -> my(fieldOf(it, "end")) },
        ColumnSpec("Hours per day", numbered("Hours per day")) { it -> text(fieldOf(it, "hours_per_day")) },
        ColumnSpec("Days per week", numbered("Days per week")) { it -> text(fieldOf(it, "days_per_week")) },
        ColumnSpec("Rate of pay", numbered("Rate of pay amount")) { it -> money(fieldOf(it, "pay_amount")) },
        ColumnSpec("Frequency", numbered("Rate of pay frequency")) { it -> choiceLabel(payOptions, fieldOf(it, "pay_frequency")) }
    ))
)

/** Loops the worksheet itself lists; the addendum shows only their overflow. */
private val ON_WORKSHEET = setOf("conditions", "providers", "medications", "tests")

private val answered = { v: Any? -> v != null && v != "" }

private val answeredList = { a: Json.Obj?, id: String -> a?.get(id) is Json.Arr }

private fun checkRules(): List<Pair<String, (Json.Obj?) -> Boolean>> {
    val chk = CHECKLIST
    return listOf(
        chk["identity"]!! to { a -> answered(fieldOf(a, "date_of_birth")) && answered(fieldOf(a, "birth_city")) && answered(fieldOf(a, "ssn")) },
        chk["spouses"]!! to { a -> answeredList(a, "marriages") },
        chk["references"]!! to { a -> answered(fieldOf(a, "ref1_name")) },
        chk["bank"]!! to { a -> answered(fieldOf(a, "routing_number")) && answered(fieldOf(a, "account_number")) },
        chk["workersComp"]!! to { a -> a?.get("wc_receives") is Json.True || a?.get("wc_receives") is Json.False },
        chk["providers"]!! to { a -> items(a, "providers").isNotEmpty() },
        chk["medicines"]!! to { a -> answeredList(a, "medications") },
        chk["tests"]!! to { a -> answeredList(a, "tests") },
        chk["jobs"]!! to { a -> answeredList(a, "jobs") },
        chk["education"]!! to { a -> answered(fieldOf(a, "education_level")) },
        chk["training"]!! to { a -> answeredList(a, "training") }
    )
}

/** Map an answer set onto the Starter Kit. */
fun mapSsaStarterKit(schema: Schema, answers: Json.Obj): Mapping {
    val textFields = LinkedHashMap<String, String>()
    val labels = LinkedHashMap<String, String>()
    val tablesOut = mutableListOf<Json>()

    val payOptions = optionsFromSchema(findQuestion("pay_frequency", schema.sections)?.get("options"))

    for (t in tables(payOptions)) {
        val rows = items(answers, t.loop)
        rows.take(t.capacity).forEachIndexed { i, raw ->
            val item = raw.asObject() ?: Json.Obj()
            for (col in t.columns) {
                val value = col.value(item)
                if (value.isEmpty()) continue
                val name = col.field(i + 1)
                textFields[name] = value
                labels[name] = "${t.title} — row ${i + 1}, ${col.label.lowercase()}"
            }
        }
        // Jobs are listed in full in the addendum (the worksheet has no
        // employer column), so their overflow does not need a table of its own.
        if (rows.size > t.capacity && t.loop != "jobs") {
            tablesOut.add(Json.Obj().also { o ->
                o["title"] = Json.Str("${t.title}, continued")
                o["itemLabel"] = Json.Str(t.itemLabel)
                o["startAt"] = Json.Num((t.capacity + 1).toDouble())
                o["columns"] = Json.Arr(t.columns.mapTo(mutableListOf()) { c ->
                    Json.Obj().also { j -> j["label"] = Json.Str(c.label) }
                })
                o["rows"] = Json.Arr(rows.drop(t.capacity).mapTo(mutableListOf()) { raw ->
                    Json.Arr(t.columns.mapTo(mutableListOf()) { c ->
                        Json.Str(c.value(raw.asObject() ?: Json.Obj()))
                    })
                })
            })
        }
    }

    val checks = checkRules().filter { (_, rule) -> rule(answers) }.map { it.first }

    val sections = buildReport(schema, answers, form = "ssa")
        .map { section ->
            val blocks = section["blocks"]!!.asArray()!!.items.filter { b ->
                val o = b.asObject() ?: Json.Obj()
                !(o["kind"]?.asString() == "table" && ON_WORKSHEET.contains(o["id"]?.asString()))
            }
            Json.Obj().also { o ->
                o["id"] = section["id"] ?: Json.Null
                o["title"] = section["title"] ?: Json.Null
                o["blocks"] = Json.Arr(blocks.toMutableList())
            }
        }
        .filter { section -> section["blocks"]!!.asArray()!!.items.isNotEmpty() }

    return Mapping(
        text = textFields,
        labels = labels,
        checks = checks,
        tables = tablesOut,
        sections = sections
    )
}

/** Filename-safe version of the applicant's name, for export filenames. */
fun slug(s: String?): String =
    (s?.trim() ?: "").replace(Regex("[^a-z0-9]+", RegexOption.IGNORE_CASE), "-")
        .replace(Regex("^-|-$"), "")
