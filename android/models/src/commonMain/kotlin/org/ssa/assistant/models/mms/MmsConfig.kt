package org.ssa.assistant.models.mms

import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/** The few facts the MMS code reads from a graph's `config.json`. */
object MmsConfig {
    /**
     * `id2label` of an audio-classification config (mms-lid-126: `{"0": "ara", ...}`), as a list
     * in id order. The ids must be exactly 0 until the number of labels.
     */
    fun labels(configJson: String): List<String> {
        val root = JsonParser.parse(configJson).asObject()
            ?: throw IllegalArgumentException("config.json is not a JSON object")
        val id2label = root["id2label"]?.asObject()
            ?: throw IllegalArgumentException("config.json has no id2label object")
        val byId = HashMap<Int, String>(id2label.entries.size)
        for ((key, value) in id2label.entries) {
            val id = key.toIntOrNull() ?: throw IllegalArgumentException("config.json's id2label key $key is not an id")
            byId[id] = value.asString()
                ?: throw IllegalArgumentException("config.json's id2label[$key] is not a string")
        }
        return List(byId.size) { id ->
            byId[id] ?: throw IllegalArgumentException("config.json's id2label has no label for id $id")
        }
    }

    /** `vocab_size`, the size of a CTC graph's output. */
    fun vocabSize(configJson: String): Int {
        val root = JsonParser.parse(configJson).asObject()
            ?: throw IllegalArgumentException("config.json is not a JSON object")
        val value = root["vocab_size"]?.asDouble()
            ?: throw IllegalArgumentException("config.json has no numeric vocab_size")
        require(value == value.toInt().toDouble() && value > 0) { "config.json's vocab_size is not a positive integer: $value" }
        return value.toInt()
    }
}
