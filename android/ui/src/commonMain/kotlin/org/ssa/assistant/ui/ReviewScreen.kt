package org.ssa.assistant.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.Button
import androidx.compose.material.OutlinedButton
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.app.AppController
import org.ssa.assistant.core.app.Summary
import org.ssa.assistant.core.app.UiState
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.Schema

/**
 * Review: the same report the web draws (`Summary.buildReport`, the port of
 * `src/summary.js`), with change, add and remove through `runCommand`, then
 * Export or Erase everything.
 *
 * Social Security and bank numbers show only their last four digits unless
 * `revealSensitive` is set — this is the screen most likely to be seen over a
 * shoulder. The spoken read-back is not masked, as on the web.
 *
 * `runCommand("correct")` opens the change-an-answer flow, where the user
 * names the answer and, for a list, says "add another …" or "remove the
 * second …" (core's Correct, not the UI). `runCommand("readback")` speaks the
 * whole summary through core's `onReadBack` port.
 */
@Composable
internal fun ReviewScreen(
    state: UiState,
    i18n: I18n,
    actions: UiActions,
    schema: Schema,
    controller: AppController,
    scope: CoroutineScope,
    onExport: () -> Unit,
) {
    val lang = state.languages.screen
    val report = Summary.buildReport(schema, state.answers, null, lang, i18n)

    Heading(label(i18n, "Your forms are ready", lang), lang)
    Body(runsText(state.runs["reviewIntro"], state.reviewIntro), lang)
    Body(runsText(state.runs["statusText"], state.statusText), lang)

    for (section in report) {
        Gap()
        // A real heading, so VoiceOver's heading rotor can move section to
        // section instead of reading the report as one flat run.
        Body(
            section["title"]?.asString() ?: "",
            lang,
            headingStyle(),
            Modifier.semantics { heading() },
        )
        for (block in section["blocks"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()) {
            if (block["kind"]?.asString() == "table") {
                renderTable(block, state.revealSensitive, schema, i18n, lang)
                continue
            }
            val value = block["value"]?.asString() ?: ""
            val type = block["type"]?.asString()
            val shown = if (!state.revealSensitive && Summary.isSensitive(schema, type)) {
                Summary.maskDigits(value)
            } else {
                value
            }
            Body(
                (block["label"]?.asString() ?: "") + ": " +
                    shown.ifEmpty { message(i18n, "not_answered_cap", lang) },
                lang,
            )
        }
    }

    if (state.missing.isNotEmpty()) Body(state.missing, lang)

    Gap()
    Button(
        onClick = onExport,
        modifier = Modifier.fillMaxWidth().described(label(i18n, "Export my forms", lang)),
    ) {
        ButtonLabel(label(i18n, "Export my forms", lang))
    }
    OutlinedButton(
        onClick = { scope.launch { controller.runCommand("correct") } },
        modifier = Modifier.fillMaxWidth().described(label(i18n, "Change an answer", lang)),
    ) {
        ButtonLabel(label(i18n, "Change an answer", lang))
    }
    OutlinedButton(
        onClick = { scope.launch { controller.runCommand("readback") } },
        modifier = Modifier.fillMaxWidth().described(label(i18n, "Read my answers aloud", lang)),
    ) {
        ButtonLabel(label(i18n, "Read my answers aloud", lang))
    }
    Body(message(i18n, "which_answer_hint", lang), lang)

    Gap()
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

/** One loop: a caption per row and a line per column, as `renderSummary` builds its definition lists. */
@Composable
private fun renderTable(
    block: Json.Obj,
    revealSensitive: Boolean,
    schema: Schema,
    i18n: I18n,
    lang: String,
) {
    val tableLabel = block["label"]?.asString() ?: ""
    if (block["empty"] == Json.True) {
        Body(message(i18n, "no_recorded", lang, mapOf("label" to tableLabel)), lang)
        return
    }
    val columns = block["columns"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()
    val rows = block["rows"]?.asArray()?.items ?: emptyList()
    rows.forEachIndexed { index, row ->
        val values = row.asArray()?.items ?: emptyList()
        Body(
            message(i18n, "table_caption", lang, mapOf("label" to titleCase(tableLabel), "number" to index + 1)),
            lang,
            headingStyle(),
        )
        columns.forEachIndexed { columnIndex, column ->
            val value = values.getOrNull(columnIndex)?.asString() ?: ""
            val type = column["type"]?.asString()
            val shown = if (!revealSensitive && Summary.isSensitive(schema, type)) {
                Summary.maskDigits(value)
            } else {
                value
            }
            Body(
                message(
                    i18n, "summary_column", lang,
                    mapOf(
                        "label" to (column["label"]?.asString() ?: ""),
                        "value" to shown.ifEmpty { message(i18n, "not_answered", lang) },
                    ),
                ),
                lang,
            )
        }
    }
}

/** `String(s).replace(/^(.)/, c => c.toUpperCase())`, as summary.js writes a table caption. */
private fun titleCase(s: String): String = s.replaceFirstChar { it.uppercase() }
