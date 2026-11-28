package org.ssa.assistant.core.app

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.Json.Obj
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
    /** The intro is being spoken: the interview screen is up, its controls are not. */
    val starting: Boolean,
    val progressText: String,
    val reviewIntro: String,
    val answers: Obj,
    val revealSensitive: Boolean,
    val languages: LanguageSettings,
    val sttUnavailable: Boolean,
    val lane: String,
    val focus: String?, // null means JS writes null; empty string maps to Json.Null in AppController
    val section: Obj,
    val missing: String,
    val controls: Controls,
    val exportList: List<String>,
    val runs: Map<String, List<TextRun>>
) {

    data class TextRun(val text: String, val lang: String) {
        fun toJson(): Obj = Obj().also { o ->
            o["text"] = Json.Str(text)
            o["lang"] = Json.Str(lang)
        }
    }

    data class OptionControl(val value: String, val label: String) {
        fun toJson(): Obj = Obj().also { o ->
            o["value"] = Json.Str(value)
            o["label"] = Json.Str(label)
        }
    }

    data class Controls(
        val talk: Boolean,
        val text: Boolean,
        val yes: Boolean,
        val no: Boolean,
        val options: List<OptionControl>
    ) {
        fun toJson(): Obj = Obj().also { o ->
            o["talk"] = Json.bool(talk)
            o["text"] = Json.bool(text)
            o["yes"] = Json.bool(yes)
            o["no"] = Json.bool(no)
            o["options"] = Json.Arr(options.mapTo(mutableListOf()) { it.toJson() })
        }
    }

    /** The JS uiState shape, field-for-field. */
    fun toJson(): Obj = Obj().also { o ->
        o["panel"] = Json.Str(panel)
        o["sectionLabel"] = Json.Str(sectionLabel)
        o["questionText"] = Json.Str(questionText)
        o["hintText"] = Json.Str(hintText)
        o["statusText"] = Json.Str(statusText)
        o["readbackOpen"] = Json.bool(readbackOpen)
        o["inputMasked"] = Json.bool(inputMasked)
        o["voiceDisabled"] = Json.bool(voiceDisabled)
        o["starting"] = Json.bool(starting)
        o["progressText"] = Json.Str(progressText)
        o["reviewIntro"] = Json.Str(reviewIntro)
        o["answers"] = answers
        o["revealSensitive"] = Json.bool(revealSensitive)
        o["languages"] = languages.toJson()
        o["sttUnavailable"] = Json.bool(sttUnavailable)
        o["lane"] = Json.Str(lane)
        o["focus"] = focus?.let { Json.Str(it) } ?: Json.Null
        o["section"] = section
        o["missing"] = Json.Str(missing)
        o["controls"] = controls.toJson()
        o["exportList"] = Json.Arr(exportList.mapTo(mutableListOf()) { Json.Str(it) })
        o["runs"] = Obj().also { r ->
            for ((key, runs) in runs) {
                r[key] = Json.Arr(runs.mapTo(mutableListOf()) { it.toJson() })
            }
        }
    }
}
