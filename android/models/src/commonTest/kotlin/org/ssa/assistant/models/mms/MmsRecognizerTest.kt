package org.ssa.assistant.models.mms

import org.ssa.assistant.core.model.LanguageId
import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.models.testing.runBlockingTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

class MmsRecognizerTest {
    private class FakeLanguageId(private val answer: String?) : LanguageId {
        val seen = mutableListOf<FloatArray>()
        override suspend fun detect(samples: FloatArray): String? {
            seen += samples
            return answer
        }
    }

    private class FakeTranscriber : Transcriber {
        val calls = mutableListOf<Pair<FloatArray, String>>()
        override suspend fun transcribe(samples: FloatArray, lang: String): String {
            calls += samples to lang
            return "heard in $lang"
        }
    }

    @Test
    fun usesTheDetectedLanguage() {
        val languageId = FakeLanguageId("fr")
        val transcriber = FakeTranscriber()
        val clip = FloatArray(16_000)
        var result: MmsRecognition? = null
        runBlockingTest { result = MmsRecognizer(languageId, transcriber).recognize(clip) }
        assertEquals(MmsRecognition(detected = "fr", language = "fr", text = "heard in fr"), result)
        assertSame(clip, languageId.seen.single())
        assertSame(clip, transcriber.calls.single().first)
        assertEquals("fr", transcriber.calls.single().second)
    }

    @Test
    fun anUnsureLanguageIdMeansLingala() {
        val transcriber = FakeTranscriber()
        var result: MmsRecognition? = null
        runBlockingTest { result = MmsRecognizer(FakeLanguageId(null), transcriber).recognize(FloatArray(8_000)) }
        assertEquals(MmsRecognition(detected = null, language = "ln", text = "heard in ln"), result)
        assertEquals(listOf("ln"), transcriber.calls.map { it.second })
    }

    @Test
    fun theFallbackCanBeChanged() {
        val transcriber = FakeTranscriber()
        var result: MmsRecognition? = null
        runBlockingTest {
            result = MmsRecognizer(FakeLanguageId(null), transcriber, unsureLanguage = "fr").recognize(FloatArray(8_000))
        }
        assertEquals("fr", result?.language)
        assertEquals(null, result?.detected)
    }
}
