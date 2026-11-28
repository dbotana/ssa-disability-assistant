package org.ssa.assistant.core.app

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.Json.Obj
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.formsOf
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.core.LanguageSettings

class AppController(
    schema: Schema,
    private val turn: TurnController
) {

    private val chosen = LinkedHashMap<String, String>()

    fun chooseLanguage(channel: String, lang: String) {
        chosen[channel] = lang
    }

    /**
     * Whether `start()` has built the state machine. The UI must show Setup,
     * and must not call [state], while this is false: `state()` reads a
     * snapshot that needs the engine.
     */
    fun isStarted(): Boolean = turn.isStarted()

    fun state(): UiState {
        val s = turn.snapshot()
        val screen = turn.languageSettings().screen
        val q = turn.displayQuestion()
        val i18n = turn.i18n()

        val panel = s["panel"]?.asString() ?: "interview"
        val voiceDisabled = s["voiceDisabled"] == Json.True
        val readbackOpen = s["readbackOpen"] == Json.True

        val options = q?.options.orEmpty().map {
            UiState.OptionControl(it.value, i18n.translate(it.label, screen))
        }

        return UiState(
            panel = panel,
            sectionLabel = s["sectionLabel"]?.asString() ?: "",
            questionText = s["questionText"]?.asString() ?: "",
            hintText = s["hintText"]?.asString() ?: "",
            statusText = s["statusText"]?.asString() ?: "",
            readbackOpen = readbackOpen,
            inputMasked = s["inputMasked"] == Json.True,
            voiceDisabled = voiceDisabled,
            progressText = s["progressText"]?.asString() ?: "",
            reviewIntro = s["reviewIntro"]?.asString() ?: "",
            answers = s["answers"]?.asObject() ?: Obj(),
            revealSensitive = s["revealSensitive"] == Json.True,
            languages = turn.languageSettings(),
            sttUnavailable = s["sttUnavailable"] == Json.True,
            lane = s["lane"]?.asString() ?: "voice",
            focus = s["focus"]?.asString()?.takeIf { it.isNotEmpty() },
            section = s["section"]?.asObject() ?: Obj(),
            missing = s["missing"]?.asString() ?: "",
            controls = UiState.Controls(
                talk = panel == "interview" && !voiceDisabled,
                text = panel == "interview",
                yes = readbackOpen,
                no = readbackOpen,
                options = options,
            ),
            exportList = formsOf(s["answers"]?.asObject()).toList(),
            runs = buildRuns(s, screen),
        )
    }

    private fun buildRuns(s: Obj, screen: String): Map<String, List<UiState.TextRun>> {
        fun run(t: String?): List<UiState.TextRun> = listOf(UiState.TextRun(t ?: "", screen))

        return mapOf(
            "questionText" to run(s["questionText"]?.asString()),
            "hintText" to run(s["hintText"]?.asString()),
            "statusText" to run(s["statusText"]?.asString()),
            "sectionLabel" to run(s["sectionLabel"]?.asString()),
            "reviewIntro" to run(s["reviewIntro"]?.asString()),
            "progressText" to run(s["progressText"]?.asString()),
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
