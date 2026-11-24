package org.ssa.assistant.models.whisper

import org.ssa.assistant.models.onnx.BoolTensor
import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.LongTensor
import org.ssa.assistant.models.onnx.OnnxSession
import org.ssa.assistant.models.onnx.Tensor

/**
 * Greedy decoding of the merged Whisper decoder, with the KV cache wired the
 * way transformers.js 3.8.1 wires it (models.js:932-941, 1878, 1953-1982,
 * 2012-2027, 537-556):
 *
 * - step 1 feeds the whole prompt, `use_cache_branch = [false]` and empty pasts;
 * - later steps feed one token, `use_cache_branch = [true]`, the previous step's
 *   decoder presents and the *first* step's encoder presents;
 * - scores are the last position's logits, `begin_suppress_tokens` are `-∞`
 *   only at the first generated position, and `suppress_tokens` are not applied;
 * - the returned ids include the prompt.
 */
class WhisperDecoder(
    private val session: OnnxSession,
    private val config: WhisperConfig,
) {
    private val layers = config.decoderLayers
    private val decoderOutputNames = buildList {
        add("logits")
        for (i in 0 until layers) {
            add("present.$i.decoder.key")
            add("present.$i.decoder.value")
        }
    }

    init {
        val inputs = session.inputNames.toSet()
        val outputs = session.outputNames.toSet()
        val missing = mutableListOf<String>()
        for (name in listOf("input_ids", "encoder_hidden_states", "use_cache_branch")) {
            if (name !in inputs) missing += "input $name"
        }
        for (i in 0 until layers) {
            for (kind in listOf("decoder", "encoder")) {
                for (part in listOf("key", "value")) {
                    val name = "past_key_values.$i.$kind.$part"
                    if (name !in inputs) missing += "input $name"
                }
            }
        }
        if ("logits" !in outputs) missing += "output logits"
        for (i in 0 until layers) {
            for (kind in listOf("decoder", "encoder")) {
                for (part in listOf("key", "value")) {
                    val name = "present.$i.$kind.$part"
                    if (name !in outputs) missing += "output $name"
                }
            }
        }
        require(missing.isEmpty()) {
            "the session is missing ${missing.joinToString()}; a merged Whisper decoder is required"
        }
    }

    /**
     * Runs the greedy loop and returns the ids, prompt included. [onStep] sees
     * the sequence length before the token is appended and that step's scores.
     */
    fun generate(
        encoderHiddenStates: FloatTensor,
        onStep: ((position: Int, scores: FloatArray) -> Unit)? = null,
    ): LongArray {
        val ids = config.prompt.toMutableList()
        var past: Map<String, Tensor>? = null

        while (true) {
            val useCache = past != null
            val feeds = LinkedHashMap<String, Tensor>()
            feeds["input_ids"] = if (useCache) {
                LongTensor(longArrayOf(ids.last().toLong()), longArrayOf(1, 1))
            } else {
                LongTensor(config.prompt.map { it.toLong() }.toLongArray(), longArrayOf(1, config.prompt.size.toLong()))
            }
            feeds["encoder_hidden_states"] = encoderHiddenStates
            feeds["use_cache_branch"] = BoolTensor(booleanArrayOf(useCache), longArrayOf(1))

            if (useCache) {
                feeds.putAll(past!!)
            } else {
                for (i in 0 until layers) {
                    val headSize = config.dModel / config.decoderHeads
                    val encoderHeadSize = config.dModel / config.encoderHeads
                    feeds["past_key_values.$i.decoder.key"] = emptyPast(config.decoderHeads, headSize)
                    feeds["past_key_values.$i.decoder.value"] = emptyPast(config.decoderHeads, headSize)
                    feeds["past_key_values.$i.encoder.key"] = emptyPast(config.encoderHeads, encoderHeadSize)
                    feeds["past_key_values.$i.encoder.value"] = emptyPast(config.encoderHeads, encoderHeadSize)
                }
            }

            val requested = if (useCache) decoderOutputNames else session.outputNames
            val result = session.run(feeds, requested)
            val logits = result["logits"] as? FloatTensor
                ?: throw IllegalStateException("the decoder produced no float32 logits")
            val shape = logits.shape
            require(shape.size == 3) { "logits must be [1, sequence, vocabulary], got ${shape.contentToString()}" }
            val sequence = shape[1].toInt()
            val vocabulary = shape[2].toInt()
            require(logits.data.size == sequence * vocabulary) {
                "logits has ${logits.data.size} values for shape ${shape.contentToString()}"
            }
            val scores = logits.data.copyOfRange((sequence - 1) * vocabulary, sequence * vocabulary)
            if (ids.size == config.prompt.size) {
                for (token in config.beginSuppressTokens) {
                    if (token < vocabulary) scores[token] = Float.NEGATIVE_INFINITY
                }
            }
            onStep?.invoke(ids.size, scores)

            val next = argmaxFirst(scores)
            ids += next
            if (next == config.eosTokenId || ids.size >= config.maxLength) break

            val nextPast = LinkedHashMap<String, Tensor>()
            for (i in 0 until layers) {
                for (part in listOf("key", "value")) {
                    nextPast["past_key_values.$i.decoder.$part"] =
                        result["present.$i.decoder.$part"]
                            ?: throw IllegalStateException("the decoder produced no present.$i.decoder.$part")
                }
                for (part in listOf("key", "value")) {
                    val inputName = "past_key_values.$i.encoder.$part"
                    nextPast[inputName] = past?.get(inputName)
                        ?: result["present.$i.encoder.$part"]
                        ?: throw IllegalStateException("the decoder produced no present.$i.encoder.$part")
                }
            }
            past = nextPast
        }
        return LongArray(ids.size) { ids[it].toLong() }
    }

    private fun emptyPast(heads: Int, headSize: Int): FloatTensor =
        FloatTensor(FloatArray(0), longArrayOf(1, heads.toLong(), 0L, headSize.toLong()))
}

/**
 * The first strict maximum of [values], as transformers.js's `max()` does
 * (utils/maths.js:254-265, used by GreedySampler in generation/logits_sampler.js:124-138):
 * a tie keeps the lowest index, a NaN at index 0 wins, and a NaN later is never
 * chosen because no NaN is strictly greater than the current best.
 */
internal fun argmaxFirst(values: FloatArray): Int {
    var best = 0
    var value = values[0]
    for (i in 1 until values.size) {
        if (values[i] > value) {
            best = i
            value = values[i]
        }
    }
    return best
}
