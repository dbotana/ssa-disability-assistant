package org.ssa.assistant.ui

import androidx.compose.ui.text.input.PlatformImeOptions

/**
 * The native keyboard traits for the Interview's answer field, which
 * `KeyboardOptions` cannot express in common code: on iOS, the prediction
 * bar and the dictation key (plan, B2's text-field rule). Null where the
 * platform needs nothing beyond `KeyboardOptions`.
 */
internal expect fun answerKeyboardOptions(): PlatformImeOptions?
