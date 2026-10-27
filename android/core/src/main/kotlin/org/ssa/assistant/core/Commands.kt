package org.ssa.assistant.core

import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsLower
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/**
 * Port of src/commands.js: navigation commands, matched locally on both the
 * typed and the spoken path.
 *
 * Anchored, so a command word appearing inside a real answer is not mistaken
 * for a command: "I skip meals" is an answer, "skip" is a command.
 *
 * English runs the original table. For French and Lingala the words come from
 * the shared lexicon, after the language's filler is stripped and the text is
 * folded (D5).
 */

private val LOCAL_COMMANDS = listOf(
    js("^(repeat|repeat that|say (that )?again|again|one more time)$") to "repeat",
    js("^(back|go back|previous|last question|go back a question)$") to "back",
    js("^(skip|skip (this|it|that)|pass|leave (it |this )?blank|next)$") to "skip",
    js("^(where|where am i|progress|how far|how much (is )?(left|to go))$") to "where",
    js("^(read back|read back my answers|read my answers|review)$") to "readback",
    js("^(change|change an answer|correct|correct an answer|fix|fix an answer|edit)$") to "correct",
    js("^(save|save and quit|quit|stop for now)$") to "save_quit",
    js("^(start over|restart|start again)$") to "restart",
    js("^(help|\\?|what can i say)$") to "help",
    js("^(finish|done|finish early|that is all|thats all|i am done|im done)$") to "finish"
)

/** Politeness and hesitation around a spoken command; carries no meaning. */
private val COMMAND_FILLER_LEAD =
    js("^(um|uh|er|ok|okay|well|hey|please|can you|could you|would you|i want to|i would like to|let us|lets)\\b[\\s,]*")
private val COMMAND_FILLER_TAIL = js("[\\s,]*\\b(please|now|thanks|thank you)\\b[\\s.!?]*$")

fun localCommand(text: String?, lang: String = "en", i18n: I18n? = null): String? {
    var s = jsTrim(
        jsLower(text ?: "").trim().replace(js("[.!?]+$"), "")
    )
    // Strip filler repeatedly: "ok, can you please repeat that" stacks three.
    for (i in 0 until 3) {
        val before = s
        s = jsTrim(s.replaceFirst(COMMAND_FILLER_LEAD, "").replace(COMMAND_FILLER_TAIL, ""))
        if (s == before) break
    }
    if (s.isEmpty()) return null
    for ((re, cmd) in LOCAL_COMMANDS) if (re.test(s)) return cmd
    if (lang != "en") return nonEnglishCommand(text, lang, i18n ?: I18n.default)
    return null
}

/**
 * Fold a command word the way the transcript is folded. Apostrophes and
 * hyphens become spaces, so "c'est tout" and "où en suis-je" reach the
 * lexicon entries stored as "c est tout" and "ou en suis je".
 */
private fun normalizeCommand(text: String?, lang: String, i18n: I18n): String =
    jsTrim(i18n.fold(text, lang)
        .replace(js("[\u2019']"), " ")
        .replace("-", " ")
        .replace(js("\\s+"), " "))

/** French and Lingala command words, from the lexicon. */
private fun nonEnglishCommand(text: String?, lang: String, i18n: I18n): String? {
    val tables = i18n.lexicon(lang)
    var s = normalizeCommand(text, lang, i18n)
    for (i in 0 until 3) {
        val before = s
        for (source in (tables["filler"]?.asArray()?.items ?: emptyList()).mapNotNull { it.asString() }) {
            try {
                s = s.replace(js(source), "").trim()
            } catch (_: Exception) { /* ignore a bad table entry */ }
        }
        if (s == before) break
    }
    s = s.replace(js("[.!?]+$"), "").trim()
    if (s.isEmpty()) return null

    val commands = tables["commands"]?.asObject() ?: return null
    for ((cmd, wordsRaw) in commands.entries) {
        for (word in (wordsRaw.asArray()?.items ?: emptyList()).mapNotNull { it.asString() }) {
            if (word == "\\?") {
                if (s == "?") return cmd
                continue
            }
            if (normalizeCommand(word, lang, i18n) == s) return cmd
        }
    }
    return null
}

/** The command a key press means, in both the interview and review panels. */
val KEY_COMMANDS = mapOf(
    "Enter" to "repeat", "KeyB" to "back", "KeyS" to "skip",
    "KeyW" to "where", "KeyR" to "readback", "KeyC" to "correct"
)
