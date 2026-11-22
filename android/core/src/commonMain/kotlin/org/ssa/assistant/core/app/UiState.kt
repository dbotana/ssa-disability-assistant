package org.ssa.assistant.core.app

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.Json.Obj
import org.ssa.assistant.core.json.Json.Null
import org.ssa.assistant.core.LanguageSettings

/** Typed UiState data class matching the JS uiState shape field-for-field. */
data class UiState(

    val panel: String,
    val sectionLabel: String,
    val questionText: String,
    val hintText: String,
    val statusText: String,
    val readbackOpen: Boolean,
    val inputMasked: Boolean,
    val voiceDisabled: Boolean,
    val progressText: String,
    val reviewIntro: String,
    val answers: Obj,
    val revealSensitive: Boolean,
    val languages: LanguageSettings,
    val lane: String,
    val focus: String?, // null means JS writes null; empty string maps to Json.Null in AppController
    val section: Obj,
    val missing: String,
    val controls: Controls,
    val exportList: List<String>,
    val runs: Map<String, List<TextRun>>
) {

    data class TextRun(val text: String, val lang: String)

    data class OptionControl(val value: String, val label: String)

    data class Controls(
        val talk: Boolean,
        val text: Boolean,
        val yes: Boolean,
        val no: Boolean,
        val options: List<OptionControl>
    )

    /** Dummy toJson for compilation - will be replaced with proper implementation. */
    fun toJson(): Obj = Obj()
}