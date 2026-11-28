package org.ssa.assistant.ui

import androidx.compose.ui.text.input.PlatformImeOptions

/** Android keeps `KeyboardOptions` alone until its app moves to `:ui`. */
internal actual fun answerKeyboardOptions(): PlatformImeOptions? = null
