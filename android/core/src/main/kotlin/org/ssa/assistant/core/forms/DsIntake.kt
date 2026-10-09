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
import org.ssa.assistant.core.schema.hasForm
import org.ssa.assistant.core.schema.optionsFromSchema
import java.time.LocalDate

/**
 * Port of src/forms/ds-intake.js: answers -> fields of Maine DHHS's
 * Developmental Services Intake Application (revised 06/18/2025).
 *
 * Two traps in the PDF itself, both handled in RATING_FIELDS below:
 *   - Section 10 (Community Access) is wired to fields named after section
 *     11's rows — LetterFamily, LetterFriends, LetterCoworkers,
 *     LetterSupport Staff.
 *   - Section 11 (Maintain Relationships) therefore uses the `_2` names.
 * "ME" is printed as the state in sections 2-4, which have no State field.
 */

/** Activity key (see RATING_GROUPS in schema.js) -> the PDF's row suffix. */
private val RATING_FIELDS: List<Pair<String, String>> = listOf(
    "eating" to "Eating",
    "dressing" to "Dressing",
    "toileting" to "Toileting",
    "bathing" to "Bathing",
    "grooming" to "Grooming",
    "mobility" to "Mobility",
    "physical_danger" to "Avoidance of physical danger",
    "emotional_jeopardy" to "Avoidance of emotional jeopardy",
    "healthy_relationships" to "Engagement in healthy relationships",
    "judgment" to "Judgment regarding personal conduct",
    "cooking" to "Cooking",
    "laundry" to "Laundry",
    // Section 10, on fields named after section 11's rows. Not a typo here.
    "shopping" to "Family",
    "transportation" to "Friends",
    "banking" to "Coworkers",
    "recreation" to "Support Staff",
    // Section 11.
    "rel_family" to "Family_2",
    "rel_friends" to "Friends_2",
    "rel_coworkers" to "Coworkers_2",
    "rel_support_staff" to "Support Staff_2",
    "expressive" to "Expressive Communication",
    "receptive" to "Receptive Communication",
    "sign_language" to "Sign Language",
    "visual_gestural" to "VisualGestural"
)

private const val CONFIRMED_DX_ROWS = 3
private fun confirmedDx(n: Int): String =
    "Current Diagnoses Confirmed by Psychological evaluation with IQ and Adaptive Scores $n"

/** "Keeping up relationships: Family", for addendum labels. */
private fun activityLabels(schema: Schema): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (group in schema.ratingGroups.items) {
        val g = group.asObject() ?: continue
        for (act in g["activities"]?.asArray()?.items ?: emptyList()) {
            val a = act.asObject() ?: continue
            out[a["key"]?.asString() ?: ""] = "${g["title"]?.asString()}: ${a["label"]?.asString()}"
        }
    }
    return out
}

/**
 * Marital status, as the DS form wants it.
 *
 * Asked directly when the Starter Kit is not being filled out. With the Kit,
 * the marriage history already says it: an active marriage is "Married", a
 * last marriage that ended in the spouse's death is "Widowed", one that ended
 * otherwise is "Divorced", and no marriages at all is "Never married".
 */
private fun maritalStatus(schema: Schema, a: Json.Obj): String {
    val maritalOptions = optionsFromSchema(findQuestion("marital_status", schema.sections)?.get("options"))
    if (!hasForm(a, "ssa")) return choiceLabel(maritalOptions, kotlinValue(a.get("marital_status")))
    val list = a.get("marriages") as? Json.Arr ?: return ""
    if (list.items.isEmpty()) return "Never married"
    if (list.items.any { m -> (m.asObject()?.get("still_active")) === Json.True }) return "Married"
    val last = list.items.last().asObject() ?: return ""
    if (last.get("spouse_died") === Json.True) return "Widowed"
    if (last.get("still_active") === Json.False) return "Divorced"
    return ""
}

/** Every current diagnosis, once each, ignoring case. */
private fun diagnoses(a: Json.Obj): String {
    val listed = mutableListOf<String>()
    for (raw in items(a, "conditions") + items(a, "diagnoses") + items(a, "idd_diagnoses")) {
        val name = text((raw.asObject()?.get("name"))?.let { kotlinValue(it) })
        if (name.isNotEmpty() && listed.none { it.lowercase() == name.lowercase() }) listed.add(name)
    }
    return listed.joinToString("; ")
}

private fun medications(a: Json.Obj): String =
    items(a, "medications")
        .map { raw ->
            val it = raw.asObject() ?: Json.Obj()
            val name = text(it.get("name")?.let { v -> kotlinValue(v) })
            val reason = text(it.get("reason")?.let { v -> kotlinValue(v) })
            if (name.isNotEmpty() && reason.isNotEmpty()) "$name ($reason)" else name
        }
        .filter { it.isNotEmpty() }
        .joinToString("; ")

private fun employmentHistory(a: Json.Obj): String {
    val list = if (hasForm(a, "ssa")) items(a, "jobs") else items(a, "ds_jobs")
    return list
        .map { raw ->
            val it = raw.asObject() ?: Json.Obj()
            val where = join(listOf(it.get("job_title")?.let { v -> kotlinValue(v) }, it.get("employer")?.let { v -> kotlinValue(v) }), ", ")
            val from = my(it.get("start")?.let { v -> kotlinValue(v) })
            val to = my(it.get("end")?.let { v -> kotlinValue(v) })
            val whenPart = if (from.isNotEmpty() || to.isNotEmpty()) " (${from.ifEmpty { "?" }} to ${to.ifEmpty { "?" }})" else ""
            if (where.isNotEmpty()) "$where$whenPart" else ""
        }
        .filter { it.isNotEmpty() }
        .joinToString("; ")
}

private fun specialEducation(a: Json.Obj): String {
    val parts = mutableListOf<String>()
    val specialEd = kotlinValue(a.get("special_ed"))
    val plan504 = kotlinValue(a.get("has_504_plan"))
    if (specialEd is Boolean) parts.add("Special education: ${yesNo(specialEd)}")
    if (plan504 is Boolean) parts.add("504 plan: ${yesNo(plan504)}")
    return parts.joinToString("; ")
}

/** Map an answer set onto the DS Intake Application. */
fun mapDsIntake(schema: Schema, answers: Json.Obj, today: LocalDate): Mapping {
    val out = LinkedHashMap<String, String>()
    val labels = LinkedHashMap<String, String>()
    fun put(field: String, value: Any?, label: String) {
        val v = text(value)
        if (v.isEmpty()) return
        out[field] = v
        labels[field] = label
    }

    val name = join(listOf(kotlinValue(answers.get("first_name")), kotlinValue(answers.get("last_name"))), " ")
    // Local date, not toISOString(): in a US evening the UTC date is tomorrow.
    // Built by hand, not by String.format: its digits follow the device locale.
    val iso = "${today.year}-${today.monthValue.toString().padStart(2, '0')}-${today.dayOfMonth.toString().padStart(2, '0')}"

    // Page 1: applicant.
    put("Date", mdy(iso), "Date")
    put("Applicant Name", name, "Applicant name")
    put("DOB", mdy(kotlinValue(answers.get("date_of_birth"))), "Date of birth")
    put("MaineCare", kotlinValue(answers.get("mainecare_number")), "MaineCare number")
    put("SSN", ssn(kotlinValue(answers.get("ssn"))), "Social Security number")
    put("Street Address", kotlinValue(answers.get("home_street")), "Street address")
    if (kotlinValue(answers.get("mailing_different")) == true) {
        put("Mailing Address if different", kotlinValue(answers.get("mailing_address")), "Mailing address")
    }
    put("Town 1", kotlinValue(answers.get("home_town")), "Town")
    put("State 1", kotlinValue(answers.get("home_state")), "State")
    put("Zip 1", zip(kotlinValue(answers.get("home_zip"))), "Zip")
    put("Phone 1", phone(kotlinValue(answers.get("applicant_phone"))), "Phone number")
    put("Marital Status", maritalStatus(schema, answers), "Marital status")
    put("Email 1", kotlinValue(answers.get("applicant_email")), "Email")
    put("Place of Birth", join(listOf(kotlinValue(answers.get("birth_city")), kotlinValue(answers.get("birth_state")), kotlinValue(answers.get("birth_country")))), "Place of birth")
    put("Primary Language 1", kotlinValue(answers.get("primary_language")), "Primary language")
    put("Deaf or hard of hearing 1", yesNo(kotlinValue(answers.get("deaf_hoh"))), "Deaf or hard of hearing")

    // Section 2: someone completing it for the applicant.
    if (kotlinValue(answers.get("for_self")) == false) {
        put("Name of PersonAgency 2", kotlinValue(answers.get("helper_name")), "Person or agency completing the application")
        put("Mailing Address 2", kotlinValue(answers.get("helper_address")), "Their mailing address")
        put("City 2", kotlinValue(answers.get("helper_city")), "Their city")
        put("County 2", kotlinValue(answers.get("helper_county")), "Their county")
        put("Zip 2", zip(kotlinValue(answers.get("helper_zip"))), "Their zip")
        put("Phone 2", phone(kotlinValue(answers.get("helper_phone"))), "Their phone")
        put("Fax 2", phone(kotlinValue(answers.get("helper_fax"))), "Their fax")
        put("Email 2", kotlinValue(answers.get("helper_email")), "Their email")
    }

    // Section 3: guardian or power of attorney.
    if (kotlinValue(answers.get("has_guardian")) == true) {
        put("Name 3", kotlinValue(answers.get("guardian_name")), "Guardian's name")
        put("Mailing Address 3", kotlinValue(answers.get("guardian_address")), "Guardian's mailing address")
        put("City 3", kotlinValue(answers.get("guardian_city")), "Guardian's city")
        put("County 3", kotlinValue(answers.get("guardian_county")), "Guardian's county")
        put("Zip 3", zip(kotlinValue(answers.get("guardian_zip"))), "Guardian's zip")
        put("Phone 3", phone(kotlinValue(answers.get("guardian_phone"))), "Guardian's phone")
        put("Email 3", kotlinValue(answers.get("guardian_email")), "Guardian's email")
        put("Relationship 3", kotlinValue(answers.get("guardian_relationship")), "Guardian's relationship")
    }

    // Section 4: emergency contact — the guardian's details if they said so.
    val ec = if (kotlinValue(answers.get("has_guardian")) == true && kotlinValue(answers.get("ec_same_as_guardian")) == true)
        listOf("guardian_name", "guardian_address", "guardian_city", "guardian_county", "guardian_zip", "guardian_phone", "guardian_email", "guardian_relationship")
            .map { kotlinValue(answers.get(it)) }
    else listOf("ec_name", "ec_address", "ec_city", "ec_county", "ec_zip", "ec_phone", "ec_email", "ec_relationship")
        .map { kotlinValue(answers.get(it)) }
    put("Name 4", ec[0], "Emergency contact name")
    put("Street Address 4", ec[1], "Emergency contact address")
    put("City 4", ec[2], "Emergency contact city")
    put("County 4", ec[3], "Emergency contact county")
    put("Zip 4", zip(ec[4]), "Emergency contact zip")
    put("Phone 4", phone(ec[5]), "Emergency contact phone")
    put("Email 4", ec[6], "Emergency contact email")
    put("Relationship 4", ec[7], "Emergency contact relationship")

    // 5a: health.
    put("Current Diagnoses", diagnoses(answers), "Current diagnoses")
    put("Current Medications", medications(answers), "Current medications")
    put("Medication Allergies", kotlinValue(answers.get("medication_allergies")), "Medication allergies")
    put("Food Allergies", kotlinValue(answers.get("food_allergies")), "Food allergies")
    put("Environmental Allergies", kotlinValue(answers.get("environmental_allergies")), "Environmental allergies")
    put("Dietary Restrictions", kotlinValue(answers.get("dietary_restrictions")), "Dietary restrictions")

    // 5b: intellectual or developmental disability, or autism.
    val tables = mutableListOf<Json>()
    if (kotlinValue(answers.get("has_idd_dx")) == true) {
        put("Date of Diagnosis", my(kotlinValue(answers.get("idd_dx_date"))), "Date of diagnosis")
        put("Age at Diagnosis", kotlinValue(answers.get("idd_age_at_dx")), "Age at diagnosis")
        val confirmed = items(answers, "idd_diagnoses").map { text(it.asObject()?.get("name")?.let { v -> kotlinValue(v) }) }.filter { it.isNotEmpty() }
        confirmed.take(CONFIRMED_DX_ROWS).forEachIndexed { i, dx ->
            put(confirmedDx(i + 1), dx, "Confirmed diagnosis ${i + 1}")
        }
        if (confirmed.size > CONFIRMED_DX_ROWS) {
            tables.add(Json.Obj().also { o ->
                o["title"] = Json.Str("5b. Diagnoses confirmed by psychological evaluation, continued")
                o["itemLabel"] = Json.Str("diagnosis")
                o["startAt"] = Json.Num((CONFIRMED_DX_ROWS + 1).toDouble())
                o["columns"] = Json.Arr(mutableListOf(Json.Obj().also { c -> c["label"] = Json.Str("Confirmed diagnosis") }))
                o["rows"] = Json.Arr(confirmed.drop(CONFIRMED_DX_ROWS).mapTo(mutableListOf()) { dx ->
                    Json.Arr(mutableListOf(Json.Str(dx)))
                })
            })
        }
    }

    // 6: home.
    put("What is your current living arrangement", kotlinValue(answers.get("living_arrangement")), "Current living arrangement")
    put("Who is in the household",
        items(answers, "household").map { text(it.asObject()?.get("name")?.let { v -> kotlinValue(v) }) }.filter { it.isNotEmpty() }.joinToString(", "),
        "Who is in the household")

    // 7-12: rated activities.
    val labelsFor = activityLabels(schema)
    for ((key, suffix) in RATING_FIELDS) {
        val level = kotlinValue(answers.get("${key}_level")) ?: continue
        val label = labelsFor[key] ?: key
        put("Letter$suffix", level, "$label — rating")
        if (level != "A") put("Explanation$suffix", kotlinValue(answers.get("${key}_explain")), "$label — explanation")
    }

    // 13: education.
    put("Are you currently attending school", yesNo(kotlinValue(answers.get("in_school"))), "Currently attending school")
    if (kotlinValue(answers.get("in_school")) == true) {
        put("Anticipated graduation date", my(kotlinValue(answers.get("graduation_date"))), "Anticipated graduation date")
    }
    put("Highest grade completed", kotlinValue(answers.get("education_level")), "Highest grade completed")
    put("Name of school", kotlinValue(answers.get("education_school")), "Name of school")
    put("Have you ever received Special Education andor 504 Plan", specialEducation(answers), "Special education or 504 plan")
    put("Have you had a Psychoeducational Evaluation", yesNo(kotlinValue(answers.get("psychoed_eval"))), "Psychoeducational evaluation")

    // 14: employment.
    put("Are you currently employed", yesNo(kotlinValue(answers.get("currently_employed"))), "Currently employed")
    put("Employment History", employmentHistory(answers), "Employment history")
    put("Involvement with VR", kotlinValue(answers.get("vr_involvement")), "Involvement with Vocational Rehabilitation")
    put("Volunteer experiences", kotlinValue(answers.get("volunteer_experience")), "Volunteer experiences")

    // Page 4: printed names. Signatures and signature dates stay blank for ink.
    put("Applicant Name print", name, "Applicant name")
    if (kotlinValue(answers.get("has_guardian")) == true) put("Guardian Name print", kotlinValue(answers.get("guardian_name")), "Guardian name")
    if (kotlinValue(answers.get("for_self")) == false) put("Other Name print", kotlinValue(answers.get("helper_name")), "Other name")

    // Required documents. The application itself is always enclosed.
    val checks = mutableListOf("Check Box26")
    if (kotlinValue(answers.get("has_comprehensive_eval")) == true) checks.add("Check Box27")
    if (kotlinValue(answers.get("has_adaptive_test")) == true) checks.add("Check Box28")
    if (kotlinValue(answers.get("has_iq_test")) == true) checks.add("Check Box29")
    if (kotlinValue(answers.get("has_other_assessments")) == true) checks.add("Check Box30")

    val radios = LinkedHashMap<String, String>()
    val gender = kotlinValue(answers.get("gender")) as? String
    if (gender == "M" || gender == "F") radios["Gender"] = gender

    return Mapping(text = out, labels = labels, radios = radios, checks = checks, tables = tables)
}
