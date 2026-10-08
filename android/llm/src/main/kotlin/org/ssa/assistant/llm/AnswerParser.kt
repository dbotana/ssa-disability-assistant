package org.ssa.assistant.llm

import org.ssa.assistant.core.Question

/**
 * A parsed answer with its provenance.
 *
 * The TurnController keeps provenance in a side map outside the engine state,
 * so the engine stays serializable and provenance never reaches the form.
 */
enum class Provenance { LLM, PARSE, TYPED }

data class ParsedAnswer(
    val value: Any?,
    val confidence: Double = 0.0,
    val needsClarification: Boolean = false,
    val clarifyPrompt: String? = null,
    val provenance: Provenance = Provenance.PARSE,
) {
    companion object {
        /** The deterministic fallback: parseLocal found nothing certain. */
        val NULL = ParsedAnswer(null, 0.0, needsClarification = true)
    }
}

/**
 * One interface, two backends: the deterministic parser in :core (always
 * present) and llama.cpp behind this module's native code (optional, M6).
 * Everything the LLM returns goes through the deterministic verifier before
 * it is spoken or committed.
 */
interface AnswerParser {
    suspend fun parse(question: Question, transcript: String, typed: Boolean = false): ParsedAnswer

    /** Whether the on-device model is loaded and passing its gates. */
    val available: Boolean
}

/**
 * The device gates from the plan: the LLM is enabled only when the device has
 * >= 6 GB RAM, is not a low-RAM device, has arm64 dotprod, and passes a
 * first-run benchmark. `available` defaults to false until all four hold.
 */
object LlmEligibility {
    fun eligible(totalMemoryBytes: Long, isLowRamDevice: Boolean, hasArm64Dotprod: Boolean): Boolean =
        totalMemoryBytes >= 6L * 1024 * 1024 * 1024 && !isLowRamDevice && hasArm64Dotprod
}
