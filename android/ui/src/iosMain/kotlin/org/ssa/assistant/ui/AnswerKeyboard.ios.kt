package org.ssa.assistant.ui

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.text.input.PlatformImeOptions
import platform.UIKit.UITextAutocorrectionType
import platform.UIKit.UITextContentTypeOneTimeCode

/**
 * iOS keyboard traits for the answer field. `KeyboardOptions(autoCorrectEnabled
 * = false)` alone left the "Typing Predictions" bar and the Dictate key on the
 * keyboard (UI test hierarchy, 2026-11-28).
 */
@OptIn(ExperimentalComposeUiApi::class)
internal actual fun answerKeyboardOptions(): PlatformImeOptions? = PlatformImeOptions {
    autocorrectionType(UITextAutocorrectionType.UITextAutocorrectionTypeNo)
    // Secure entry on the keyboard only: UIKit then shows no prediction bar and
    // no Dictate key, and there is no public trait that hides either alone
    // (UITextInputTraits.h, iOS 27.2 SDK). Compose draws the field's text
    // itself, so the answer is still shown unless visualTransformation masks it.
    isSecureTextEntry(true)
    // Secure entry alone put a "Passwords" AutoFill button in the bar; a
    // content type that is not a password keeps AutoFill from offering it.
    textContentType(UITextContentTypeOneTimeCode)
}
