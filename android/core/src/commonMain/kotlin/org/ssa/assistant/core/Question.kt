package org.ssa.assistant.core

/**
 * The question to ask right now, as `engine.current()` returns it.
 *
 * Mirrors the shape produced by `buildCurrent()` in src/engine.js: a plain
 * question, a loop entry prompt, or a loop field. `path` is a stable identity
 * for the pacing clock.
 */
data class Question(
    val id: String,
    val prompt: String,
    val type: String,
    val required: Boolean = false,
    val confirm: Boolean = false,
    val warn: String? = null,
    val hint: String? = null,
    val options: List<Option>? = null,
    val allowFuture: Boolean = false,
    /** money/number: the period the answer is in, or "any" (see schema.js). */
    val per: String? = null,
    /** number: "year" for a question asking for a year. */
    val kind: String? = null,
    val section: String? = null,
    val sectionTitle: String? = null,
    val loopId: String? = null,
    val loopPhase: String? = null,
    val itemLabel: String? = null,
    val itemNumber: Int? = null,
    /**
     * Strings and Ints, as JS has them: `[nodeId]`, `[loopId, 'entry', n]`,
     * `[loopId, n, fieldId]`.
     */
    val path: List<Any> = emptyList(),
)

/** One entry of a choice question's option list. */
data class Option(
    val value: String,
    val label: String,
    val letter: String? = null,
    val aliases: List<String> = emptyList(),
    val impliedBy: List<String>? = null,
)
