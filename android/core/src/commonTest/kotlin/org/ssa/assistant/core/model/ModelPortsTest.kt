package org.ssa.assistant.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import org.ssa.assistant.core.golden.runTestBlocking

/**
 * Scripted fakes for the three model interfaces.
 * Each returns fixed values; assert each is callable and returns what the fake says.
 * No golden (nothing to pin).
 */
class ModelPortsTest {

    @Test
    fun transcriberReturnsTranscript() = runTestBlocking {
        val fake = object : Transcriber {
            override suspend fun transcribe(samples: FloatArray, lang: String): String =
                "test transcript"
        }
        assertEquals("test transcript", fake.transcribe(sampleFloatArray(), "en"))
    }

    @Test
    fun languageIdDetectsLanguage() = runTestBlocking {
        val fake = object : LanguageId {
            override suspend fun detect(samples: FloatArray): String? = "en"
        }
        assertEquals("en", fake.detect(sampleFloatArray()))
    }

    @Test
    fun translatorTranslatesText() = runTestBlocking {
        val fake = object : Translator {
            override suspend fun translate(text: String, from: String, to: String): String =
                "translated $text"
        }
        assertEquals("translated hello", fake.translate("hello", "en", "fr"))
    }

    private fun sampleFloatArray(): FloatArray = floatArrayOf(0.5f, 0.3f, 0.1f)
}
