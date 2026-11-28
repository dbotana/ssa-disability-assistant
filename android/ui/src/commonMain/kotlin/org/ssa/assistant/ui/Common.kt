package org.ssa.assistant.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.intl.Locale
import androidx.compose.ui.text.intl.LocaleList
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.app.UiState

/**
 * The small pieces every screen shares.
 *
 * **Language.** `UiState.runs` carries a language for every text run the
 * interview builds, so each node's language is set as a [LocaleList] on its
 * TextStyle where Compose allows it: nodes whose text comes from `runs`.
 * Everything else (a control's label) uses the screen language, which is the
 * same channel the catalogue resolves those strings in.
 *
 * **Content descriptions.** Every control gets one, from the catalogue:
 * [label] is the catalogue lookup the whole app uses (`I18n.translate`, whose
 * English source is the key and whose miss falls back to English as on the
 * web). Where the catalogue has a ready message for the meaning, a screen uses
 * `i18n.message(...)` instead.
 */

/** Text drawn in the screen's language. */
internal fun label(i18n: I18n, source: String, lang: String): String = i18n.translate(source, lang)

/** A catalogue message in the screen's language. */
internal fun message(i18n: I18n, key: String, lang: String, vars: Map<String, Any?> = emptyMap()): String =
    i18n.message(key, vars, lang)

/** The text of one `runs` entry, or [fallback], with the run's language as a LocaleList. */
internal fun runStyle(runs: List<UiState.TextRun>?, fallbackLang: String): TextStyle {
    val lang = runs?.firstOrNull { it.text.isNotEmpty() }?.lang ?: fallbackLang
    return TextStyle(localeList = LocaleList(Locale(lang)))
}

/** The text of one `runs` entry joined, or [fallback] when it is empty. */
internal fun runsText(runs: List<UiState.TextRun>?, fallback: String): String {
    val joined = runs?.joinToString(" ") { it.text } ?: ""
    return joined.ifEmpty { fallback }
}

/** Give a node its content description and button role. */
internal fun Modifier.described(text: String): Modifier = this.semantics {
    contentDescription = text
    role = Role.Button
}

/** A screen heading. */
@Composable
internal fun Heading(text: String, lang: String) {
    Text(
        text = text,
        style = TextStyle(
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
            localeList = LocaleList(Locale(lang)),
        ),
        modifier = Modifier.padding(bottom = 12.dp),
    )
}

/** A paragraph of body text in a given language. */
@Composable
internal fun Body(
    text: String,
    lang: String,
    style: TextStyle = TextStyle(),
    modifier: Modifier = Modifier,
) {
    if (text.isEmpty()) return
    Text(
        text = text,
        // The caller's style wins: it is merged over the default, not under it.
        style = TextStyle(
            fontSize = 18.sp,
            localeList = LocaleList(Locale(lang)),
        ).merge(style),
        modifier = modifier.padding(bottom = 8.dp),
    )
}

/** A labelled row of buttons that wraps naturally by stacking. */
@Composable
internal fun ButtonRow(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        content()
    }
}

/**
 * The talk control.
 *
 * A sighted user holds it down: `pointerInput` starts recording on press and
 * stops when the finger lifts, even if the gesture is cancelled. Under
 * VoiceOver, press-and-hold is impossible, so the node also carries an
 * `onClick` semantics action: a VoiceOver double-tap activates it, which
 * starts recording, and a second double-tap stops it. Both routes go to
 * `AppController.onTalkDown`/`onTalkUp`; the toggle never records while speech
 * is playing because the controller owns the half-duplex rule (core, not the
 * UI).
 *
 * [stateText] is the catalogue's word for the current state, or null when
 * there is nothing extra to say.
 */
@Composable
internal fun TalkButton(
    text: String,
    description: String,
    stateText: String?,
    recording: Boolean,
    enabled: Boolean,
    onDown: () -> Unit,
    onUp: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (recording) MaterialTheme.colors.secondary else MaterialTheme.colors.primary)
            .semantics(mergeDescendants = true) {
                contentDescription = description
                role = Role.Button
                if (stateText != null) stateDescription = stateText
                onClick(label = description) {
                    if (!enabled) return@onClick false
                    if (recording) onUp() else onDown()
                    true
                }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures(
                    onPress = {
                        onDown()
                        // A cancelled gesture still ends the capture: leaving
                        // the button stuck on would leave the microphone open.
                        tryAwaitRelease()
                        onUp()
                    }
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = MaterialTheme.colors.onPrimary,
            style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
        )
    }
}

/** A sub-heading inside a screen: a section title on Review. */
internal fun headingStyle(): TextStyle = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold)

/** A divider-like spacer, because the four screens all need one. */
@Composable
internal fun Gap(height: Int = 12) {
    Spacer(Modifier.height(height.dp))
}
