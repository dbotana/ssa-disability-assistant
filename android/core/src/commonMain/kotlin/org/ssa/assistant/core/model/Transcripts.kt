package org.ssa.assistant.core.model

import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsTrim

/**
 * Whisper's way of transcribing something that is not speech: [BLANK_AUDIO],
 * (silence), [Music], (coughs). None of it is ever part of an answer. A
 * parenthetical that holds digits — "(207)" — is a spoken number the
 * transcriber grouped, not an annotation, and must survive.
 * NON_SPEECH in src/localstt.js, in JS syntax for JsRegex.
 */
private const val NON_SPEECH = "\\[[^\\]]*\\]|\\([^0-9)]*\\)"

/**
 * src/localstt.js's cleanTranscript(): strip non-speech annotations and
 * collapse whitespace; null cleans to "". Pinned by the `transcripts` golden.
 * Transcribers return raw text; callers clean it here.
 */
fun cleanTranscript(text: String?): String =
    jsTrim((text ?: "").replace(js(NON_SPEECH), " ").replace(js("\\s+"), " "))
