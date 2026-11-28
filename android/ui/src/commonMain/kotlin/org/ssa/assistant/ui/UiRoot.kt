package org.ssa.assistant.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.app.AppController
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The shared Compose Multiplatform app: Setup, Interview, Review and Export,
 * drawn only from `UiState` and driven only through [AppController]'s
 * commands (plan, Phase B2).
 *
 * The screen redraws whenever the shell bumps [UiActions.stateRevision], which
 * it does from `PlatformServices.onState` — the same callback the web app
 * renders from. Nothing here decides anything: the panel, the controls, the
 * question and the answers all come from the state machine in `core`.
 *
 * Setup comes first, and it needs no state: before `start()` the controller
 * has no engine, so `AppController.state()` would read a snapshot that needs
 * one. [AppController.isStarted] is the gate, and `stateRevision` makes it
 * re-evaluate after `start()` emits.
 */
@Composable
fun UiRoot(controller: AppController, actions: UiActions) {
    val schema = remember { SchemaLoader.load() }
    val i18n = remember(schema) { I18n(schema) }
    val revision = actions.stateRevision.value
    val started = controller.isStarted()
    val state = remember(revision, started) { if (started) controller.state() else null }
    val scope = rememberCoroutineScope()

    var exportOpen by remember { mutableStateOf(false) }
    // Leaving Review (for example after "change an answer") closes the export
    // screen, so the interview is what the user hears next.
    LaunchedEffect(state?.panel) {
        if (state?.panel != "review") exportOpen = false
    }

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colors.background) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
            ) {
                val current = state
                when {
                    // Before a session starts — and again after Erase, which
                    // puts the panel back to setup — there is nothing to say.
                    current == null || current.panel == "setup" ->
                        SetupScreen(lang = "en", i18n = i18n, actions = actions, controller = controller, scope = scope)
                    current.panel == "review" && !exportOpen ->
                        ReviewScreen(
                            state = current,
                            i18n = i18n,
                            actions = actions,
                            schema = schema,
                            controller = controller,
                            scope = scope,
                            onExport = { exportOpen = true },
                        )
                    current.panel == "review" ->
                        ExportScreen(
                            state = current,
                            i18n = i18n,
                            actions = actions,
                            schema = schema,
                            controller = controller,
                            scope = scope,
                            onBack = { exportOpen = false },
                        )
                    else -> InterviewScreen(current, i18n, controller, scope)
                }
            }
        }
    }
}
