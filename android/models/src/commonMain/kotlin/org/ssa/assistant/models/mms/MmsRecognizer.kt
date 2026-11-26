package org.ssa.assistant.models.mms

import org.ssa.assistant.core.model.LanguageId
import org.ssa.assistant.core.model.Transcriber

/** What [MmsRecognizer.recognize] heard, and in which language. */
data class MmsRecognition(
    /** What language ID returned: `ln`, `fr`, `en`, or null when it was unsure. */
    val detected: String?,
    /** The language whose adapter transcribed the clip: [detected], or the fallback. */
    val language: String,
    /** The raw transcript; cleaning it is `:core`'s job (`cleanTranscript()`). */
    val text: String,
)

/**
 * 4.4's two model steps for a Lingala-session answer, composed over `:core`'s ports (Decision 6):
 * language ID on the clip (the first 3 s, inside [MmsLanguageId]), then ASR with the detected
 * language's adapter. An unsure language ID (null) means [unsureLanguage], Lingala, as 4.4 says.
 *
 * Wiring this into `AppController` is out of scope for Run 9; when that happens, the fallback
 * rule moves into `:core`.
 */
class MmsRecognizer(
    private val languageId: LanguageId,
    private val transcriber: Transcriber,
    val unsureLanguage: String = "ln",
) {
    suspend fun recognize(samples: FloatArray): MmsRecognition {
        val detected = languageId.detect(samples)
        val language = detected ?: unsureLanguage
        return MmsRecognition(detected, language, transcriber.transcribe(samples, language))
    }
}
