package org.ssa.assistant.core.parse

import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsEscape
import org.ssa.assistant.core.js.jsLower
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.Node
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.flatten
import org.ssa.assistant.core.schema.nodeActive

/**
 * Port of src/correct.js: spoken field names -> question targets, for the
 * review-and-correct pass. Deterministic on purpose — a correction is the one
 * place a wrong guess would overwrite an answer silently.
 *
 * A target is: { id, loopId?, loopIndex?, label, prompt, type, options,
 *                itemLabel?, itemNumber?, section, sectionTitle, value }
 */


data class Target(
    val id: String,
    val type: String,
    val options: List<org.ssa.assistant.core.Option>?,
    val prompt: String,
    val label: String,
    val section: String,
    val sectionTitle: String,
    val loopId: String? = null,
    val loopIndex: Int? = null,
    val itemLabel: String? = null,
    val itemNumber: Int? = null,
    val value: Any? = null,
)

class Correct(private val schema: Schema) {

    private val nodes: List<Node> = flatten(schema.sections)
    private val loopNodes: Map<String, Node> = nodes.filter { it.type == "loop" }.associateBy { it.id ?: "" }

    private val aliases: Map<String, List<String>> = schema.correct.aliases + schema.correct.ratingAliases
    private val loopWords: Map<String, List<String>> = schema.correct.loopWords
    private val ordinals: Map<String, Int> = schema.correct.ordinals.mapValues { it.value.toInt() }
    private val stop: Set<String> = schema.correct.stop.toSet()

    private val LEAD_INS = listOf(
        js("^(i want to |i need to |can you |could you |please )", true),
        js("^(change|correct|fix|update|edit|redo|re-?do|amend)\\s+", true),
        js("^(my|the|our)\\s+", true),
        js("^(answer|response|entry|field)\\s+(for|to|about)\\s+", true),
        js("\\s+(is wrong|was wrong|is incorrect|needs? fixing|needs? to change)$", true),
        js("^(go to|jump to|take me to)\\s+", true)
    )

    private fun normalizeText(s: String?): String = jsTrim(jsLower(s ?: "")
        .replace(js("[\u2019']"), "'")
        .replace(js("[^a-z0-9'\\s]"), " ")
        .replace(js("\\s+"), " "))

    /** Strip lead-in verbs so "change my phone number" matches "phone number". */
    fun stripLeadIn(phrase: String?): String {
        var out = jsTrim(phrase ?: "")
        var changed = true
        var guard = 0
        while (changed && guard++ < 10) {
            changed = false
            for (re in LEAD_INS) {
                val next = out.replaceFirst(re, "")
                if (next != out) { out = jsTrim(next); changed = true }
            }
        }
        return out
    }

    /** Printable label for a question id: the summary's LABELS table first. */
    private fun shortLabel(prompt: String?, id: String?): String {
        val label = if (id != null) schema.labels[id] else null
        if (label != null) return label
        val s = (prompt ?: "")
            .replaceFirst(js("^(What is|What was|What|Who|Where|When|Which|Do you have|Do you|Did you|Have you|Are you|Is this|Can you give me|Can you provide)\\s+", true), "")
            .replaceFirst(js("\\?.*$"), "")
            .replaceFirst(js("^the\\s+", true), "")
            .replaceFirst(js("^your\\s+", true), "")
            .replaceFirst(js("\\s+You can say.*$", true), "")
        // .replace(/^(.)/, c => c.toUpperCase()): JS `.` is not a line terminator.
        val first = js("^(.)").find(s)
        return jsTrim(if (first == null) s else s.replaceRange(first.range, first.value.uppercase()))
    }

    private fun toOptions(list: List<Json.Obj>?): List<org.ssa.assistant.core.Option>? =
        list?.map { o ->
            org.ssa.assistant.core.Option(
                value = o["value"]?.asString() ?: "",
                label = o["label"]?.asString() ?: "",
                letter = o["letter"]?.asString(),
                aliases = o["aliases"]?.asArray()?.items?.mapNotNull { it.asString() } ?: emptyList(),
                impliedBy = o["impliedBy"]?.asArray()?.items?.mapNotNull { it.asString() }
            )
        }

    /** Every correctable target in the schema, in interview order. */
    fun buildTargets(answers: Json.Obj): List<Target> {
        val targets = mutableListOf<Target>()
        for (node in nodes) {
            if (!nodeActive(node, answers)) continue
            if (node.type == "loop") {
                val items = answers[node.id] as? Json.Arr ?: Json.Arr()
                items.items.forEachIndexed { index, raw ->
                    val item = raw as? Json.Obj ?: Json.Obj()
                    for (f in node.fields ?: emptyList()) {
                        val fid = f["id"]?.asString() ?: continue
                        targets.add(Target(
                            id = fid,
                            loopId = node.id,
                            loopIndex = index,
                            itemLabel = node.itemLabel,
                            itemNumber = index + 1,
                            type = f["type"]?.asString() ?: "text",
                            options = toOptions(f["options"]?.asArray()?.items?.mapNotNull { it.asObject() }),
                            prompt = f["prompt"]?.asString() ?: "",
                            label = shortLabel(f["prompt"]?.asString(), fid),
                            section = node.section,
                            sectionTitle = node.sectionTitle,
                            value = item[fid]?.let { jsonValue(it) }
                        ))
                    }
                }
                continue
            }
            val id = node.id ?: continue
            targets.add(Target(
                id = id,
                type = node.type ?: "text",
                options = toOptions(node.raw["options"]?.asArray()?.items?.mapNotNull { it.asObject() }),
                prompt = node.prompt ?: "",
                label = shortLabel(node.prompt, id),
                section = node.section,
                sectionTitle = node.sectionTitle,
                value = answers[id]?.let { jsonValue(it) }
            ))
        }
        return targets
    }

    private fun jsonValue(j: Json): Any? = when (j) {
        is Json.Str -> j.value
        is Json.Num -> j.value
        Json.True -> true
        Json.False -> false
        else -> null
    }

    fun describeTarget(t: Target): String =
        if (t.loopId == null) t.label else "${t.label} for ${t.itemLabel} ${t.itemNumber}"

    /** Score how well a phrase names one target. Higher is better; 0 is no match. */
    private fun scoreTarget(phrase: String, target: Target): Int {
        val names = (listOf(target.label) + (aliases[target.id] ?: emptyList()) + listOf(target.prompt))
            .map { normalizeText(it) }
            .filter { it.isNotEmpty() }

        var best = 0
        for (name in names) {
            if (name.isEmpty()) continue
            val words = name.split(" ").size
            best = when {
                phrase == name -> Math.max(best, 1000 + words * 10)
                words > 1 && phrase.contains(name) -> Math.max(best, 500 + words * 10)
                words > 1 && name.contains(phrase) && phrase.split(" ").size > 1 ->
                    Math.max(best, 300 + phrase.split(" ").size * 10)
                words == 1 && js("\\b${jsEscape(name)}\\b").test(phrase) -> Math.max(best, 200)
                else -> best
            }
        }

        if (best == 0) {
            val overlap = contentWords(phrase).filter { w ->
                normalizeText(target.label).contains(w) || normalizeText(target.prompt).contains(w)
            }
            if (overlap.isNotEmpty()) best = 50 + overlap.size * 10
        }
        return best
    }

    private fun contentWords(phrase: String): List<String> =
        normalizeText(phrase).split(" ").filter { w -> w.isNotEmpty() && !stop.contains(w) && w.length > 2 }

    /** Which loop group, if any, the phrase names. Returns a String? or List<String>. */
    private fun loopHintFor(phrase: String, answers: Json.Obj, all: Boolean = false): Any? {
        var hit: String? = null
        var hitLen = 0
        val ties = LinkedHashMap<String, Int>()
        for ((loopId, words) in loopWords) {
            val node = loopNodes[loopId] ?: continue
            if (!nodeActive(node, answers)) continue
            for (w in words) {
                val n = normalizeText(w)
                if (!js("\\b${jsEscape(n)}\\b").test(phrase)) continue
                if (n.length > (ties[loopId] ?: 0)) ties[loopId] = n.length
                if (n.length > hitLen) {
                    hit = loopId
                    hitLen = n.length
                }
            }
        }
        if (all) return ties.filter { it.value == hitLen }.keys.toList()
        return hit ?: return null
    }

    private val ORDINAL_FALSE_FRIENDS = listOf(
        js("\\bfirst\\s+name\\b"), js("\\blast\\s+name\\b"),
        js("\\bfirst\\s+seen\\b"), js("\\blast\\s+seen\\b"),
        js("\\bfirst\\s+visit\\b"), js("\\blast\\s+visit\\b"),
        js("\\bfirst\\s+reference\\b"), js("\\bsecond\\s+reference\\b"),
        js("\\bfirst\\s+person\\b"), js("\\bsecond\\s+person\\b")
    )

    /** Which item number, if any, the phrase names ("the second provider"). */
    private fun itemNumberFor(phrase: String, bare: Boolean = false): Int? {
        if (ORDINAL_FALSE_FRIENDS.any { it.test(phrase) }) return null

        for ((word, n) in ordinals) {
            val ordinalOnly = js("^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d+(?:st|nd|rd|th))$").test(word)
            if (!bare && !ordinalOnly) continue
            if (js("\\b${jsEscape(word)}\\b").test(phrase)) return n
        }
        val m = js("\\b(?:number|item)\\s+(\\d{1,2})\\b").find(phrase)
        if (m != null) return m.groupValues[1].toInt()
        if (bare) {
            val only = js("^(\\d{1,2})$").find(jsTrim(phrase))
            if (only != null) return only.groupValues[1].toInt()
        }
        if (js("\\blast\\b").test(phrase)) return -1
        return null
    }

    sealed class Resolution {
        data class Ok(val target: Target) : Resolution()
        data class None(val reason: String = "none") : Resolution()
        data class Ambiguous(val candidates: List<Target>) : Resolution()
    }

    /** Resolve a spoken phrase to a correction target. */
    fun resolveTarget(phrase: String?, answers: Json.Obj): Resolution {
        val cleaned = normalizeText(stripLeadIn(phrase))
        if (cleaned.isEmpty()) return Resolution.None()

        val targets = buildTargets(answers)
        if (targets.isEmpty()) return Resolution.None()

        val loopHintAny = loopHintFor(cleaned, answers)
        val loopHint = if (loopHintAny == null) null else loopHintAny as String
        val wanted = itemNumberFor(cleaned)

        data class Scored(val t: Target, val score: Int)

        var scored = targets.map { t ->
            var score = scoreTarget(cleaned, t)
            if (score > 0) {
                if (loopHint != null) {
                    score += when {
                        t.loopId == loopHint -> 400
                        t.loopId != null -> -200
                        else -> -150
                    }
                } else if (t.loopId != null && wanted == null) {
                    score -= 150
                }
            }
            Scored(t, score)
        }.filter { it.score > 0 }.toMutableList()

        if (scored.isEmpty()) return Resolution.None()

        if (wanted != null && scored.any { it.t.loopId != null }) {
            val byNumber = scored.filter { s ->
                if (s.t.loopId == null) false
                else {
                    val count = (answers[s.t.loopId] as? Json.Arr)?.items?.size ?: 0
                    val targetN = if (wanted == -1) count else wanted
                    s.t.itemNumber == targetN
                }
            }
            if (byNumber.isEmpty()) return Resolution.None()
            scored = byNumber.toMutableList()
        }

        scored.sortByDescending { it.score }
        val top = scored[0]

        val window = if (loopHint != null || wanted != null) 1 else 120
        val near = scored.filter { it.score >= top.score - window }

        val sameField = near.all { it.t.id == top.t.id && it.t.loopId == top.t.loopId }
        if (sameField) {
            val firstItem = near.reduce { a, b -> if ((a.t.loopIndex ?: 0) <= (b.t.loopIndex ?: 0)) a else b }
            return Resolution.Ok(firstItem.t)
        }

        if (near.size > 1) {
            val offered = scored.filter { it.score >= top.score - (window + 150) }
            val candidates = mutableListOf<Target>()
            for (s in offered) {
                if (candidates.any { c -> c.id == s.t.id && c.loopId == s.t.loopId }) continue
                candidates.add(s.t)
                if (candidates.size == 5) break
            }
            return Resolution.Ambiguous(candidates)
        }

        return Resolution.Ok(top.t)
    }

    /** Pick a target from a spoken reply to a disambiguation question. */
    fun resolveChoice(phrase: String?, candidates: List<Target>?): Target? {
        val cleaned = normalizeText(stripLeadIn(phrase))
        if (cleaned.isEmpty() || candidates.isNullOrEmpty()) return null

        val n = itemNumberFor(cleaned, bare = true)
        if (n == -1) return candidates[candidates.size - 1]
        if (n != null && n in 1..candidates.size) return candidates[n - 1]

        var best: Target? = null
        var bestScore = 0
        for (c in candidates) {
            val score = scoreTarget(cleaned, c)
            if (score > bestScore) { bestScore = score; best = c }
        }
        return if (bestScore > 0) best else null
    }

    // -- addition ------------------------------------------------------------------

    private val ADD_VERBS = js("\\b(add|another|one more|also have|include|append|new)\\b", true)

    fun isAdditionPhrase(phrase: String?): Boolean = ADD_VERBS.test(phrase ?: "")

    sealed class AdditionResult {
        data class Ok(val loopId: String, val itemLabel: String, val nextNumber: Int) : AdditionResult()
        data class Full(val loopId: String, val itemLabel: String) : AdditionResult()
        data class Ambiguous(val candidates: List<Pair<String, String>>) : AdditionResult()
        data class None(val reason: String = "none") : AdditionResult()
    }

    fun resolveAddition(phrase: String?, answers: Json.Obj): AdditionResult {
        // JS's ADD_VERBS has no g flag: only the first verb is removed.
        val cleaned = normalizeText(stripLeadIn((phrase ?: "").replaceFirst(ADD_VERBS, " ")))
        val hitsAny = loopHintFor(cleaned, answers, all = true)
        val hits = hitsAny as List<String>
        if (hits.isEmpty()) return AdditionResult.None()

        if (hits.size > 1) {
            return AdditionResult.Ambiguous(hits.map { loopId ->
                loopId to (loopNodes[loopId]?.itemLabel ?: "item")
            })
        }

        val loopId = hits[0]
        val itemLabel = loopNodes[loopId]?.itemLabel ?: "item"
        val count = (answers[loopId] as? Json.Arr)?.items?.size ?: 0
        if (count >= schema.correct.maxLoopItems) return AdditionResult.Full(loopId, itemLabel)
        return AdditionResult.Ok(loopId, itemLabel, count + 1)
    }

    // -- deletion -------------------------------------------------------------------

    private val DELETE_VERBS = js("\\b(delete|remove|drop|erase|get rid of|take (?:it |that )?off|scratch)\\b", true)

    fun isDeletionPhrase(phrase: String?): Boolean = DELETE_VERBS.test(phrase ?: "")

    data class ItemDescription(
        val index: Int,
        val number: Int,
        val itemLabel: String,
        val title: String?,
    )

    sealed class DeletionResult {
        data class Ok(val loopId: String, val loopIndex: Int, val number: Int, val itemLabel: String, val title: String?) : DeletionResult()
        data class Empty(val loopId: String, val itemLabel: String) : DeletionResult()
        data class Ambiguous(val loopId: String, val itemLabel: String, val candidates: List<ItemDescription>) : DeletionResult()
        data class None(val reason: String = "none") : DeletionResult()
    }

    fun resolveDeletion(phrase: String?, answers: Json.Obj): DeletionResult {
        // JS's DELETE_VERBS has no g flag: only the first verb is removed.
        val cleaned = normalizeText(stripLeadIn((phrase ?: "").replaceFirst(DELETE_VERBS, " ")))

        val hintAny = loopHintFor(cleaned, answers)
        val loopId = hintAny as? String ?: return DeletionResult.None()

        val node = loopNodes[loopId]
        val itemLabel = node?.itemLabel ?: "item"
        val items = answers[loopId] as? Json.Arr ?: Json.Arr()
        val describe = { raw: Json, index: Int ->
            val item = raw as? Json.Obj ?: Json.Obj()
            ItemDescription(
                index = index,
                number = index + 1,
                itemLabel = itemLabel,
                title = (item[node?.fields?.getOrNull(0)?.get("id")?.asString()] as? Json.Str)?.value
            )
        }

        if (items.items.isEmpty()) return DeletionResult.Empty(loopId, itemLabel)

        val wanted = itemNumberFor(cleaned)
        if (wanted != null) {
            val index = if (wanted == -1) items.items.size - 1 else wanted - 1
            if (index < 0 || index >= items.items.size) {
                return DeletionResult.Ambiguous(loopId, itemLabel, items.items.mapIndexed { i, raw -> describe(raw, i) })
            }
            val d = describe(items.items[index], index)
            return DeletionResult.Ok(loopId, index, d.number, itemLabel, d.title)
        }

        if (items.items.size == 1) {
            val d = describe(items.items[0], 0)
            return DeletionResult.Ok(loopId, 0, d.number, itemLabel, d.title)
        }

        val byTitle = items.items.mapIndexed { i, raw -> describe(raw, i) }
            .filter { c -> c.title != null && cleaned.contains(normalizeText(c.title)) }
        if (byTitle.size == 1) {
            return DeletionResult.Ok(loopId, byTitle[0].index, byTitle[0].number, itemLabel, byTitle[0].title)
        }

        return DeletionResult.Ambiguous(loopId, itemLabel, items.items.mapIndexed { i, raw -> describe(raw, i) })
    }

    /** Spoken description of a loop item: "provider 2, City Clinic". */
    fun describeItem(item: ItemDescription): String {
        val base = "${item.itemLabel} ${item.number}"
        return if (item.title != null) "$base, ${item.title}" else base
    }
}
