package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotSame
import kotlin.test.assertTrue
import org.ssa.assistant.core.app.BufferedStt
import org.ssa.assistant.core.app.CaptureBuffer
import org.ssa.assistant.core.app.CaptureException
import org.ssa.assistant.core.golden.runTestBlocking
import org.ssa.assistant.core.model.Transcriber
import org.ssa.assistant.core.turn.TurnController

/**
 * Plan A5: the audio adapter's samples reach the transcriber, and an over-long
 * or empty capture is refused before it does.
 */
class CaptureBufferTest {

    private class Scripted(private val text: String) : Transcriber {
        var seen: FloatArray? = null
        var lang: String? = null
        override suspend fun transcribe(samples: FloatArray, lang: String): String {
            seen = samples
            this.lang = lang
            return text
        }
    }

    @Test
    fun thePlatformWritesAndTheSttPortReads() = runTestBlocking {
        val buffer = CaptureBuffer()
        val transcriber = Scripted("hello")
        val stt: TurnController.SttPort = BufferedStt(buffer, transcriber)
        buffer.put(FloatArray(16_000) { 0.1f }, hadSpeech = true, peak = 0.3)
        assertEquals("hello", stt.transcribe(TurnController.Blob(1000, null)))
        assertEquals(16_000, transcriber.seen!!.size)
        assertEquals("en", transcriber.lang)
        assertEquals(1000, buffer.durationMs)
    }

    @Test
    fun anEmptyCaptureIsRefused() = runTestBlocking {
        val error = assertFailsWith<CaptureException> {
            CaptureBuffer().transcribe(Scripted("x"), "en")
        }
        assertEquals("empty", error.kind)
    }

    @Test
    fun theSttPortTurnsFailuresIntoSttErrors() = runTestBlocking {
        // The turn loop only catches SttError; anything else would escape to
        // the UI's coroutine.
        val empty = assertFailsWith<TurnController.SttError> {
            BufferedStt(CaptureBuffer(), Scripted("x")).transcribe(TurnController.Blob(0, null))
        }
        assertEquals("empty", empty.kind)

        val buffer = CaptureBuffer()
        buffer.put(FloatArray(buffer.maxSamples + 1) { 0f }, hadSpeech = true, peak = 0.1)
        val tooLong = assertFailsWith<TurnController.SttError> {
            BufferedStt(buffer, Scripted("x")).transcribe(TurnController.Blob(1, null))
        }
        assertEquals("unknown", tooLong.kind)

        val failing = object : Transcriber {
            override suspend fun transcribe(samples: FloatArray, lang: String): String =
                throw IllegalStateException("the model did not load")
        }
        buffer.put(FloatArray(16_000) { 0f }, hadSpeech = true, peak = 0.1)
        val broken = assertFailsWith<TurnController.SttError> {
            BufferedStt(buffer, failing).transcribe(TurnController.Blob(1, null))
        }
        assertEquals("unknown", broken.kind)
        assertEquals("unknown", broken.message)
    }

    @Test
    fun thirtySecondsIsAllowedAndOneSampleMoreIsRefused() = runTestBlocking {
        val buffer = CaptureBuffer()
        val transcriber = Scripted("ok")
        buffer.put(FloatArray(buffer.maxSamples) { 0f }, hadSpeech = true, peak = 0.1)
        assertEquals("ok", buffer.transcribe(transcriber))

        buffer.put(FloatArray(buffer.maxSamples + 1) { 0f }, hadSpeech = true, peak = 0.1)
        val error = assertFailsWith<CaptureException> { buffer.transcribe(transcriber) }
        assertEquals("too_long", error.kind)
        assertEquals(480_000, CaptureBuffer().maxSamples)
    }

    @Test
    fun theBufferCopiesTheAdaptersArray() {
        val buffer = CaptureBuffer()
        val samples = floatArrayOf(0.5f, -0.5f)
        buffer.put(samples, hadSpeech = true, peak = 0.5)
        samples[0] = 0f
        assertEquals(0.5f, buffer.take()[0], "the adapter may reuse its conversion buffer")
        assertNotSame(samples, buffer.take())
        buffer.clear()
        assertEquals(0, buffer.size)
        assertTrue(buffer.take().isEmpty())
    }
}
