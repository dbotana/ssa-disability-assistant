package org.ssa.assistant.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.Button
import androidx.compose.material.OutlinedButton
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.app.AppController
import org.ssa.assistant.core.app.UiState
import org.ssa.assistant.core.schema.Schema

/**
 * Export: the forms chosen, the export itself, the spoken summary (core speaks
 * it in `exportForms`), one Save-or-share button per finished file, and Erase
 * everything.
 *
 * The work happens behind `PlatformServices.onExport`: the shell runs
 * [org.ssa.assistant.core.app.ExportJob] with the real PDF writer and
 * self-check, stores the outcome in [UiActions.exported], and throws when
 * nothing could be produced so core speaks `pdf_failed`.
 */
@Composable
internal fun ExportScreen(
    state: UiState,
    i18n: I18n,
    actions: UiActions,
    schema: Schema,
    controller: AppController,
    scope: CoroutineScope,
    onBack: () -> Unit,
) {
    val lang = state.languages.screen
    val files = actions.exported.value
    val failures = actions.exportFailed.value

    Heading(label(i18n, "Export your forms", lang), lang)
    Body(runsText(state.runs["statusText"], state.statusText), lang)

    Gap()
    val names = state.exportList.map { id -> id to (schema.formTitles[id] ?: id) }
    if (names.isEmpty()) {
        Body(label(i18n, "No form has been chosen yet.", lang), lang)
    }
    for ((id, title) in names) {
        OutlinedButton(
            onClick = { scope.launch { controller.exportForms(listOf(id)) } },
            modifier = Modifier.fillMaxWidth().described(label(i18n, "Export", lang) + " " + title),
        ) {
            ButtonLabel(label(i18n, "Export", lang) + " " + title)
        }
    }
    if (names.size > 1) {
        Button(
            onClick = { scope.launch { controller.exportForms(names.map { it.first }) } },
            modifier = Modifier.fillMaxWidth().described(label(i18n, "Export both forms", lang)),
        ) {
            ButtonLabel(label(i18n, "Export both forms", lang))
        }
    }

    if (files.isNotEmpty()) {
        Gap()
        for (file in files) {
            OutlinedButton(
                onClick = { actions.share(file) },
                modifier = Modifier.fillMaxWidth().described(label(i18n, "Save or share", lang) + " " + file.fileName),
            ) {
                ButtonLabel(
                    label(i18n, "Save or share", lang) + " " + file.fileName +
                        if (file.version == null) "" else " (${file.version})",
                )
            }
        }
        Body(label(i18n, "Saving to iCloud Drive uploads it to Apple.", lang), lang)
    }

    if (failures.isNotEmpty()) {
        Gap()
        Body(message(i18n, "pdf_failed", lang), lang)
        for (failure in failures) {
            Body(failure.formId + ": " + failure.check, lang)
        }
    }

    Gap()
    OutlinedButton(
        onClick = onBack,
        modifier = Modifier.fillMaxWidth().described(label(i18n, "Back to my answers", lang)),
    ) {
        ButtonLabel(label(i18n, "Back to my answers", lang))
    }
    OutlinedButton(
        onClick = {
            scope.launch { controller.clearEverything() }
            actions.eraseEverything()
        },
        modifier = Modifier.fillMaxWidth().described(label(i18n, "Erase everything from this phone", lang)),
    ) {
        ButtonLabel(label(i18n, "Erase everything from this phone", lang))
    }
}
