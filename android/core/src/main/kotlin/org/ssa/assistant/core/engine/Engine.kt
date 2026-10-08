package org.ssa.assistant.core.engine

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.deepCopy
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.schema.Node
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.evalRule
import org.ssa.assistant.core.schema.flatten
import org.ssa.assistant.core.schema.jsTruthy
import org.ssa.assistant.core.schema.nodeActive
import org.ssa.assistant.core.schema.questionFromSchema
import org.ssa.assistant.core.schema.sectionActive
import org.ssa.assistant.core.Question
import org.ssa.assistant.core.Option

/**
 * Port of src/engine.js: the interview state machine. The state is the same
 * serializable JSON shape (answers, cursor, history, skipped, pace), so a
 * session exported by the web app resumes here unchanged, and the `walks`
 * golden compares getState() trees step for step.
 */
class Engine(
    private val schema: Schema,
    savedState: Json.Obj? = null,
    private val clock: () -> Double = { System.currentTimeMillis() / 1000.0 },
) {
    companion object {
        const val IDLE_CUTOFF = 180.0
        const val PACE_WINDOW = 12
        const val MIN_SAMPLES = 4
    }

    private val nodes: List<Node> = flatten(schema.sections)

    private var state: Json.Obj = savedState?.deepCopy() as? Json.Obj ?: Json.Obj().also { root ->
        root["schema"] = Json.Num(schema.schemaVersion)
        root["answers"] = Json.Obj()
        root["cursor"] = Json.Obj().also { c ->
            c["node"] = Json.Num(0.0); c["phase"] = Json.Null; c["loopIndex"] = Json.Num(0.0); c["fieldIndex"] = Json.Num(0.0)
        }
        root["history"] = Json.Arr()
        root["skipped"] = Json.Arr()
        root["pace"] = Json.Obj().also { p -> p["samples"] = Json.Arr(); p["peak"] = Json.Num(0.0) }
    }

    private var lastAskedAt: Double? = null
    private var currentKey: String? = null

    init {
        // A state saved before pace tracking existed has neither field.
        val pace = state["pace"] as? Json.Obj
        if (pace == null || (pace["samples"] as? Json.Arr) == null) {
            state["pace"] = Json.Obj().also { p -> p["samples"] = Json.Arr(); p["peak"] = Json.Num(0.0) }
        }
        if ((state["answers"] as? Json.Obj) == null) state["answers"] = Json.Obj()
        if ((state["history"] as? Json.Arr) == null) state["history"] = Json.Arr()
        if ((state["skipped"] as? Json.Arr) == null) state["skipped"] = Json.Arr()

        if (savedState == null) {
            seek(0)
        } else if ((state["schema"] as? Json.Num)?.value != schema.schemaVersion || (state["cursor"] as? Json.Obj) == null) {
            if ((state["schema"] as? Json.Num)?.value != schema.schemaVersion &&
                (state["answers"] as Json.Obj)["forms"] == null
            ) {
                (state["answers"] as Json.Obj)["forms"] = Json.Str("ssa")
            }
            state["schema"] = Json.Num(schema.schemaVersion)
            state["history"] = Json.Arr()
            val pos = firstUnanswered()
            state["cursor"] = pos.cursor
            state["catchUp"] = Json.bool(pos.node < nodes.size)
        }
    }

    // -- helpers -----------------------------------------------------------------

    private val answersObj: Json.Obj get() = state["answers"] as Json.Obj

    private fun nodeAt(i: Int): Node? = nodes.getOrNull(i)

    private fun active(node: Node): Boolean = nodeActive(node, answersObj)

    private fun itemsOf(node: Node): Json.Arr {
        val v = answersObj[node.id]
        return v as? Json.Arr ?: Json.Arr()
    }

    private fun cursor(): Json.Obj = state["cursor"] as Json.Obj
    private fun cursorNode(): Int = (cursor()["node"] as Json.Num).value.toInt()
    private fun cursorPhase(): String? = (cursor()["phase"] as? Json.Str)?.value
    private fun cursorLoopIndex(): Int = (cursor()["loopIndex"] as Json.Num).value.toInt()
    private fun cursorFieldIndex(): Int = (cursor()["fieldIndex"] as Json.Num).value.toInt()

    private fun setCursor(node: Int, phase: String?, loopIndex: Int, fieldIndex: Int) {
        val c = cursor()
        c["node"] = Json.Num(node.toDouble())
        c["phase"] = phase?.let { Json.Str(it) } ?: Json.Null
        c["loopIndex"] = Json.Num(loopIndex.toDouble())
        c["fieldIndex"] = Json.Num(fieldIndex.toDouble())
    }

    private fun currentItem(): Json.Obj? {
        val node = nodeAt(cursorNode()) ?: return null
        if (node.type != "loop") return null
        return itemsOf(node).items.getOrNull(cursorLoopIndex()) as? Json.Obj
    }

    /**
     * askIf for a loop field, evaluated against its own item — an empty one
     * when there is none yet, so the rule reads item scope, never the answers.
     */
    private fun shouldAsk(field: Json.Obj, item: Json.Obj?): Boolean {
        val rule = field["askIf"]
        if (rule == null || rule === Json.Null) return true
        return try {
            evalRule(rule, answersObj, item ?: Json.Obj())
        } catch (e: Exception) {
            true
        }
    }

    private fun markAsked() { lastAskedAt = clock() }
    private fun recordPace() {
        val at = lastAskedAt ?: return
        lastAskedAt = null
        val elapsed = clock() - at
        if (!(elapsed > 0) || elapsed > IDLE_CUTOFF) return
        val samples = (state["pace"] as Json.Obj)["samples"] as Json.Arr
        samples.items.add(Json.Num(elapsed))
        if (samples.items.size > PACE_WINDOW) samples.items.removeAt(0)
    }

    private fun snapshotCursor() {
        val history = state["history"] as Json.Arr
        history.items.add(cursor().deepCopy())
        if (history.items.size > 200) history.items.removeAt(0)
    }

    private fun seek(from: Int) {
        var i = from
        val catchUp = jsTruthy(state["catchUp"])
        while (i < nodes.size && (!active(nodes[i]) || (catchUp && settled(nodes[i])))) i += 1
        if (i >= nodes.size) state["catchUp"] = Json.False
        val node = nodeAt(i)
        setCursor(
            i,
            if (node?.type == "loop") "entry" else null,
            if (node?.type == "loop") itemsOf(node).items.size else 0,
            0
        )
    }

    private fun settled(node: Node): Boolean {
        if (node.type == "loop") return answersObj[node.id] is Json.Arr
        return answersObj.entries.containsKey(node.id)
    }

    private fun openItem(node: Node) {
        var arr = answersObj[node.id] as? Json.Arr
        if (arr == null) {
            arr = Json.Arr()
            answersObj[node.id] = arr
        }
        val c = cursor()
        c["loopIndex"] = Json.Num(arr.items.size.toDouble())
        arr.items.add(Json.Obj())
        c["phase"] = Json.Str("field")
        c["fieldIndex"] = Json.Num(0.0)
    }

    private fun returnToEntry(node: Node) {
        val c = cursor()
        c["phase"] = Json.Str("entry")
        c["loopIndex"] = Json.Num(itemsOf(node).items.size.toDouble())
        c["fieldIndex"] = Json.Num(0.0)
    }

    private fun positionAtAskableField(node: Node): Boolean {
        val item = currentItem() ?: Json.Obj()
        while (cursorFieldIndex() < (node.fields?.size ?: 0)) {
            val f = node.fields!![cursorFieldIndex()]
            if (shouldAsk(f, item)) return true
            cursor()["fieldIndex"] = Json.Num((cursorFieldIndex() + 1).toDouble())
        }
        return false
    }

    private fun closeLoop(node: Node) {
        if (answersObj[node.id] !is Json.Arr) answersObj[node.id] = Json.Arr()
        seek(cursorNode() + 1)
    }

    private data class Position(val node: Int, val phase: String?, val loopIndex: Int, val fieldIndex: Int) {
        val cursor: Json.Obj get() = Json.Obj().also { c ->
            c["node"] = Json.Num(node.toDouble())
            c["phase"] = phase?.let { Json.Str(it) } ?: Json.Null
            c["loopIndex"] = Json.Num(loopIndex.toDouble())
            c["fieldIndex"] = Json.Num(fieldIndex.toDouble())
        }
    }

    private fun firstUnanswered(): Position {
        for (i in nodes.indices) {
            val node = nodes[i]
            if (!active(node)) continue
            if (node.type != "loop") {
                if (!answersObj.entries.containsKey(node.id)) return Position(i, null, 0, 0)
                continue
            }
            val items = answersObj[node.id] as? Json.Arr
            if (items == null) return Position(i, "entry", 0, 0)
            val last = items.items.size - 1
            if (last < 0) continue
            val item = items.items[last] as? Json.Obj ?: Json.Obj()
            val fi = (node.fields ?: emptyList()).indexOfFirst { f ->
                !item.entries.containsKey(f["id"]?.asString()) && shouldAsk(f, item)
            }
            if (fi >= 0) return Position(i, "field", last, fi)
        }
        return Position(nodes.size, null, 0, 0)
    }

    // -- public surface -----------------------------------------------------------

    /** The question to ask right now, or null when the interview is complete. */
    fun current(): Question? {
        val q = buildCurrent()
        val key = q?.path?.joinToString("/")
        if (key != currentKey) {
            currentKey = key
            if (q != null) markAsked() else lastAskedAt = null
        }
        return q
    }

    private fun buildCurrent(): Question? {
        val node = nodeAt(cursorNode()) ?: return null

        fun base(f: Json.Obj): Question =
            questionFromSchema(f).copy(section = node.section, sectionTitle = node.sectionTitle)

        if (node.type != "loop") {
            return base(node.raw).copy(path = listOf<Any>(node.id ?: ""))
        }

        if (cursorPhase() == "entry") {
            val items = itemsOf(node)
            val isRepeat = items.items.isNotEmpty()
            if (node.entryIsFirstField && !isRepeat) {
                val f = node.fields!![0]
                return base(f).copy(
                    id = "${node.id}__entry",
                    prompt = node.entryPrompt ?: f["prompt"]?.asString() ?: "",
                    loopId = node.id,
                    loopPhase = "entry",
                    itemLabel = node.itemLabel,
                    itemNumber = 1,
                    path = listOf<Any>(node.id ?: "", "entry", 0)
                )
            }
            return Question(
                id = "${node.id}__entry",
                prompt = if (isRepeat) node.repeatPrompt ?: "" else node.entryPrompt ?: "",
                type = "yesno",
                section = node.section,
                sectionTitle = node.sectionTitle,
                loopId = node.id,
                loopPhase = "entry",
                itemLabel = node.itemLabel,
                itemNumber = items.items.size + 1,
                path = listOf<Any>(node.id ?: "", "entry", items.items.size)
            )
        }

        val f = node.fields?.getOrNull(cursorFieldIndex()) ?: return null
        return base(f).copy(
            loopId = node.id,
            loopPhase = "field",
            itemLabel = node.itemLabel,
            itemNumber = cursorLoopIndex() + 1,
            path = listOf<Any>(node.id ?: "", cursorLoopIndex(), f["id"]?.asString() ?: "")
        )
    }

    /** Record a value for the current question and advance. Returns the next. */
    fun submit(value: Any?): Question? {
        val node = nodeAt(cursorNode()) ?: return null
        recordPace()
        snapshotCursor()

        if (node.type != "loop") {
            answersObj[node.id] = Json.of(value)
            seek(cursorNode() + 1)
            return current()
        }

        if (cursorPhase() == "entry") {
            val answersFirstField = node.entryIsFirstField &&
                value !is Boolean && value != null && itemsOf(node).items.isEmpty()
            if (answersFirstField) {
                openItem(node)
                (currentItem() ?: return current())[(node.fields!![0]["id"]?.asString())] = Json.of(value)
                cursor()["fieldIndex"] = Json.Num(1.0)
                if (!positionAtAskableField(node)) returnToEntry(node)
            } else if (value == true) {
                openItem(node)
                if (!positionAtAskableField(node)) returnToEntry(node)
            } else {
                closeLoop(node)
            }
            return current()
        }

        val item = currentItem()
        val f = node.fields?.getOrNull(cursorFieldIndex())
        if (item != null && f != null) item[f["id"]?.asString()] = Json.of(value)
        cursor()["fieldIndex"] = Json.Num((cursorFieldIndex() + 1).toDouble())
        if (!positionAtAskableField(node)) returnToEntry(node)
        return current()
    }

    /** Leave the current question unanswered and advance. */
    fun skip(): Question? {
        val q = current() ?: return null
        val skipped = state["skipped"] as Json.Arr
        if (skipped.items.none { (it as? Json.Str)?.value == q.id }) skipped.items.add(Json.Str(q.id))
        if (q.loopPhase == "entry") return submit(false)
        return submit(null)
    }

    /** Step back to the previous question, discarding its answer. */
    fun back(): Question? {
        val history = state["history"] as Json.Arr
        if (history.items.isEmpty()) return current()
        val prev = history.items.removeAt(history.items.size - 1) as? Json.Obj
            ?: return current()
        state["cursor"] = prev
        val q = current()
        if (q != null) {
            when {
                q.loopPhase == "field" -> currentItem()?.entries?.remove(q.id)
                q.loopPhase == "entry" -> {
                    val node = nodeAt(cursorNode())
                    if (node != null) {
                        val items = itemsOf(node)
                        if (items.items.size > cursorLoopIndex()) {
                            while (items.items.size > cursorLoopIndex()) items.items.removeAt(items.items.size - 1)
                        }
                    }
                }
                else -> answersObj.entries.remove(q.id)
            }
        }
        return q
    }

    /** Jump to a specific question id, for the review-and-correct pass. */
    fun jumpTo(questionId: String, loopIndex: Int = 0, loopId: String? = null): Question? {
        for (i in nodes.indices) {
            val node = nodes[i]
            if (node.type != "loop") {
                if (loopId != null) continue
                if (node.id == questionId) {
                    if (!active(node)) return null
                    snapshotCursor()
                    setCursor(i, null, 0, 0)
                    return current()
                }
                continue
            }
            if (loopId != null && node.id != loopId) continue
            if (!active(node)) continue
            val fi = (node.fields ?: emptyList()).indexOfFirst { f -> f["id"]?.asString() == questionId }
            if (fi >= 0) {
                val items = answersObj[node.id] as? Json.Arr
                if (items == null || loopIndex >= items.items.size) return null
                snapshotCursor()
                setCursor(i, "field", loopIndex, fi)
                return current()
            }
            if (node.id == questionId) {
                snapshotCursor()
                setCursor(i, "entry", itemsOf(node).items.size, 0)
                return current()
            }
        }
        return null
    }

    fun cursorSnapshot(): Json.Obj = cursor().deepCopy() as Json.Obj

    /**
     * Put the walk back where a detour found it, dropping the undo entry the
     * detour's jumpTo() pushed.
     */
    fun restoreCursor(saved: Json.Obj?) {
        if (saved != null) rewind(state, saved)
    }

    private fun rewind(target: Json.Obj, saved: Json.Obj) {
        val history = target["history"] as Json.Arr
        val top = history.items.lastOrNull()
        if (top != null && top.treeEquals(saved)) history.items.removeAt(history.items.size - 1)
        target["cursor"] = saved.deepCopy()
    }

    /** Write one answer in place, without moving the cursor. */
    fun setAnswer(questionId: String, value: Any?, loopId: String? = null, loopIndex: Int = 0): Boolean {
        if (loopId != null) {
            val node = nodes.firstOrNull { n -> n.id == loopId && n.type == "loop" } ?: return false
            if ((node.fields ?: emptyList()).none { it["id"]?.asString() == questionId }) return false
            val items = answersObj[loopId] as? Json.Arr ?: return false
            val item = items.items.getOrNull(loopIndex) as? Json.Obj ?: return false
            item[questionId] = Json.of(value)
            return true
        }
        val node = nodes.firstOrNull { n -> n.id == questionId && n.type != "loop" } ?: return false
        answersObj[questionId] = Json.of(value)
        val skipped = state["skipped"] as Json.Arr
        val idx = skipped.items.indexOfFirst { (it as? Json.Str)?.value == questionId }
        if (idx >= 0 && value != null && value != "") skipped.items.removeAt(idx)
        return true
    }

    data class ListedItem(
        val index: Int,
        val number: Int,
        val itemLabel: String?,
        val title: String?,
        val values: Json.Obj,
    )

    /** The recorded items of a loop, for naming them aloud. */
    fun listItems(loopId: String): List<ListedItem> {
        val node = nodes.firstOrNull { n -> n.id == loopId && n.type == "loop" } ?: return emptyList()
        val items = answersObj[loopId] as? Json.Arr ?: return emptyList()
        return items.items.mapIndexed { index, raw ->
            val item = raw as? Json.Obj ?: Json.Obj()
            ListedItem(
                index = index,
                number = index + 1,
                itemLabel = node.itemLabel,
                title = (item[node.fields?.getOrNull(0)?.get("id")?.asString()] as? Json.Str)?.value,
                values = item.deepCopy() as Json.Obj
            )
        }
    }

    /** Delete one item from a loop. */
    fun removeItem(loopId: String, loopIndex: Int): Boolean {
        val nodeIndex = nodes.indexOfFirst { n -> n.id == loopId && n.type == "loop" }
        if (nodeIndex < 0) return false
        val items = answersObj[loopId] as? Json.Arr ?: return false
        if (loopIndex < 0 || loopIndex >= items.items.size) return false
        items.items.removeAt(loopIndex)

        fun repair(c: Json.Obj) {
            val cn = (c["node"] as Json.Num).value.toInt()
            if (cn != nodeIndex) return
            val li = (c["loopIndex"] as Json.Num).value.toInt()
            if (li > loopIndex) {
                c["loopIndex"] = Json.Num((li - 1).toDouble())
            } else if (li == loopIndex) {
                c["phase"] = Json.Str("entry")
                c["loopIndex"] = Json.Num(items.items.size.toDouble())
                c["fieldIndex"] = Json.Num(0.0)
            }
        }

        repair(cursor())
        for (h in (state["history"] as Json.Arr).items) (h as? Json.Obj)?.let { repair(it) }
        return true
    }

    data class Progress(
        val section: String?,
        val sectionTitle: String?,
        val sectionNumber: Int?,
        val sectionCount: Int?,
        val answered: Int,
        val remaining: Int,
        val total: Int,
        val percent: Int,
        val rawPercent: Int,
        val secondsRemaining: Int?,
    )

    fun progress(): Progress {
        val (answered, total) = countQuestions()
        val done = Math.min(answered, total)
        val raw = if (total > 0) Math.round(done.toDouble() / total * 100).toInt() else 100

        val pace = state["pace"] as Json.Obj
        if (raw > (pace["peak"] as Json.Num).value) pace["peak"] = Json.Num(raw.toDouble())
        val percent = Math.min((pace["peak"] as Json.Num).value.toInt(), 100)

        val node = nodeAt(cursorNode())
        val chosen = listOf("ssa", "ds", "both").contains((answersObj["forms"] as? Json.Str)?.value)
        val used = schema.sections.filter { sectionActive(it, answersObj) }
        return Progress(
            section = node?.section,
            sectionTitle = node?.sectionTitle,
            // JS: findIndex(...) + 1, so 0 when the cursor's section is not one
            // the chosen forms use.
            sectionNumber = if (chosen) {
                node?.let { n -> used.indexOfFirst { s -> s["id"]?.asString() == n.section } + 1 } ?: used.size
            } else null,
            sectionCount = if (chosen) used.size else null,
            answered = done,
            remaining = Math.max(0, total - done),
            total = total,
            percent = percent,
            rawPercent = raw,
            secondsRemaining = estimateSeconds(Math.max(0, total - done))
        )
    }

    private data class Count(val answered: Int, val total: Int)

    private fun countQuestions(): Count {
        var total = 0
        var answered = 0
        val cur = cursor()
        val curNode = (cur["node"] as Json.Num).value.toInt()

        fun fieldsFor(node: Node, item: Json.Obj?): Int =
            (node.fields ?: emptyList()).count { shouldAsk(it, item) }

        for (i in nodes.indices) {
            val node = nodes[i]
            val past = i < curNode
            val currentN = i == curNode
            if (!active(node)) continue
            if (node.type != "loop") {
                total += 1
                if (past) answered += 1
                continue
            }

            val items = answersObj[node.id] as? Json.Arr

            val entryCost = 1
            val firstFree = if (node.entryIsFirstField) 1 else 0
            fun itemCost(item: Json.Obj?, idx: Int): Int =
                entryCost + fieldsFor(node, item) - (if (idx == 0) firstFree else 0)

            if (past) {
                val list = items ?: Json.Arr()
                var cost = entryCost
                list.items.forEachIndexed { idx, item -> cost += itemCost(item as? Json.Obj, idx) }
                total += cost
                answered += cost
                continue
            }

            if (!currentN) {
                total += itemCost(null, 0)
                continue
            }

            val list = items ?: Json.Arr()
            val openIndex = if (cursorPhase() == "field") cursorLoopIndex() else -1

            list.items.forEachIndexed { idx, raw ->
                val item = raw as? Json.Obj
                val cost = itemCost(item, idx)
                total += cost
                when {
                    idx < openIndex || cursorPhase() == "entry" -> answered += cost
                    idx == openIndex -> answered += cost - fieldsFor(node, item) + fieldsAnsweredIn(node, item)
                }
            }

            if (cursorPhase() == "entry") {
                total += if (list.items.isEmpty()) itemCost(null, 0) else entryCost
            } else {
                total += entryCost
            }
        }
        return Count(answered, total)
    }

    private fun fieldsAnsweredIn(node: Node, item: Json.Obj?): Int {
        var n = 0
        var i = 0
        while (i < cursorFieldIndex() && i < (node.fields?.size ?: 0)) {
            if (shouldAsk(node.fields!![i], item)) n += 1
            i++
        }
        return n
    }

    private fun estimateSeconds(remaining: Int): Int? {
        val samples = (state["pace"] as Json.Obj)["samples"] as Json.Arr
        if (samples.items.size < MIN_SAMPLES) return null
        val sorted = samples.items.map { (it as Json.Num).value }.sorted()
        val mid = sorted.size / 2
        val median = if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2
        return Math.round(median * remaining).toInt()
    }

    data class Missing(val id: String, val prompt: String?, val loopId: String?, val loopIndex: Int)

    /** Required questions with no recorded answer, for the review pass. */
    fun missingRequired(): List<Missing> {
        val missing = mutableListOf<Missing>()
        for (node in nodes) {
            if (!active(node)) continue
            if (node.type == "loop") {
                val items = answersObj[node.id] as? Json.Arr ?: Json.Arr()
                items.items.forEachIndexed { idx, raw ->
                    val item = raw as? Json.Obj ?: Json.Obj()
                    for (f in node.fields ?: emptyList()) {
                        if (!jsTruthy(f["required"])) continue
                        if (!shouldAsk(f, item)) continue
                        val v = item[f["id"]?.asString()]
                        if (v == null || v === Json.Null || (v is Json.Str && v.value.isEmpty())) {
                            missing.add(Missing(f["id"]?.asString() ?: "", f["prompt"]?.asString(), node.id, idx))
                        }
                    }
                }
                continue
            }
            if (!node.required) continue
            val v = answersObj[node.id]
            if (v == null || v === Json.Null || (v is Json.Str && v.value.isEmpty())) {
                missing.add(Missing(node.id ?: "", node.prompt, null, 0))
            }
        }
        return missing
    }

    /** Move to the first active question with nothing recorded. */
    fun rewalk(): Question? {
        snapshotCursor()
        val pos = firstUnanswered()
        state["cursor"] = pos.cursor
        state["catchUp"] = Json.bool(pos.node < nodes.size)
        return current()
    }

    fun answers(): Json.Obj = answersObj.deepCopy() as Json.Obj

    fun isComplete(): Boolean = cursorNode() >= nodes.size

    /**
     * The full state, as store.js would save it. `returnTo` is the
     * cursorSnapshot() of a detour still open — a correction — and the copy is
     * the state as restoreCursor() will leave it, which is what a save made in
     * the middle of a correction must keep.
     */
    fun getState(returnTo: Json.Obj? = null): Json.Obj {
        val copy = state.deepCopy() as Json.Obj
        if (returnTo != null) rewind(copy, returnTo)
        return copy
    }

    fun reset(): Question? {
        state["answers"] = Json.Obj()
        seek(0)
        state["history"] = Json.Arr()
        state["skipped"] = Json.Arr()
        state["pace"] = Json.Obj().also { p -> p["samples"] = Json.Arr(); p["peak"] = Json.Num(0.0) }
        state["catchUp"] = Json.False
        lastAskedAt = null
        currentKey = null
        return current()
    }
}
