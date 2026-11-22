package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/**
 * The `speech` golden: src/speech-normalize.js over every Lingala string the
 * app may speak, with Lingala and French number words. The Kotlin
 * normalizer must give the same text and the same segments, and none of it
 * may hold a symbol outside Simba-TTS-lin's vocabulary or a digit.
 */
class SpeechNormalizerGoldenTest {
    private val golden = Golden.load("speech").asObject()!!

    private fun strings(key: String) = golden[key]!!.asArray()!!.items.map { it.asString()!! }

    @Test
    fun theVocabularyAndTheDataMatch() {
        assertEquals(strings("symbols"), SpeechNormalizer.SIMBA_SYMBOLS)
        assertEquals(39, SpeechNormalizer.SIMBA_SYMBOLS.size)
        assertEquals(golden["defaultNumberLanguage"]!!.asString(), SpeechNormalizer.DEFAULT_NUMBER_LANGUAGE)
        val words = golden["numberWords"]!!.asObject()!!
        assertEquals(words.entries.keys, SpeechNormalizer.NUMBER_WORDS.keys)
        for ((lang, list) in words.entries) {
            assertEquals(list.asArray()!!.items.map { it.asString()!! }, SpeechNormalizer.NUMBER_WORDS[lang], "number words $lang")
        }
        val respell = golden["respell"]!!.asObject()!!.entries.mapValues { it.value.asString()!! }
        assertEquals(respell, SpeechNormalizer.RESPELL)
    }

    @Test
    fun everyCaseNormalizesAsInJs() {
        val cases = golden["cases"]!!.asArray()!!.items.map { it.asObject()!! }
        assertTrue(cases.size > 1400, "the golden looks truncated: ${cases.size} cases")
        val wrong = mutableListOf<String>()
        for (c in cases) {
            val text = c["text"]!!.asString()!!
            val lang = c["numberLanguage"]!!.asString()!!
            val normalized = SpeechNormalizer.normalizeForSpeech(text, lang)
            val segments = SpeechNormalizer.speechSegments(text, numberLanguage = lang)
            if (normalized != c["normalized"]!!.asString()) wrong.add("$lang ${text.take(60)} -> $normalized")
            if (segments != c["segments"]!!.asArray()!!.items.map { it.asString()!! }) wrong.add("$lang segments ${text.take(60)}")
            for (out in listOf(normalized) + segments) {
                if (SpeechNormalizer.unknownSymbols(out).isNotEmpty() || out.any { it in '0'..'9' }) wrong.add("unspeakable: $out")
            }
        }
        assertEquals(emptyList<String>(), wrong.take(10), "${wrong.size} case(s) differ from the JS reference")
    }

    @Test
    fun longTextIsCutAtWordGapsAsInJs() {
        for (c in golden["split"]!!.asArray()!!.items.map { it.asObject()!! }) {
            val max = (c["maxLength"] as org.ssa.assistant.core.json.Json.Num).value.toInt()
            assertEquals(
                c["segments"]!!.asArray()!!.items.map { it.asString()!! },
                SpeechNormalizer.speechSegments(c["text"]!!.asString(), maxLength = max),
                "maxLength $max",
            )
        }
    }

    @Test
    fun theNumberLanguageIsTheCallersChoice() {
        assertEquals("neuf huit sept", SpeechNormalizer.normalizeForSpeech("987", "fr"))
        assertEquals("libwa mwambe nsambo", SpeechNormalizer.normalizeForSpeech("987"))
        assertEquals("o'brien-di ks", SpeechNormalizer.normalizeForSpeech("O’Brien—Dix"))
        assertEquals("naʼyo", SpeechNormalizer.normalizeForSpeech("naʼyo"))
        assertEquals(listOf("ɛ"), SpeechNormalizer.unknownSymbols("ɛa"))
    }
}
