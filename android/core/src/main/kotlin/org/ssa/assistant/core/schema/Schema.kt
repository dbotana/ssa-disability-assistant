package org.ssa.assistant.core.schema

import org.ssa.assistant.core.Option
import org.ssa.assistant.core.Question
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/**
 * The interview schema, loaded from the JS reference's export (tools/schema.json,
 * copied into resources by the :core Gradle build). This is a port of
 * src/schema.js: the schema itself is data, and every helper here — flatten,
 * nodeActive, evalRule — mirrors its JS namesake, because the golden fixtures
 * pin both sides to the same behavior.
 */

data class Schema(
    val schemaVersion: Double,
    val formIds: List<String>,
    val formTitles: Map<String, String>,
    val sections: List<Json.Obj>,
    val ratingOptions: Json.Arr,
    val ratingGroups: Json.Arr,
    val digitTypes: List<String>,
    val sensitiveTypes: List<String>,
    val correct: CorrectTables,
    val labels: Map<String, String>,
    /** Every fixed spoken string, by its name in src/phrases.js. */
    val phrases: Json.Obj,
)

data class CorrectTables(
    val aliases: Map<String, List<String>>,
    val ratingAliases: Map<String, List<String>>,
    val loopWords: Map<String, List<String>>,
    val ordinals: Map<String, Double>,
    val stop: List<String>,
    val maxLoopItems: Int,
)

object SchemaLoader {
    fun load(): Schema = load(loadResource("schema.json"))

    fun load(json: Json): Schema {
        val obj = json.asObject() ?: throw IllegalArgumentException("schema.json is not an object")
        return Schema(
            schemaVersion = obj["schemaVersion"]?.asDouble() ?: 3.0,
            formIds = (obj["formIds"]?.asArray()?.items ?: emptyList()).map { it.asString()!! },
            formTitles = (obj["formTitles"]?.asObject()?.entries ?: emptyMap()).mapValues { it.value.asString()!! },
            sections = (obj["sections"]?.asArray()?.items ?: emptyList()).map { it.asObject()!! },
            ratingOptions = obj["ratingOptions"]?.asArray() ?: Json.Arr(),
            ratingGroups = obj["ratingGroups"]?.asArray() ?: Json.Arr(),
            digitTypes = (obj["digitTypes"]?.asArray()?.items ?: emptyList()).map { it.asString()!! },
            sensitiveTypes = (obj["sensitiveTypes"]?.asArray()?.items ?: emptyList()).map { it.asString()!! },
            correct = CorrectTables(
                aliases = obj["correct"]?.asObject()?.get("aliases")?.asObject()?.entries
                    ?.mapValues { (it.value.asArray()?.items ?: emptyList()).map { v -> v.asString()!! } } ?: emptyMap(),
                ratingAliases = obj["correct"]?.asObject()?.get("ratingAliases")?.asObject()?.entries
                    ?.mapValues { (it.value.asArray()?.items ?: emptyList()).map { v -> v.asString()!! } } ?: emptyMap(),
                loopWords = obj["correct"]?.asObject()?.get("loopWords")?.asObject()?.entries
                    ?.mapValues { (it.value.asArray()?.items ?: emptyList()).map { v -> v.asString()!! } } ?: emptyMap(),
                ordinals = obj["correct"]?.asObject()?.get("ordinals")?.asObject()?.entries
                    ?.mapValues { it.value.asDouble()!! } ?: emptyMap(),
                stop = (obj["correct"]?.asObject()?.get("stop")?.asArray()?.items ?: emptyList()).map { it.asString()!! },
                maxLoopItems = (obj["correct"]?.asObject()?.get("maxLoopItems")?.asDouble() ?: 12.0).toInt()
            ),
            labels = obj["labels"]?.asObject()?.entries?.mapValues { it.value.asString()!! } ?: emptyMap(),
            phrases = obj["phrases"]?.asObject() ?: throw IllegalArgumentException("schema.json has no phrases")
        )
    }
}

fun loadResource(name: String): Json {
    val stream = SchemaLoader::class.java.classLoader.getResourceAsStream(name)
        ?: throw IllegalArgumentException("missing resource: $name")
    return JsonParser.parse(stream.readBytes().toString(Charsets.UTF_8))
}

// -- forms -------------------------------------------------------------------

/** The set of forms this answer set is filling out. */
fun formsOf(answers: Json.Obj?): Set<String> = when ((answers?.get("forms") as? Json.Str)?.value) {
    "ds" -> setOf("ds")
    "both" -> setOf("ssa", "ds")
    else -> setOf("ssa")
}

fun hasForm(answers: Json.Obj?, form: String): Boolean = formsOf(answers).contains(form)

/** Does a `forms` tag (null meaning every form) overlap the chosen forms? */
fun formsMatch(forms: List<String>?, answers: Json.Obj?): Boolean {
    if (forms == null || forms.isEmpty()) return true
    val chosen = formsOf(answers)
    return forms.any { chosen.contains(it) }
}

// -- the rule language ---------------------------------------------------------

/**
 * Port of evalRule() in src/schema.js.
 *
 * Key rules read from exactly one scope: the loop item for a loop field (an
 * item is passed), the answer set otherwise, unless the rule or one enclosing
 * it says `scope: "answers"`. There is no fallback from one to the other.
 */
fun evalRule(rule: Json?, answers: Json.Obj, item: Json.Obj?, scope: String? = null): Boolean {
    if (rule == null || rule === Json.Null) return true
    val obj = rule.asObject() ?: return true
    val sc = obj["scope"]?.asString() ?: scope ?: (if (item != null) "item" else "answers")
    val source = if (sc == "item") (item ?: Json.Obj()) else answers

    fun get(key: String): Json? = source[key]
    fun inner(r: Json): Boolean = evalRule(r, answers, item, sc)

    obj["and"]?.let { return (it.asArray()?.items ?: emptyList()).all { r -> inner(r) } }
    obj["or"]?.let { return (it.asArray()?.items ?: emptyList()).any { r -> inner(r) } }
    obj["not"]?.let { return !inner(it) }
    obj["eq"]?.let { arr ->
        val pair = arr.asArray()!!.items
        return jsEquals(get(pair[0].asString()!!), pair[1])
    }
    obj["ne"]?.let { arr ->
        val pair = arr.asArray()!!.items
        return !jsEquals(get(pair[0].asString()!!), pair[1])
    }
    obj["present"]?.let {
        // JS `v != null && v !== ''`: a stored null — what skip() writes — is
        // not present.
        val v = get(it.asString()!!)
        return v != null && v !== Json.Null && !(v is Json.Str && v.value.isEmpty())
    }
    obj["truthy"]?.let { return jsTruthy(get(it.asString()!!)) }
    obj["notIn"]?.let { arr ->
        val pair = arr.asArray()!!.items
        val v = get(pair[0].asString()!!)
        val values = pair[1].asArray()?.items ?: emptyList()
        return values.none { jsEquals(it, v) }
    }
    obj["form"]?.let { f ->
        return when ((f as? Json.Str)?.value) {
            "ssa" -> hasForm(answers, "ssa")
            "ds" -> hasForm(answers, "ds")
            "dsOnly" -> hasForm(answers, "ds") && !hasForm(answers, "ssa")
            else -> false
        }
    }
    return true   // an unrecognized rule must never strand the interview
}

/**
 * JS === on JSON values. A missing key is `undefined`, which equals nothing —
 * not even null. Numbers compare as IEEE doubles: 0 === -0, NaN !== NaN.
 */
fun jsEquals(a: Json?, b: Json?): Boolean = when {
    a == null || b == null -> false
    a is Json.Num && b is Json.Num -> a.value == b.value
    a is Json.Str && b is Json.Str -> a.value == b.value
    else -> a === b
}

/** JS truthiness on JSON values. */
fun jsTruthy(v: Json?): Boolean = when (v) {
    null, Json.Null, Json.False -> false
    is Json.Str -> v.value.isNotEmpty()
    is Json.Num -> v.value != 0.0
    else -> true
}

// -- schema traversal ------------------------------------------------------------

data class Node(
    val raw: Json.Obj,
    val forms: List<String>?,
    val section: String,
    val sectionTitle: String,
) {
    val id: String? get() = raw["id"]?.asString()
    val type: String? get() = raw["type"]?.asString()
    val askIf: Json? get() = raw["askIf"]
    val prompt: String? get() = raw["prompt"]?.asString()
    val required: Boolean get() = jsTruthy(raw["required"])
    val confirm: Boolean get() = jsTruthy(raw["confirm"])
    val warn: String? get() = raw["warn"]?.asString()
    val hint: String? get() = raw["hint"]?.asString()
    val options: List<Json.Obj>? get() = raw["options"]?.asArray()?.items?.mapNotNull { it.asObject() }
    val allowFuture: Boolean get() = jsTruthy(raw["allowFuture"])
    val entryPrompt: String? get() = raw["entryPrompt"]?.asString()
    val repeatPrompt: String? get() = raw["repeatPrompt"]?.asString()
    val itemLabel: String? get() = raw["itemLabel"]?.asString()
    val entryIsFirstField: Boolean get() = jsTruthy(raw["entryIsFirstField"])
    val fields: List<Json.Obj>? get() = raw["fields"]?.asArray()?.items?.mapNotNull { it.asObject() }
}

fun flatten(sections: List<Json.Obj>): List<Node> {
    val nodes = mutableListOf<Node>()
    for (section in sections) {
        val sectionId = section["id"]?.asString() ?: continue
        val sectionTitle = section["title"]?.asString() ?: ""
        val sectionForms = section["forms"]?.asArray()?.items?.mapNotNull { it.asString() }
        for (q in section["questions"]?.asArray()?.items ?: emptyList()) {
            val qObj = q.asObject() ?: continue
            val forms = qObj["forms"]?.asArray()?.items?.mapNotNull { it.asString() } ?: sectionForms
            nodes.add(Node(qObj, forms, sectionId, sectionTitle))
        }
    }
    return nodes
}

/** Is this top-level node part of the interview for these answers? */
fun nodeActive(node: Node?, answers: Json.Obj?): Boolean {
    if (node == null) return false
    if (!formsMatch(node.forms, answers)) return false
    if (node.askIf == null) return true
    return try {
        evalRule(node.askIf, answers ?: Json.Obj(), null)
    } catch (e: Exception) {
        true
    }
}

/** Does this section belong to one of the chosen forms? */
fun sectionActive(section: Json.Obj, answers: Json.Obj?): Boolean {
    val forms = section["forms"]?.asArray()?.items?.mapNotNull { it.asString() }
    return formsMatch(forms, answers)
}

/**
 * Look up a question node (or a loop field) by id, anywhere in the schema.
 * Like the JS, the result is a copy carrying `section` and `sectionTitle`,
 * and `loopId` for a loop field.
 */
fun findQuestion(id: String, sections: List<Json.Obj>): Json.Obj? {
    fun withPlace(q: Json.Obj, section: Json.Obj, loopId: String?): Json.Obj =
        Json.Obj(LinkedHashMap(q.entries)).also { c ->
            section["id"]?.let { c["section"] = it }
            section["title"]?.let { c["sectionTitle"] = it }
            if (loopId != null) c["loopId"] = Json.Str(loopId)
        }
    for (section in sections) {
        for (q in section["questions"]?.asArray()?.items ?: emptyList()) {
            val qObj = q.asObject() ?: continue
            if (qObj["id"]?.asString() == id) return withPlace(qObj, section, null)
            if (qObj["type"]?.asString() == "loop") {
                for (f in qObj["fields"]?.asArray()?.items ?: emptyList()) {
                    val fObj = f.asObject() ?: continue
                    if (fObj["id"]?.asString() == id) return withPlace(fObj, section, qObj["id"]?.asString())
                }
            }
        }
    }
    return null
}

/**
 * A schema question (or loop field) as a [Question]: the fields buildCurrent()
 * copies, with `section`/`sectionTitle`/`loopId` taken from the object when it
 * carries them (as [findQuestion]'s result does).
 */
fun questionFromSchema(f: Json.Obj): Question = Question(
    id = f["id"]?.asString() ?: "",
    prompt = f["prompt"]?.asString() ?: "",
    type = f["type"]?.asString() ?: "text",
    required = jsTruthy(f["required"]),
    confirm = jsTruthy(f["confirm"]),
    warn = f["warn"]?.asString(),
    hint = f["hint"]?.asString(),
    options = optionsFromSchema(f["options"]),
    allowFuture = jsTruthy(f["allowFuture"]),
    per = f["per"]?.asString(),
    kind = f["kind"]?.asString(),
    section = f["section"]?.asString(),
    sectionTitle = f["sectionTitle"]?.asString(),
    loopId = f["loopId"]?.asString(),
)

/** A choice question's option list, or null when it has none. */
fun optionsFromSchema(options: Json?): List<Option>? = options?.asArray()?.items?.mapNotNull { o ->
    val oo = o.asObject() ?: return@mapNotNull null
    Option(
        value = oo["value"]?.asString() ?: "",
        label = oo["label"]?.asString() ?: "",
        letter = oo["letter"]?.asString(),
        aliases = oo["aliases"]?.asArray()?.items?.mapNotNull { it.asString() } ?: emptyList(),
        impliedBy = oo["impliedBy"]?.asArray()?.items?.mapNotNull { it.asString() }
    )
}
