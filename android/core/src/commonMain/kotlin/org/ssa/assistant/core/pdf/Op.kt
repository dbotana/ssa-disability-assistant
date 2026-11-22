package org.ssa.assistant.core.pdf

/**
 * A draw operation recorded by AddendumLayout, pinned by goldens.
 * Mirrors the android/pdf Op class so the core self-check can compare
 * PDF content-stream output against the golden draw list.
 */
sealed class Op {
    data class Text(
        val text: String,
        val font: String,
        val size: Double,
        val color: Int, // ARGB
        val x: Double,
        val y: Double,
    ) : Op()
    data class Rule(
        val thickness: Double,
        val x: Double,
        val y: Double,
        val width: Double,
    ) : Op()
}