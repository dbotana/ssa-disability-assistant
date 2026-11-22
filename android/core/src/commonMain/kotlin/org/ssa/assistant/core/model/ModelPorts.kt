package org.ssa.assistant.core.model

/**
 * Model ports: interfaces that `:models` (not present yet) will implement.
 * These are deterministic-only; the exact sample representation is finalized
 * in Step 3b.
 */
interface Transcriber {
    suspend fun transcribe(samples: FloatArray, lang: String): String
        // raw 16 kHz mono float samples → transcript text
}

interface LanguageId {
    suspend fun detect(samples: FloatArray): String?
        // best language code ("ln", "fr", "en"), or null when unsure
}

interface Translator {
    suspend fun translate(text: String, from: String, to: String): String
        // one pre-split sentence
}