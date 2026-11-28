package org.ssa.assistant.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.Button
import androidx.compose.material.OutlinedTextField
import androidx.compose.material.Switch
import androidx.compose.material.Text
import androidx.compose.material.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.app.AppController
import org.ssa.assistant.core.turn.TurnController

/**
 * Setup: the optional PIN, the two switches, and Start or Resume.
 *
 * Skipping the PIN says so, in the catalogue's words: nothing is saved.
 * Resume is offered only when a saved session exists; whether its PIN is
 * needed is [SessionGate](core)'s decision, not the screen's.
 *
 * It takes the screen language rather than a `UiState`: it is drawn before a
 * session starts, when there is no state to read.
 */
@Composable
internal fun SetupScreen(
    lang: String,
    i18n: I18n,
    actions: UiActions,
    controller: AppController,
    scope: CoroutineScope,
) {
    var pin by remember { mutableStateOf("") }
    var confirmEach by remember { mutableStateOf(true) }
    var showNumbers by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    val savedAt = remember(actions.stateRevision.value) { actions.savedSessionAt() }

    Heading(label(i18n, "Disability Forms Assistant", lang), lang)

    Body(
        label(
            i18n,
            "This tool fills in the forms for you to review, sign and send yourself. Nothing you say leaves this phone.",
            lang,
        ),
        lang,
    )

    if (savedAt != null) {
        val whenText = i18n.formatDate(CivilDate.ofEpochMillis(savedAt.toLong()).iso(), lang)
        Body(message(i18n, "saved_session_from", lang, mapOf("when" to whenText)) + message(i18n, "saved_locked", lang), lang)
    }

    Gap()
    Text(
        label(i18n, "PIN (optional)", lang),
        modifier = Modifier.padding(bottom = 4.dp),
    )
    OutlinedTextField(
        value = pin,
        onValueChange = { pin = it },
        label = { Text(label(i18n, "PIN", lang)) },
        singleLine = true,
        // SSNs and PINs never go through the predictive keyboard.
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.NumberPassword,
            imeAction = ImeAction.Done,
            autoCorrectEnabled = false,
        ),
        modifier = Modifier.fillMaxWidth().semantics {
            contentDescription = label(i18n, "PIN, optional. With a PIN your answers are saved encrypted on this phone.", lang)
        },
    )
    Body(label(i18n, "A PIN needs at least 4 characters. Longer is safer.", lang), lang)

    Gap()
    SwitchRow(
        text = label(i18n, "Read each answer back before it is kept", lang),
        checked = confirmEach,
        onCheckedChange = { confirmEach = it },
    )
    SwitchRow(
        text = label(i18n, "Show Social Security and bank numbers as I type them", lang),
        checked = showNumbers,
        onCheckedChange = { showNumbers = it },
    )

    if (pin.isEmpty()) {
        Body(message(i18n, "no_pin_warning", lang), lang)
    }

    if (status.isNotEmpty()) {
        Body(status, lang)
    }

    Gap()
    Button(
        onClick = {
            status = ""
            actions.openSession(
                resume = false,
                pin = pin,
                onProgress = { status = it },
                done = { saved, error -> onOpened(scope, controller, error, saved, confirmEach, showNumbers) { status = it } },
            )
        },
        modifier = Modifier.fillMaxWidth().described(label(i18n, "Start", lang)),
    ) {
        Text(label(i18n, "Start", lang))
    }

    if (savedAt != null) {
        TextButton(
            onClick = {
                status = ""
                actions.openSession(
                    resume = true,
                    pin = pin,
                    onProgress = { status = it },
                    done = { saved, error -> onOpened(scope, controller, error, saved, confirmEach, showNumbers) { status = it } },
                )
            },
            modifier = Modifier.fillMaxWidth().described(label(i18n, "Resume", lang)),
        ) {
            Text(label(i18n, "Resume my saved session", lang))
        }
    }
}

private fun onOpened(
    scope: CoroutineScope,
    controller: AppController,
    error: String?,
    saved: TurnController.SavedSession?,
    confirmEach: Boolean,
    showNumbers: Boolean,
    setStatus: (String) -> Unit,
) {
    if (error != null) {
        setStatus(error)
        return
    }
    scope.launch {
        controller.start(
            TurnController.StartOptions(
                mode = "voice",
                confirm = confirmEach,
                reveal = showNumbers,
                saved = saved,
            )
        )
    }
}

@Composable
private fun SwitchRow(text: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Text(text, modifier = Modifier.weight(1f).padding(end = 12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            modifier = Modifier.semantics { contentDescription = text },
        )
    }
}
