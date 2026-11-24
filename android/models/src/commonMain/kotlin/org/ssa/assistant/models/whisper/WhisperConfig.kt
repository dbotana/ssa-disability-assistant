package org.ssa.assistant.models.whisper

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject

/**
 * The decoding facts read from `config.json` and `generation_config.json`.
 *
 * transformers.js 3.8.1's Whisper pipeline uses `generation_config.json` for the
 * prompt, the stop token and the begin-suppress list (models.js:3406-3457,
 * 1421-1427), and `config.json` for the merged decoder's shapes (configs.js:305-330).
 */
data class WhisperConfig(
    val prompt: List<Int>,
    val eosTokenId: Int,
    val maxLength: Int,
    val beginSuppressTokens: List<Int>,
    val decoderLayers: Int,
    val decoderHeads: Int,
    val encoderHeads: Int,
    val dModel: Int,
) {
    companion object {
        /** Reads the two model configs. A multilingual model is out of scope (Decision 10). */
        fun fromJson(configJson: String, generationConfigJson: String): WhisperConfig {
            val generation = JsonParser.parse(generationConfigJson).asObject()
                ?: throw IllegalArgumentException("generation_config.json is not a JSON object")
            val config = JsonParser.parse(configJson).asObject()
                ?: throw IllegalArgumentException("config.json is not a JSON object")

            fun int(root: Json.Obj, key: String, file: String): Int =
                root[key]?.asDouble()?.toInt()
                    ?: throw IllegalArgumentException("$file has no numeric $key")

            if (generation["is_multilingual"]?.asBoolean() == true) {
                throw UnsupportedOperationException(
                    "generation_config.json pins is_multilingual=true; only the English-only base.en model is supported",
                )
            }
            val prompt = mutableListOf(int(generation, "decoder_start_token_id", "generation_config.json"))
            val noTimestamps = generation["no_timestamps_token_id"]?.asDouble()?.toInt()
            if (generation["return_timestamps"]?.asBoolean() != true && noTimestamps != null &&
                noTimestamps != prompt.last()
            ) {
                prompt += noTimestamps
            }

            val beginSuppress = when (val entry = generation["begin_suppress_tokens"]) {
                null, Json.Null -> emptyList()
                is Json.Arr -> entry.items.map {
                    it.asDouble()?.toInt()
                        ?: throw IllegalArgumentException("begin_suppress_tokens holds a non-number")
                }
                else -> throw IllegalArgumentException("begin_suppress_tokens is not an array")
            }

            return WhisperConfig(
                prompt = prompt,
                eosTokenId = int(generation, "eos_token_id", "generation_config.json"),
                maxLength = int(generation, "max_length", "generation_config.json"),
                beginSuppressTokens = beginSuppress,
                decoderLayers = int(config, "decoder_layers", "config.json"),
                decoderHeads = int(config, "decoder_attention_heads", "config.json"),
                encoderHeads = int(config, "encoder_attention_heads", "config.json"),
                dModel = int(config, "d_model", "config.json"),
            )
        }
    }
}
