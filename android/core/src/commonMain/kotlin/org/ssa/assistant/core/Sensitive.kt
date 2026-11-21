package org.ssa.assistant.core

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.deepCopy
import org.ssa.assistant.core.schema.Node
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.flatten

/**
 * Port of the sensitive-answer parts of src/store.js: Social Security and
 * bank numbers are never written to disk, encrypted or not. A save records
 * only *that* one was given (withheld), and a resumed session asks for it
 * again.
 */

object Sensitive {
    private data class SensitiveField(val id: String, val loopId: String?)

    private fun sensitiveFields(schema: Schema): List<SensitiveField> =
        flatten(schema.sections).flatMap { node ->
            if (node.type == "loop") {
                (node.fields ?: emptyList())
                    .filter { f -> schema.sensitiveTypes.contains(f["type"]?.asString()) }
                    .map { f -> SensitiveField(f["id"]?.asString() ?: "", node.id) }
            } else if (schema.sensitiveTypes.contains(node.type)) {
                listOf(SensitiveField(node.id ?: "", null))
            } else emptyList()
        }

    private fun filled(v: Json?): Boolean = v != null && v !== Json.Null && !(v is Json.Str && v.value.isEmpty())

    /** Every sensitive answer present in a state, with its value. */
    fun sensitiveAnswers(schema: Schema, state: Json.Obj?): List<Json.Obj> {
        val answers = state?.get("answers")?.asObject() ?: Json.Obj()
        val out = mutableListOf<Json.Obj>()
        for (f in sensitiveFields(schema)) {
            if (f.loopId == null) {
                val v = answers[f.id]
                if (filled(v)) out.add(Json.Obj().also { o ->
                    o["id"] = Json.Str(f.id)
                    o["value"] = v!!
                })
                continue
            }
            val items = answers[f.loopId] as? Json.Arr ?: Json.Arr()
            items.items.forEachIndexed { index, raw ->
                val item = raw.asObject() ?: Json.Obj()
                val v = item[f.id]
                if (filled(v)) out.add(Json.Obj().also { o ->
                    o["id"] = Json.Str(f.id)
                    o["loopId"] = Json.Str(f.loopId)
                    o["loopIndex"] = Json.Num(index.toDouble())
                    o["value"] = v!!
                })
            }
        }
        return out
    }

    /** A copy of the state with every sensitive answer removed. */
    fun redact(schema: Schema, state: Json.Obj): Pair<Json.Obj, List<Json.Obj>> {
        val safe = state.deepCopy() as Json.Obj
        val withheld = mutableListOf<Json.Obj>()
        val answers = safe["answers"] as Json.Obj
        for (found in sensitiveAnswers(schema, safe)) {
            val id = found["id"]!!.asString()!!
            val loopId = found["loopId"]?.asString()
            val loopIndex = (found["loopIndex"] as? Json.Num)?.value?.toInt() ?: 0
            if (loopId != null) {
                ((answers[loopId] as? Json.Arr)?.items?.getOrNull(loopIndex) as? Json.Obj)?.entries?.remove(id)
            } else {
                answers.entries.remove(id)
            }
            withheld.add(if (loopId != null) Json.Obj().also { o ->
                o["id"] = Json.Str(id)
                o["loopId"] = Json.Str(loopId)
                o["loopIndex"] = Json.Num(loopIndex.toDouble())
            } else Json.Obj().also { o ->
                o["id"] = Json.Str(id)
            })
        }
        return safe to withheld
    }
}
