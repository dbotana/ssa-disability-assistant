package org.ssa.assistant.models.mms

import org.ssa.assistant.models.testing.MmsGolden
import org.ssa.assistant.models.testing.mmsDir
import org.ssa.assistant.models.testing.mmsGraphs
import org.ssa.assistant.models.testing.readFileBytes
import org.ssa.assistant.models.testing.runtimeName
import org.ssa.assistant.models.testing.sha256File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Every `decodeCases` entry of the golden, for each ASR graph, decoded by [CtcTokenizer] from
 * that folder's `vocab.json` and `tokenizer_config.json` (pinned by the golden's hashes), must
 * equal transformers' text exactly. The golden's per-frame ids of the 9 clips must also decode
 * to its text and collapse to its ids: that needs no model.
 */
class CtcTokenizerGoldenTest {
    @Test
    fun decodesEveryGoldenCase() {
        val decoding = MmsGolden.decoding
        // CtcTokenizer implements the pipeline's CTC rule: grouped, nothing skipped by id.
        assertEquals(false, decoding.skipSpecialTokens, "the golden's decoding skips special tokens; CtcTokenizer does not")
        assertEquals(true, decoding.groupTokens, "the golden's decoding does not group tokens; CtcTokenizer does")
        assertEquals("first index", decoding.argmaxTies)

        val dir = mmsDir()
        val graphs = mmsGraphs()
        val failures = mutableListOf<String>()
        for (key in listOf("lin", "fra", "eng")) {
            if (key !in graphs) {
                println("MMS[$runtimeName] tokenizer $key: not in MMS_GRAPHS, not run")
                continue
            }
            val graph = MmsGolden.graph(key) ?: throw AssertionError("the golden has no graphs.$key")
            val folder = "$dir/${graph.folder}"
            for (name in listOf("vocab.json", "tokenizer_config.json")) {
                val pin = graph.files[name] ?: throw AssertionError("graphs.$key.files has no $name")
                assertEquals(pin, sha256File("$folder/$name"), "$folder/$name does not match its pin")
            }
            val tokenizer = CtcTokenizer.fromJson(
                readFileBytes("$folder/vocab.json").decodeToString(),
                readFileBytes("$folder/tokenizer_config.json").decodeToString(),
            )
            assertEquals(graph.targetLang, tokenizer.targetLang, "$key target_lang")
            assertEquals(decoding.blankId, tokenizer.blankId, "$key blank id")
            assertEquals(decoding.wordDelimiterToken, tokenizer.wordDelimiterToken, "$key word delimiter")
            assertEquals(decoding.replaceWordDelimiterChar, tokenizer.replaceWordDelimiterChar, "$key delimiter replacement")
            assertEquals(decoding.cleanUpTokenizationSpaces, tokenizer.cleanUpTokenizationSpaces, "$key clean-up")
            assertEquals(graph.outputDim, tokenizer.vocabSize, "$key vocabulary size against the graph's output")

            val cases = MmsGolden.decodeCases(key)
            var casesRight = 0
            for (case in cases) {
                val actual = tokenizer.decode(case.ids)
                if (actual == case.text) {
                    casesRight++
                } else {
                    failures += "$key ${case.name}: got ${actual.debug()}, want ${case.text.debug()}"
                }
            }
            var clipsRight = 0
            for (clip in MmsGolden.clips) {
                val asr = MmsGolden.asr(key, clip.name)
                val frameIds = asr.frameIds.toIntArray()
                val text = tokenizer.decode(frameIds)
                val ids = CtcGreedy.collapse(frameIds, tokenizer.blankId).toList()
                if (text == asr.text && ids == asr.ids) {
                    clipsRight++
                } else {
                    failures += "$key ${clip.name}: the golden's frame ids decode to ${text.debug()} " +
                        "(want ${asr.text.debug()}) and collapse to $ids (want ${asr.ids})"
                }
            }
            println(
                "MMS[$runtimeName] tokenizer $key: decode cases exact: $casesRight/${cases.size}; " +
                    "golden frame ids decode to the golden text: $clipsRight/${MmsGolden.clips.size}",
            )
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }
}

private fun String.debug(): String = buildString(length + 2) {
    append('"')
    for (c in this@debug) {
        when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c.code < 0x20 || c.code in 0x7F..0x9F || c.code in 0x200B..0x200F -> {
                append("\\u")
                append(c.code.toString(16).padStart(4, '0'))
            }
            else -> append(c)
        }
    }
    append('"')
}
