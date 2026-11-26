package org.ssa.assistant.models.mms

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/**
 * MMS's character vocabulary, decoding side only, exactly as transformers 4.53.3's
 * `Wav2Vec2CTCTokenizer` decodes for the ASR pipeline's CTC path (Decision 3).
 *
 * The pipeline (pipelines/automatic_speech_recognition.py) is of type `"ctc"` (:209-210) for a
 * `Wav2Vec2ForCTC` without a language-model decoder, takes `logits.argmax(dim=-1)` (:542, see
 * [CtcGreedy.argmax]) and calls `tokenizer.decode(items, skip_special_tokens=False)`: :619 sets
 * `skip_special_tokens = self.type != "ctc"`. So nothing is skipped by id, and `<s>`, `</s>` and
 * `<unk>` stay in the text. models/wav2vec2/tokenization_wav2vec2.py then:
 *  1. :418 `convert_ids_to_tokens` (tokenization_utils.py:1063-1072): each id's token through
 *     `_convert_id_to_token` (:280-283), `<unk>` for an id the vocabulary does not have. The
 *     added tokens (`<pad>`, `<s>`, `</s>`, `<unk>`, and every multi-character token,
 *     :192-196) sit at their vocabulary ids, so they decode the same; [fromJson] refuses a
 *     `tokenizer_config.json` whose added tokens disagree with the vocabulary;
 *  2. :420-426 skips nothing when `skip_special_tokens` is false;
 *  3. :298-300 `groupby`: runs of equal *token strings* merge (so an unknown id next to `<unk>`
 *     merges with it), before
 *  4. :305-306 the blank, the pad token's string, is dropped;
 *  5. :308-311 the word delimiter `|` becomes `replace_word_delimiter_char` (a space);
 *  6. :339-341 the pieces are joined with "" and `str.strip()`ped (Python's whitespace set,
 *     [isPythonWhitespace]);
 *  7. :438-444 `clean_up_tokenization` (tokenization_utils_base.py:3889-3911) when
 *     `clean_up_tokenization_spaces` is true (tokenization_utils_base.py:1426: false when the
 *     config does not say).
 *
 * `do_lower_case` (:343-344) is refused: Python's `str.lower()` is not ported.
 */
class CtcTokenizer private constructor(
    /** `target_lang` from `tokenizer_config.json`; null for a flat (single-language) vocabulary. */
    val targetLang: String?,
    private val idToToken: Map<Int, String>,
    val padToken: String,
    val unkToken: String,
    val wordDelimiterToken: String,
    val replaceWordDelimiterChar: String,
    val cleanUpTokenizationSpaces: Boolean,
    /** The CTC blank: the pad token's id in the vocabulary. */
    val blankId: Int,
) {
    /** `len(self.decoder)` (tokenization_wav2vec2.py:247-249): the number of ids in the vocabulary. */
    val vocabSize: Int get() = idToToken.size

    /** The token for [id], `<unk>` when the vocabulary does not have it (tokenization_wav2vec2.py:280-283). */
    fun token(id: Int): String = idToToken[id] ?: unkToken

    /** Decodes per-frame argmax ids (or any id list) the way the pipeline's CTC path does. */
    fun decode(frameIds: IntArray): String {
        if (frameIds.isEmpty()) return ""
        val out = StringBuilder()
        var previous: String? = null
        for (id in frameIds) {
            val token = token(id)
            // groupby on the token strings, then drop the blank, then replace the delimiter.
            if (token == previous) continue
            previous = token
            if (token == padToken) continue
            out.append(if (token == wordDelimiterToken) replaceWordDelimiterChar else token)
        }
        val text = pythonStrip(out.toString())
        return if (cleanUpTokenizationSpaces) cleanUpTokenization(text) else text
    }

    fun decode(frameIds: List<Int>): String = decode(frameIds.toIntArray())

    companion object {
        /**
         * Reads `vocab.json` (for MMS, `{"<lang>": {"<token>": id}}` for 1,198 languages) and
         * `tokenizer_config.json`, and keeps `vocab[target_lang]` (tokenization_wav2vec2.py:171-178).
         */
        fun fromJson(vocabJson: String, tokenizerConfigJson: String): CtcTokenizer {
            val config = JsonParser.parse(tokenizerConfigJson).asObject()
                ?: throw IllegalArgumentException("tokenizer_config.json is not a JSON object")
            val tokenizerClass = config["tokenizer_class"]?.asString()
            if (tokenizerClass != null && tokenizerClass != "Wav2Vec2CTCTokenizer") {
                throw IllegalArgumentException(
                    "tokenizer_config.json has tokenizer_class $tokenizerClass, not Wav2Vec2CTCTokenizer",
                )
            }
            if (config["do_lower_case"]?.asBoolean() == true) {
                throw UnsupportedOperationException(
                    "tokenizer_config.json sets do_lower_case; Python's str.lower() is not ported",
                )
            }

            // The defaults are Wav2Vec2CTCTokenizer.__init__'s (tokenization_wav2vec2.py:149-160).
            val padToken = tokenString(config, "pad_token") ?: "<pad>"
            val unkToken = tokenString(config, "unk_token") ?: "<unk>"
            val wordDelimiter = tokenString(config, "word_delimiter_token") ?: "|"
            val replaceChar = when (val value = config["replace_word_delimiter_char"]) {
                null -> " "
                else -> value.asString()
                    ?: throw IllegalArgumentException("tokenizer_config.json's replace_word_delimiter_char is not a string")
            }
            val cleanUp = when (val value = config["clean_up_tokenization_spaces"]) {
                null, Json.Null -> false
                else -> value.asBoolean()
                    ?: throw IllegalArgumentException("tokenizer_config.json's clean_up_tokenization_spaces is not a boolean")
            }
            val targetLang = when (val value = config["target_lang"]) {
                null, Json.Null -> null
                else -> value.asString()
                    ?: throw IllegalArgumentException("tokenizer_config.json's target_lang is not a string")
            }

            val root = JsonParser.parse(vocabJson).asObject()
                ?: throw IllegalArgumentException("vocab.json is not a JSON object")
            val encoder = if (targetLang != null) {
                root[targetLang]?.asObject()
                    ?: throw IllegalArgumentException("vocab.json has no vocabulary for target_lang $targetLang")
            } else {
                root
            }

            // self.decoder = {v: k for k, v in self.encoder.items()}: a later token wins an id.
            val tokenToId = LinkedHashMap<String, Int>(encoder.entries.size)
            val idToToken = LinkedHashMap<Int, String>(encoder.entries.size)
            for ((token, idJson) in encoder.entries) {
                val number = idJson.asDouble()
                    ?: throw IllegalArgumentException("vocab.json's id for ${'"'}$token${'"'} is not a number")
                require(number == number.toInt().toDouble()) {
                    "vocab.json's id for ${'"'}$token${'"'} is not an integer: $number"
                }
                tokenToId[token] = number.toInt()
                idToToken[number.toInt()] = token
            }

            when (val added = config["added_tokens_decoder"]) {
                null, Json.Null -> {}
                is Json.Obj -> for ((idText, entry) in added.entries) {
                    val id = idText.toIntOrNull()
                        ?: throw IllegalArgumentException("tokenizer_config.json's added_tokens_decoder key $idText is not an id")
                    val content = entry.asObject()?.get("content")?.asString()
                        ?: throw IllegalArgumentException("tokenizer_config.json's added token $id has no content")
                    if (idToToken[id] != content || tokenToId[content] != id) {
                        throw UnsupportedOperationException(
                            "tokenizer_config.json's added token ${'"'}$content${'"'} at id $id is not the " +
                                "vocabulary's token at that id (${idToToken[id]}); only added tokens that " +
                                "agree with vocab.json are supported",
                        )
                    }
                }
                else -> throw IllegalArgumentException("tokenizer_config.json's added_tokens_decoder is not an object")
            }

            val blankId = tokenToId[padToken]
                ?: throw IllegalArgumentException("the vocabulary has no pad token $padToken, the CTC blank")
            return CtcTokenizer(
                targetLang = targetLang,
                idToToken = idToToken,
                padToken = padToken,
                unkToken = unkToken,
                wordDelimiterToken = wordDelimiter,
                replaceWordDelimiterChar = replaceChar,
                cleanUpTokenizationSpaces = cleanUp,
                blankId = blankId,
            )
        }

        /** A special token given as a string, or as an AddedToken object with `content`. */
        private fun tokenString(config: Json.Obj, key: String): String? = when (val value = config[key]) {
            null, Json.Null -> null
            is Json.Str -> value.value
            is Json.Obj -> value["content"]?.asString()
                ?: throw IllegalArgumentException("tokenizer_config.json's $key has no content")
            else -> throw IllegalArgumentException("tokenizer_config.json's $key is not a string")
        }
    }
}

/** tokenization_utils_base.py:3889-3911, the same replacements in the same order. */
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

/** Python 3.11's `str.strip()` with no argument: both ends, [isPythonWhitespace] characters. */
internal fun pythonStrip(text: String): String {
    var start = 0
    var end = text.length
    while (start < end && isPythonWhitespace(text[start])) start++
    while (end > start && isPythonWhitespace(text[end - 1])) end--
    return text.substring(start, end)
}

/**
 * `str.isspace()` in the export venv's Python 3.11.0, listed there with
 * `[hex(c) for c in range(0x110000) if chr(c).isspace()]`: all of them are in the BMP. Kotlin's
 * `isWhitespace()` follows the platform's own definition, not Python's, so the list is spelled out.
 */
internal fun isPythonWhitespace(c: Char): Boolean = when (c.code) {
    in 0x09..0x0D, in 0x1C..0x1F, 0x20, 0x85, 0xA0, 0x1680, in 0x2000..0x200A,
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000 -> true
    else -> false
}
