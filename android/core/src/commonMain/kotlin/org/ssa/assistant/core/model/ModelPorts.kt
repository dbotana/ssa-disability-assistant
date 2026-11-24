package org.ssa.assistant.core.model

/**
 * Model ports. `:models` implements them, with `WhisperTranscriber` first;
 * its tests use scripted fake sessions for the ONNX boundary. These are
 * deterministic-only, and the exact sample representation is pinned by
 * Run 8, Decision 6.
 */
interface Transcriber {
    /**
     * Transcribes 16 kHz mono float samples in [−1, 1], read as
     * `tools/stt-eval.mjs` reads the fixture WAVs (Run 8, Decision 6).
     * Returns raw text; callers clean it with `cleanTranscript()`. Whisper
     * rejects more than 30 s (480,000 samples) for now.
     */
    suspend fun transcribe(samples: FloatArray, lang: String): String
}

interface LanguageId {
    suspend fun detect(samples: FloatArray): String?
        // best language code ("ln", "fr", "en"), or null when unsure
}

interface Translator {
    suspend fun translate(text: String, from: String, to: String): String
        // one pre-split sentence
}
