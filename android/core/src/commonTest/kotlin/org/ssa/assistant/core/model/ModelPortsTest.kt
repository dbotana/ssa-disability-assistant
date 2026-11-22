package org.ssa.assistant.core.model

import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Scripted fakes for the three model interfaces.
 * Each returns fixed values; assert each is callable and returns what the fake says.
 * No golden (nothing to pin).
 */
class ModelPortsTest {

    @Test
    fun `transcriber returns transcript for given samples`() {
        val fake = object : Transcriber {
            override suspend fun transcribe(samples: FloatArray, lang: String): String =
                "test transcript"
        }
        val result = fake.transcribe(FillFactor.sampleFloatArray(), "en")
        assertTrue(result.isNotEmpty())
        assertTrue(result == "test transcript")
    }

    @Test
    fun `language_id detects language or returns null`() {
        val fake = object : LanguageId {
            override suspend fun detect(samples: FloatArray): String? = "en"
        }
        val result = fake.detect(FillFactor.sampleFloatArray())
        assertTrue(result == "en")
    }

    @Test
    fun `translator translates text`() {
        val fake = object : Translator {
            override suspend fun translate(text: String, from: String, to: String): String =
                "translated $text"
        }
        val result = fake.translate("hello", "en", "fr")
        assertTrue(result == "translated hello")
    }

    // Helper to create a sample FloatArray for tests
    object FillFactor {
        fun sampleFloatArray(): FloatArray = floatArrayOf(0.5f, 0.3f, 0.1f)
    }
}