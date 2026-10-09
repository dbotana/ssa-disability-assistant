package org.ssa.assistant.core.golden

import org.ssa.assistant.core.Question
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.json.writeJson

/**
 * Golden test harness: loads the golden fixtures from the test resources
 * directory and compares structures as parsed JSON trees.
 */
object Golden {
    fun load(name: String): Json {
        val stream = Golden::class.java.classLoader.getResourceAsStream("golden/$name.json")
            ?: throw IllegalStateException("missing golden $name.json — run `node tools/golden/index.mjs`")
        return JsonParser.parse(stream.readBytes().toString(Charsets.UTF_8))
    }

    fun assertTree(name: String, path: String, actual: Json, expected: Json) {
        check(actual.treeEquals(expected)) {
            "golden $name.json mismatch at $path:\n  expected: ${expected.writeJson().take(600)}\n  actual:   ${actual.writeJson().take(600)}"
        }
    }

    fun jsonPath(root: Json, vararg path: String): Json {
        var cur = root
        for (p in path) {
            cur = (cur.asObject()?.get(p) ?: (cur.asArray()?.items?.getOrNull(p.toIntOrNull() ?: -1)))
                ?: throw IllegalStateException("no path ${path.joinToString("/")}")
        }
        return cur
    }

    /** A golden value as the Kotlin value the engine takes: String, Double, Boolean or null. */
    fun kotlinValue(j: Json?): Any? = when (j) {
        null, Json.Null -> null
        Json.True -> true
        Json.False -> false
        is Json.Str -> j.value
        is Json.Num -> j.value
        else -> j
    }

    /**
     * The fields of current() the walks golden records, as currentView() in
     * tools/golden/index.mjs builds them: JS's absent values as null.
     */
    fun currentView(q: Question?): Json {
        if (q == null) return Json.Null
        val str = { v: String? -> if (v == null) Json.Null else Json.Str(v) }
        return Json.Obj().also { o ->
            o["id"] = Json.Str(q.id)
            o["type"] = Json.Str(q.type)
            o["prompt"] = Json.Str(q.prompt)
            o["path"] = Json.Arr(q.path.mapTo(mutableListOf()) { if (it is Int) Json.Num(it.toDouble()) else Json.Str(it.toString()) })
            o["section"] = str(q.section)
            o["sectionTitle"] = str(q.sectionTitle)
            o["loopId"] = str(q.loopId)
            o["loopPhase"] = str(q.loopPhase)
            o["itemLabel"] = str(q.itemLabel)
            o["itemNumber"] = q.itemNumber?.let { Json.Num(it.toDouble()) } ?: Json.Null
            o["required"] = Json.bool(q.required)
            o["confirm"] = Json.bool(q.confirm)
            o["allowFuture"] = Json.bool(q.allowFuture)
            o["per"] = str(q.per)
            o["kind"] = str(q.kind)
            o["hint"] = str(q.hint)
            o["warn"] = str(q.warn)
            o["options"] = q.options?.let { opts -> Json.Arr(opts.mapTo(mutableListOf()) { Json.Str(it.value) }) } ?: Json.Null
        }
    }
}

/** One addendum draw op as the `addendum` golden records it. */
fun opTree(op: org.ssa.assistant.core.pdf.Op): Json = when (op) {
    is org.ssa.assistant.core.pdf.Op.Text -> Json.Obj().also { o ->
        o["op"] = Json.Str("text")
        o["x"] = Json.Num(op.x)
        o["y"] = Json.Num(op.y)
        o["text"] = Json.Str(op.text)
        o["size"] = Json.Num(op.size)
        o["font"] = Json.Str(op.font)
        o["color"] = Json.Str(op.color)
    }
    is org.ssa.assistant.core.pdf.Op.Rule -> Json.Obj().also { o ->
        o["op"] = Json.Str("rule")
        o["x"] = Json.Num(op.x)
        o["y"] = Json.Num(op.y)
        o["width"] = Json.Num(op.width)
        o["thickness"] = Json.Num(op.thickness)
    }
}

/** A draw list (pages of ops) as a tree. */
fun pagesTree(pages: List<List<org.ssa.assistant.core.pdf.Op>>): Json =
    Json.Arr(pages.mapTo(mutableListOf()) { page -> Json.Arr(page.mapTo(mutableListOf()) { opTree(it) }) })

/** An answer fixture from tests/fixtures/answers, pinned into the test resources. */
fun fixture(name: String): Json.Obj {
    val stream = Golden::class.java.classLoader.getResourceAsStream("fixtures/answers/$name.json")
        ?: throw IllegalStateException("missing fixture $name.json")
    return org.ssa.assistant.core.json.JsonParser.parse(stream.readBytes().toString(Charsets.UTF_8)).asObject()!!
}
