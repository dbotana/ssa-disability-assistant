package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.engine.Engine
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The `walks` golden: seeded engine walks, replayed from the actions they
 * recorded — submit (with the value), skip, back, a correction, a save made
 * mid-correction, and removing a loop item — comparing current(), progress(),
 * missingRequired() and getState() after every one. The generator's random
 * numbers only chose the walk; nothing here needs them.
 *
 * The replay calls current() where the generator did — before each action as
 * well as after — because current() starts the pacing clock, and the pace
 * samples are part of the state being compared.
 */
class WalksGoldenTest {

    private val schema = SchemaLoader.load()
    private val golden = Golden.load("walks")

    private fun progressTree(p: Engine.Progress): Json.Obj = Json.Obj().also { o ->
        o["section"] = p.section?.let { Json.Str(it) } ?: Json.Null
        o["sectionTitle"] = p.sectionTitle?.let { Json.Str(it) } ?: Json.Null
        o["sectionNumber"] = p.sectionNumber?.let { Json.Num(it.toDouble()) } ?: Json.Null
        o["sectionCount"] = p.sectionCount?.let { Json.Num(it.toDouble()) } ?: Json.Null
        o["answered"] = Json.Num(p.answered.toDouble())
        o["remaining"] = Json.Num(p.remaining.toDouble())
        o["total"] = Json.Num(p.total.toDouble())
        o["percent"] = Json.Num(p.percent.toDouble())
        o["rawPercent"] = Json.Num(p.rawPercent.toDouble())
        o["secondsRemaining"] = p.secondsRemaining?.let { Json.Num(it.toDouble()) } ?: Json.Null
    }

    private fun missingTree(list: List<Engine.Missing>): Json = Json.Arr(list.mapTo(mutableListOf()) { m ->
        Json.Obj().also { o ->
            o["id"] = Json.Str(m.id)
            o["loopId"] = m.loopId?.let { Json.Str(it) } ?: Json.Null
            o["loopIndex"] = if (m.loopId == null) Json.Null else Json.Num(m.loopIndex.toDouble())
        }
    })

    @Test
    fun walks() {
        val walks = golden.asObject()!!["walks"]!!.asArray()!!.items
        check(walks.isNotEmpty())
        val seen = mutableSetOf<String>()

        for ((w, rawWalk) in walks.withIndex()) {
            val actions = rawWalk.asObject()!!["actions"]!!.asArray()!!.items

            // FIXED_TICKS in index.mjs: 1_000_000 + i * 7000 ms, walk w starting at i = w * 500.
            var tick = w * 500
            val engine = Engine(schema, null) { (1_000_000L + tick++ * 7000L) / 1000.0 }

            for ((i, raw) in actions.withIndex()) {
                val a = raw.asObject()!!
                val where = "walks[$w].actions[$i] (${a["action"]!!.asString()})"
                engine.current()

                when (val action = a["action"]!!.asString()!!) {
                    "submit" -> engine.submit(Golden.kotlinValue(a["value"]))
                    "skip" -> engine.skip()
                    "back" -> engine.back()
                    "correct" -> {
                        val id = a["id"]!!.asString()!!
                        val restore = engine.cursorSnapshot()
                        engine.jumpTo(id)
                        engine.setAnswer(id, Golden.kotlinValue(a["value"]))
                        engine.restoreCursor(restore)
                    }
                    "saveMidCorrection" -> {
                        val restore = engine.cursorSnapshot()
                        engine.jumpTo(a["id"]!!.asString()!!)
                        Golden.assertTree("walks", "$where savedState", engine.getState(returnTo = restore), a["savedState"]!!)
                        engine.restoreCursor(restore)
                    }
                    "remove" -> {
                        val removed = engine.removeItem(a["loopId"]!!.asString()!!, a["loopIndex"]!!.asDouble()!!.toInt())
                        check(removed == a["removed"]!!.asBoolean()) { "$where: removeItem returned $removed" }
                    }
                    else -> error("$where: unknown action $action")
                }
                seen.add(a["action"]!!.asString()!!)

                Golden.assertTree("walks", "$where current", Golden.currentView(engine.current()), a["current"]!!)
                Golden.assertTree("walks", "$where progress", progressTree(engine.progress()), a["progress"]!!)
                Golden.assertTree("walks", "$where missing", missingTree(engine.missingRequired()), a["missing"]!!)
                Golden.assertTree("walks", "$where state", engine.getState(), a["state"]!!)
            }
        }
        check(seen.containsAll(listOf("submit", "skip", "back", "correct", "saveMidCorrection", "remove"))) {
            "the walks never exercised ${listOf("submit", "skip", "back", "correct", "saveMidCorrection", "remove") - seen}"
        }
    }
}
