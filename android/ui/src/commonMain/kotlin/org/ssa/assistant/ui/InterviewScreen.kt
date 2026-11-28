package org.ssa.assistant.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.Button
import androidx.compose.material.OutlinedButton
import androidx.compose.material.OutlinedTextField
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.app.AppController
import org.ssa.assistant.core.app.UiState

/**
 * Interview: the question, hint and status, the talk button, the text box,
 * yes and no while a read-back is open, one button per option, and progress.
 *
 * Answering is exactly the three lanes the reference has: voice
 * (`onTalkDown`/`onTalkUp`), typing (`submitTyped`) and tapping
 * (`submitOption`). The screen adds nothing to the state machine.
 */
@Composable
internal fun InterviewScreen(
    state: UiState,
    i18n: I18n,
    controller: AppController,
    scope: CoroutineScope,
) {
    val lang = state.runs["questionText"]?.firstOrNull()?.lang ?: state.languages.screen
    var recording by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }

    Body(runsText(state.runs["sectionLabel"], state.sectionLabel), lang)
    Body(
        runsText(state.runs["questionText"], state.questionText),
        lang,
        TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
    )
    Body(runsText(state.runs["hintText"], state.hintText), lang)
    Body(runsText(state.runs["statusText"], state.statusText), lang)
    Body(runsText(state.runs["progressText"], state.progressText), lang)

    if (state.sttUnavailable) Body(message(i18n, "stt_unavailable", lang), lang)
    if (state.voiceDisabled) Body(message(i18n, "microphone_unavailable", lang), lang)

    if (state.controls.talk) {
        Gap()
        val talkText = if (recording) message(i18n, "listening_release", lang) else label(i18n, "Talk", lang)
        TalkButton(
            text = talkText,
            description = label(
                i18n,
                "Talk. Hold to answer, or double-tap with VoiceOver to start and stop.",
                lang,
            ),
            stateText = if (recording) message(i18n, "listening", lang) else null,
            recording = recording,
            enabled = !state.voiceDisabled,
            onDown = {
                recording = true
                scope.launch { controller.onTalkDown() }
            },
            onUp = {
                if (recording) {
                    recording = false
                    scope.launch { controller.onTalkUp() }
                }
            },
        )
    }

    if (state.controls.yes || state.controls.no) {
        Gap()
        Button(
            onClick = { scope.launch { controller.acceptReadBack() } },
            enabled = state.controls.yes,
            modifier = Modifier.fillMaxWidth().described(message(i18n, "yes", lang)),
        ) {
            Text(message(i18n, "yes", lang))
        }
        OutlinedButton(
            onClick = { scope.launch { controller.rejectReadBack() } },
            enabled = state.controls.no,
            modifier = Modifier.fillMaxWidth().described(message(i18n, "no", lang)),
        ) {
            Text(message(i18n, "no", lang))
        }
    }

    if (state.controls.options.isNotEmpty()) {
        Gap()
        for (option in state.controls.options) {
            OutlinedButton(
                onClick = { scope.launch { controller.submitOption(option.value) } },
                modifier = Modifier.fillMaxWidth().described(option.label),
            ) {
                Text(option.label)
            }
        }
    }

    if (state.controls.text) {
        Gap()
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it },
            label = { Text(label(i18n, "Type your answer", lang)) },
            singleLine = false,
            maxLines = 4,
            // No autocorrect, no suggestions, no spell-check. SSN and bank
            // numbers use secure entry, which on iOS also hides the dictation
            // key. Spike 3d verifies on a phone that each option reaches the
            // native field.
            visualTransformation =
                if (state.inputMasked) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(
                keyboardType = if (state.inputMasked) KeyboardType.NumberPassword else KeyboardType.Text,
                imeAction = ImeAction.Done,
                autoCorrectEnabled = false,
            ),
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).semantics {
                contentDescription = label(i18n, "Your answer", lang)
            },
        )
        Button(
            onClick = {
                val text = typed
                if (text.isBlank()) return@Button
                typed = ""
                scope.launch { controller.submitTyped(text) }
            },
            modifier = Modifier.fillMaxWidth().described(label(i18n, "Send answer", lang)),
        ) {
            Text(label(i18n, "Send answer", lang))
        }
    }
}
