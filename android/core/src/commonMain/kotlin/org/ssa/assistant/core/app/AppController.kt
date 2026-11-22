package org.ssa.assistant.core.app

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.Json.Obj
import org.ssa.assistant.core.json.Json.Arr
import org.ssa.assistant.core.json.Json.Str
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.core.LanguageSettings
import org.ssa.assistant.core.I18n
import java.util.LinkedHashMap

class AppController(
    schema: Schema,
    private val turn: TurnController
) {

    private val chosen = LinkedHashMap<String, String>()

    fun chooseLanguage(channel: String, lang: String) {
        chosen[channel] = lang
    }

    fun state(): UiState {
        val s = turn.snapshot()
        val screen = turn.languageSettings().screen
        val q = turn.displayQuestion()
        val i18n = turn.i18n()

        // Controls
        val sPanel = s["panel"]?.toString() ?: "interview"
        val vd = s["voiceDisabled"]
        val vdVal = when (vd) {
            is Boolean -> vd
            is Json.True -> true
            is Json.False -> false
            else -> false
        }
        val talk = vdVal != true && sPanel == "interview"
        val text = sPanel == "interview"
        val robOpen = s["readbackOpen"] == Json.True || (s["readbackOpen"] is Boolean && s["readbackOpen"] as Boolean)
        val yes = robOpen
        val no = robOpen

        // Options
        val opts = q?.options
        val optControls: List<UiState.OptionControl> = if (opts == null) {
            emptyList()
        } else if (opts is List<*>) {
            opts.asSequence()
                .mapNotNull { opt ->
                    val v = opt.value.toString()
                    val l = opt.label.toString()
                    UiState.OptionControl(v, i18n.translate(l, screen))
                }
                .toList()
        } else {
            emptyList()
        }

        val runs = buildRuns(s, screen)

        val focus = s["focus"]?.asString()?.takeIf { it.isNotEmpty() }

        return UiState(
            panel = s["panel"]?.toString() ?: "interview",
            sectionLabel = s["sectionLabel"]?.toString() ?: "",
            questionText = q?.prompt?.toString() ?: "",
            hintText = q?.hint?.toString() ?: "",
            statusText = s["statusText"]?.toString() ?: "",
            readbackOpen = robOpen,
            inputMasked = s["inputMasked"] == Json.True || (s["inputMasked"] is Boolean && s["inputMasked"] as Boolean),
            voiceDisabled = isTrue(s["voiceDisabled"]) || chosen.isNotEmpty(),
            progressText = s["progressText"]?.toString() ?: "",
            reviewIntro = s["reviewIntro"]?.toString() ?: "",
            answers = s["answers"] as? Obj ?: Obj(),
            revealSensitive = isTrue(s["revealSensitive"]),
            languages = turn.languageSettings(),
            lane = s["lane"]?.toString() ?: "starter-kit",
            focus = focus,
            section = s["section"] as? Obj ?: Obj(),
            missing = s["missing"]?.toString() ?: "",
            controls = UiState.Controls(talk, text, yes, no, optControls),
            exportList = when (s["answers"]?.asObject()?.["forms"]?.asString()) {
                "ds" -> listOf("ds")
                "both" -> listOf("ssa", "ds")
                else -> listOf("ssa")
            },
            runs = runs
        )
    }

    private fun isTrue(v: Any?): Boolean = when (v) {
        is Json.True -> true
        is Json.False -> false
        is Boolean -> v
        else -> false
    }

    private fun buildRuns(s: Obj, screen: String): Map<String, List<UiState.TextRun>> {
        fun run(t: String?): List<UiState.TextRun> = listOf(UiState.TextRun(t ?: "", screen))

        mapOf(
            "questionText" to run(s["questionText"]?.asString()),
            "hintText" to run(s["hintText"]?.asString()),
            "statusText" to run(s["statusText"]?.asString()),
            "sectionLabel" to run(s["sectionLabel"]?.asString()),
            "reviewIntro" to run(s["reviewIntro"]?.asString()),
            "progressText" to run(s["progressText"]?.asString())
        )
    }

    suspend fun submitOption(value: String) = turn.submitTyped(value)

    suspend fun start(opts: TurnController.StartOptions = TurnController.StartOptions()) {
        if (chosen.isEmpty()) {
            turn.start(opts)
        } else {
            val merged = LanguageSettings(
                input = chosen["input"] ?: opts.languages?.input ?: "en",
                output = chosen["output"] ?: opts.languages?.output ?: "en",
                screen = chosen["screen"] ?: opts.languages?.screen ?: "en",
                fill = chosen["fill"] ?: opts.languages?.fill ?: "en",
            )
            turn.start(opts.copy(languages = merged))
        }
    }

    suspend fun submitTyped(text: String?) = turn.submitTyped(text)
    suspend fun onTalkDown() = turn.onTalkDown()
    suspend fun onTalkUp() = turn.onTalkUp()
    suspend fun sendAudio(blob: TurnController.Blob) = turn.sendAudio(blob)
    suspend fun acceptReadBack() = turn.acceptReadBack()
    suspend fun rejectReadBack() = turn.rejectReadBack()
    suspend fun runCommand(cmd: String) = turn.runCommand(cmd)
    suspend fun onKey(code: String, typing: Boolean = false) = turn.onKey(code, typing)
    suspend fun askWhichField() = turn.askWhichField()
    suspend fun startReview() = turn.startReview()
    suspend fun exportForms(ids: List<String>) = turn.exportForms(ids)
    suspend fun clearEverything() = turn.clearEverything()
    suspend fun finishInterview() = turn.finishInterview()
    fun touch() = turn.touch()
    fun disableVoice() = turn.disableVoice()
}