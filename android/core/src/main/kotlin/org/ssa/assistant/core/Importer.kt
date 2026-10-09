package org.ssa.assistant.core

import org.ssa.assistant.core.engine.Engine
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.Node
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.flatten

/**
 * Port of src/importer.js: reading back a file written by downloadJson().
 *
 * Deliberately forgiving about shape and strict about types: anything it
 * cannot vouch for is dropped rather than handed to the engine, which assumes
 * its own state is well formed. A v1 or v2 file still imports (the form
 * choice is filled in as the Starter Kit and the cursor rebuilt); a v3 file
 * whose cursor does not fit the schema is rebuilt the same way.
 */

class ImportError(message: String) : Exception(message)

data class ImportResult(val state: Json.Obj, val savedAt: String?, val rebuiltCursor: Boolean)

object Importer {
    const val MAX_BYTES = 5 * 1024 * 1024

    /**
     * Parse the text of an exported file. Throws ImportError with a sentence
     * fit to be spoken aloud.
     */
    fun parseExport(schema: Schema, text: String): ImportResult {
        val parsed = try {
            JsonParser.parse(text)
        } catch (e: IllegalArgumentException) {
            throw ImportError("That file is not a saved answers file. It could not be read as JSON.")
        }
        val root = parsed.asObject()
            ?: throw ImportError("That file does not look like a saved answers file.")

        val answers = sanitizeAnswers(root["answers"], schema)
            ?: throw ImportError("That file has no answers in it. Choose the file you saved from this page.")
        if (answers.entries.isEmpty()) {
            throw ImportError("That file has no answers in it. Choose the file you saved from this page.")
        }

        val savedAt = root["savedAt"]?.asString()

        val nodes = flatten(schema.sections)
        val saved = root["state"]?.asObject()
        val current = (saved?.get("schema") as? Json.Num)?.value == schema.schemaVersion
        if (!current && !answers.entries.containsKey("forms")) {
            answers["forms"] = Json.Str("ssa")
        }
        val cursor = if (current) validCursor(saved?.get("cursor"), nodes, answers) else null

        val state = Json.Obj().also { s ->
            s["schema"] = Json.Num(schema.schemaVersion)
            s["answers"] = answers
            s["cursor"] = cursor ?: rebuildCursor(schema, answers)
            s["history"] = Json.Arr()
            s["skipped"] = Json.Arr(
                (saved?.get("skipped") as? Json.Arr)?.items
                    ?.filter { it.asString() != null }
                    ?.toMutableList() ?: mutableListOf()
            )
            s["pace"] = validPace(saved?.get("pace"))
            // A rebuilt cursor sits on the first gap, with answered questions
            // after it; catch-up mode walks past those instead of asking again.
            s["catchUp"] = Json.bool(if (cursor != null) (saved?.get("catchUp") === Json.True) else true)
        }

        return ImportResult(state, savedAt, rebuiltCursor = cursor == null)
    }

    // -- validation -------------------------------------------------------------

    /**
     * Keep only ids the current schema knows, with the value shape that id
     * expects. Unknown ids are dropped: a file from an older schema imports
     * the part of itself that still means something rather than failing whole.
     */
    private fun sanitizeAnswers(raw: Json?, schema: Schema): Json.Obj? {
        val source = raw?.asObject() ?: return null
        val out = Json.Obj()
        for (section in schema.sections) {
            for (q in section["questions"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()) {
                val id = q["id"]?.asString() ?: continue
                val value = source[id] ?: continue
                if (q["type"]?.asString() == "loop") {
                    val arr = value.asArray() ?: continue
                    val fieldIds = (q["fields"]?.asArray()?.items?.mapNotNull { it.asObject()?.get("id")?.asString() } ?: emptyList()).toSet()
                    val kept = arr.items
                        .mapNotNull { item -> item.asObject() }
                        .map { item ->
                            val keptItem = Json.Obj()
                            for ((k, v) in item.entries) {
                                if (fieldIds.contains(k) && isScalar(v)) keptItem[k] = v
                            }
                            keptItem
                        }
                        .filter { it.entries.isNotEmpty() }
                    // An empty list is an answer too: it is what "no" at the
                    // loop's first prompt leaves behind.
                    out[id] = Json.Arr(kept.toMutableList())
                    continue
                }
                if (!isScalar(value)) continue
                // A choice must still be one of its options.
                if (q["type"]?.asString() == "choice" &&
                    (q["options"]?.asArray()?.items?.mapNotNull { it.asObject()?.get("value")?.asString() }
                        ?.contains(value.asString()) != true)
                ) continue
                out[id] = value
            }
        }
        return out
    }

    private fun isScalar(v: Json): Boolean =
        v is Json.Str || v is Json.Num || v === Json.True || v === Json.False

    /** A cursor is usable only if it points at a position this schema still has. */
    private fun validCursor(cursor: Json?, nodes: List<Node>, answers: Json.Obj): Json.Obj? {
        val c = cursor?.asObject() ?: return null
        val node = (c["node"] as? Json.Num)?.value?.toInt() ?: return null
        if (node < 0 || node > nodes.size) return null
        if (node == nodes.size) {
            // A finished interview: the cursor sits one past the last node.
            return Json.Obj().also { o ->
                o["node"] = Json.Num(node.toDouble())
                o["phase"] = Json.Null
                o["loopIndex"] = Json.Num(0.0)
                o["fieldIndex"] = Json.Num(0.0)
            }
        }
        val target = nodes[node]
        if (target.type == "loop") {
            val phase = c["phase"]?.asString()
            if (phase != "entry" && phase != "field") return null
            val loopIndex = (c["loopIndex"] as? Json.Num)?.value?.toInt() ?: return null
            if (loopIndex < 0) return null
            val fieldIndex = (c["fieldIndex"] as? Json.Num)?.value?.toInt() ?: return null
            if (fieldIndex < 0 || fieldIndex >= (target.fields?.size ?: 0)) return null
            if (phase == "field") {
                val items = answers[target.id] as? Json.Arr ?: return null
                if (loopIndex >= items.items.size) return null
            }
            return Json.Obj().also { o ->
                o["node"] = Json.Num(node.toDouble())
                o["phase"] = Json.Str(phase)
                o["loopIndex"] = Json.Num(loopIndex.toDouble())
                o["fieldIndex"] = Json.Num(if (phase == "entry") 0.0 else fieldIndex.toDouble())
            }
        }
        val phase = c["phase"]?.asString()
        if (phase != null && phase != "entry" && phase != "field") return null
        return Json.Obj().also { o ->
            o["node"] = Json.Num(node.toDouble())
            o["phase"] = Json.Null
            o["loopIndex"] = Json.Num(0.0)
            o["fieldIndex"] = Json.Num(0.0)
        }
    }

    private fun validPace(pace: Json?): Json.Obj {
        val p = pace?.asObject() ?: Json.Obj()
        val samples = (p["samples"] as? Json.Arr)?.items
            ?.filter { n -> (n as? Json.Num)?.value?.let { it.isFinite() && it >= 0 } == true }
            ?: emptyList()
        val peak = (p["peak"] as? Json.Num)?.value?.let { if (it.isFinite()) it else 0.0 } ?: 0.0
        return Json.Obj().also { o ->
            o["samples"] = Json.Arr(samples.toMutableList())
            o["peak"] = Json.Num(peak)
        }
    }

    /**
     * The first question with no answer, among those the answers make active.
     * The engine owns that walk; this only asks it where it would land.
     */
    private fun rebuildCursor(schema: Schema, answers: Json.Obj): Json.Obj {
        val saved = Json.Obj().also { s ->
            s["schema"] = Json.Num(schema.schemaVersion)
            s["answers"] = answers
            s["cursor"] = Json.Null
            s["history"] = Json.Arr()
            s["skipped"] = Json.Arr()
            s["pace"] = Json.Null
        }
        val probe = Engine(schema, saved)
        return probe.getState()["cursor"] as Json.Obj
    }
}
