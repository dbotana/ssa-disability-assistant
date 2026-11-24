package org.ssa.assistant.models.whisper

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/**
 * Whisper's byte-level BPE tokenizer, decoding side only: the model returns
 * token ids, and this turns them into text exactly as transformers.js 3.8.1's
 * `decode_single` does (tokenizers.js:3145-3176).
 *
 * Decoding is:
 *  1. drop tokens whose text is in [specialTokens] (when skipping them);
 *  2. the ByteLevel `decode_chain` (tokenizers.js:2108-2171): each added
 *     token's content is emitted verbatim and splits the text, runs of other
 *     tokens are joined, each code point mapped to a byte by GPT-2's byte map
 *     (an unknown code point gives byte 0, a null token gives ""), and the
 *     bytes decoded as UTF-8 with U+FFFD replacement;
 *  3. [cleanUpTokenizationSpaces]'s `clean_up_tokenization` (tokenizers.js:178-191).
 *
 * Encoded text is never needed on the device, so there is no encoder.
 */
class WhisperTokenizer private constructor(
    private val idToToken: Array<String?>,
    private val addedContents: Set<String>,
    private val specialTokens: Set<String>,
    val cleanUpTokenizationSpaces: Boolean,
    /** The ids of the added tokens marked `special: true`, sorted. */
    val specialIds: List<Int>,
    /** The ids of [specialTokens]' contents, sorted: what `decode` skips. */
    val skippedIds: List<Int>,
) {
    fun decode(ids: LongArray, skipSpecialTokens: Boolean = true): String =
        decode(ids.map { it.toInt() }, skipSpecialTokens)

    fun decode(ids: List<Int>, skipSpecialTokens: Boolean = true): String {
        require(ids.isNotEmpty()) { "decode needs at least one token id" }

        // tokenizers.js:434-435: vocab[id] ?? null.
        val tokens = ids.map { idToToken.getOrNull(it) }
        // tokenizers.js:3153-3155: drop the special tokens' *texts* when skipping.
        val kept = if (skipSpecialTokens) tokens.filter { it == null || it !in specialTokens } else tokens

        val out = StringBuilder()
        val run = StringBuilder()

        fun flushRun() {
            if (run.isEmpty()) return
            val text = run.toString()
            run.setLength(0)
            // tokenizers.js:2131-2136: [...text].map(c => byte_decoder[c]) — one
            // byte per code point, 0 for a code point the map does not have.
            val bytes = ByteArray(text.codePointCountApprox()) { 0 }
            var n = 0
            var i = 0
            while (i < text.length) {
                val c = text[i]
                val codePoint: Int
                if (c.isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()) {
                    codePoint = 0x10000 + ((c.code - 0xD800) shl 10) + (text[i + 1].code - 0xDC00)
                    i += 2
                } else {
                    codePoint = c.code
                    i++
                }
                bytes[n++] = (GPT2_UNICODE_TO_BYTE[codePoint] ?: 0).toByte()
            }
            out.append(decodeUtf8Whatwg(if (n == bytes.size) bytes else bytes.copyOf(n)))
        }

        // tokenizers.js:2138-2166: added tokens split the text; the rest is one
        // byte-level run.
        for (token in kept) {
            if (token != null && token in addedContents) {
                flushRun()
                out.append(token)
            } else {
                run.append(token ?: "")
            }
        }
        flushRun()

        return if (cleanUpTokenizationSpaces) cleanUpTokenization(out.toString()) else out.toString()
    }

    companion object {
        /** Reads tokenizer.json and tokenizer_config.json (Decision 10's rejections included). */
        fun fromJson(tokenizerJson: String, tokenizerConfigJson: String): WhisperTokenizer {
            val root = JsonParser.parse(tokenizerJson).asObject()
                ?: throw IllegalArgumentException("tokenizer.json is not a JSON object")
            val config = JsonParser.parse(tokenizerConfigJson).asObject()
                ?: throw IllegalArgumentException("tokenizer_config.json is not a JSON object")

            val model = root["model"]?.asObject()
                ?: throw IllegalArgumentException("tokenizer.json has no model")
            if (model["type"]?.asString() != "BPE") {
                throw UnsupportedOperationException(
                    "tokenizer.json's model type is ${model["type"]?.asString()}, not BPE",
                )
            }
            val decoder = root["decoder"]?.asObject()
                ?: throw IllegalArgumentException("tokenizer.json has no decoder")
            if (decoder["type"]?.asString() != "ByteLevel") {
                throw UnsupportedOperationException(
                    "tokenizer.json's decoder is ${decoder["type"]?.asString()}, not ByteLevel",
                )
            }
            val suffix = model["end_of_word_suffix"]
            val endOfWord = when (suffix) {
                null, Json.Null -> null
                is Json.Str -> suffix.value
                else -> throw UnsupportedOperationException("tokenizer.json's end_of_word_suffix is not a string")
            }
            if (!endOfWord.isNullOrEmpty()) {
                throw UnsupportedOperationException(
                    "tokenizer.json's end_of_word_suffix is ${'"'}$endOfWord${'"'}; only \"\" is supported",
                )
            }

            val vocab = model["vocab"]?.asObject()
                ?: throw IllegalArgumentException("tokenizer.json has no model.vocab")
            val vocabIds = HashMap<String, Int>(vocab.entries.size)
            var maxId = -1
            for ((token, idJson) in vocab.entries) {
                val id = idJson.asDouble()?.toInt()
                    ?: throw IllegalArgumentException("tokenizer.json's model.vocab has a non-numeric id for $token")
                vocabIds[token] = id
                if (id > maxId) maxId = id
            }

            val addedTokens = root["added_tokens"]?.asArray()?.items.orEmpty().map { entry ->
                val object_ = entry.asObject()
                    ?: throw IllegalArgumentException("tokenizer.json's added_tokens holds a non-object")
                AddedToken(
                    id = object_["id"]?.asDouble()?.toInt()
                        ?: throw IllegalArgumentException("an added token has no numeric id"),
                    content = object_["content"]?.asString()
                        ?: throw IllegalArgumentException("an added token has no content"),
                    special = object_["special"]?.asBoolean() == true,
                )
            }
            for (added in addedTokens) if (added.id > maxId) maxId = added.id

            // Every added token overrides its id (tokenizers.js:2613-2616).
            val idToToken = arrayOfNulls<String>(maxId + 1)
            for ((token, id) in vocabIds) idToToken[id] = token
            for (added in addedTokens) idToToken[added.id] = added.content
            val addedContents = addedTokens.mapTo(LinkedHashSet()) { it.content }

            val specialIds = addedTokens.filter { it.special }.map { it.id }.distinct().sorted()

            // tokenizers.js:2618-2623: the special added tokens plus the config's
            // additional_special_tokens, deduped.
            val specialTokens = LinkedHashSet<String>()
            addedTokens.filter { it.special }.forEach { specialTokens += it.content }
            when (val additional = config["additional_special_tokens"]) {
                null, Json.Null -> {}
                is Json.Arr -> for (item in additional.items) {
                    specialTokens += item.asString()
                        ?: throw IllegalArgumentException("additional_special_tokens must hold strings")
                }
                else -> throw IllegalArgumentException("additional_special_tokens is not an array")
            }

            // An added token's id wins; otherwise the vocabulary's.
            val addedById = addedTokens.associate { it.content to it.id }
            val skippedIds = specialTokens.map { token ->
                addedById[token] ?: vocabIds[token]
                ?: throw IllegalStateException("the tokenizer has no id for the special token $token")
            }.sorted().distinct()

            val cleanUp = config["clean_up_tokenization_spaces"]?.asBoolean() ?: true
            return WhisperTokenizer(idToToken, addedContents, specialTokens, cleanUp, specialIds, skippedIds)
        }
    }
}

private class AddedToken(val id: Int, val content: String, val special: Boolean)

/** tokenizers.js:178-191, the same replacements in the same order. */
internal fun cleanUpTokenization(text: String): String = text
    .replace(" .", ".")
    .replace(" ?", "?")
    .replace(" !", "!")
    .replace(" ,", ",")
    .replace(" ' ", "'")
    .replace(" n't", "n't")
    .replace(" 'm", "'m")
    .replace(" 's", "'s")
    .replace(" 've", "'ve")
    .replace(" 're", "'re")

private fun String.codePointCountApprox(): Int = length

/**
 * GPT-2's byte encoder: bytes 0x21..0x7E, 0xA1..0xAC and 0xAE..0xFF map to the
 * characters with the same code; every other byte, in increasing order, maps to
 * 256 + n. So byte 0x20 is 'Ġ' (U+0120) and 0x0A is 'Ċ' (U+010A), exactly as
 * tools/golden/models.mjs's `byteChars` builds it.
 */
internal val GPT2_BYTE_CHARS: CharArray = run {
    val printable = ArrayList<Int>()
    for (b in 0x21..0x7E) printable += b
    for (b in 0xA1..0xAC) printable += b
    for (b in 0xAE..0xFF) printable += b
    val printableSet = printable.toHashSet()
    val extraBytes = ArrayList<Int>()
    for (b in 0..255) if (b !in printableSet) extraBytes += b

    val map = CharArray(256)
    printable.forEach { map[it] = it.toChar() }
    extraBytes.forEachIndexed { index, byte -> map[byte] = (256 + index).toChar() }
    map
}

/** The inverse of [GPT2_BYTE_CHARS]: a code point to the byte it stands for. */
internal val GPT2_UNICODE_TO_BYTE: Map<Int, Int> = buildMap {
    GPT2_BYTE_CHARS.forEachIndexed { byte, char -> put(char.code, byte) }
}
