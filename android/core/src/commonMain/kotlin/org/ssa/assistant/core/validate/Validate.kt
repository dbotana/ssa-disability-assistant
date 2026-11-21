package org.ssa.assistant.core.validate

import org.ssa.assistant.core.Question
import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsLower
import org.ssa.assistant.core.js.jsString
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test
import org.ssa.assistant.core.parse.ParsedValue
import org.ssa.assistant.core.parse.matchChoice
import org.ssa.assistant.core.parse.optionsSentence

/**
 * Port of src/validate.js: the single place that decides whether a value is
 * well formed enough to write onto a benefits application.
 */

data class Normalized(
    val command: String? = null,
    val value: Any? = null,
    val confidence: Double = 0.0,
    val needsClarification: Boolean = false,
    val clarifyPrompt: String? = null,
)

object Validate {
    private val EMAIL = js("^[a-z0-9._%+-]+@[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z]{2,}$")

    fun normalize(result: ParsedValue?, question: Question): Normalized {
        val out = Normalized(
            command = null,
            value = result?.value,
            confidence = result?.confidence ?: 0.0,
            needsClarification = false,
            clarifyPrompt = null
        )
        if (out.value == null || out.value == "") {
            return out.copy(needsClarification = true)
        }

        // String(value), as JS writes it: a number 4101 is "4101", not "4101.0".
        val text = jsString(out.value)
        val digits = text.replace(js("\\D"), "")
        fun fail(msg: String): Normalized {
            return Normalized(
                command = out.command,
                value = null,
                confidence = out.confidence,
                needsClarification = true,
                clarifyPrompt = out.clarifyPrompt ?: msg
            )
        }

        var done = when (question.type) {
            "yesno" -> {
                val v = out.value
                if (v !is Boolean) {
                    val s = jsLower(jsTrim(text))
                    when {
                        js("^(yes|yeah|yep|correct|right|true)$").test(s) -> out.copy(value = true)
                        js("^(no|nope|nah|false)$").test(s) -> out.copy(value = false)
                        else -> fail("Please answer yes or no.")
                    }
                } else out
            }
            "ssn" ->
                if (digits.length != 9) fail("I need all nine digits of the Social Security number. You can say them one at a time.")
                else out.copy(value = digits)
            "routing" ->
                if (digits.length != 9) fail("A routing number has nine digits. You can say them one at a time.")
                else out.copy(value = digits)
            "account" ->
                if (digits.length < 4) fail("I did not get the full account number. You can say the digits one at a time.")
                else out.copy(value = digits)
            "phone" ->
                when {
                    digits.length == 11 && digits.startsWith("1") -> out.copy(value = digits.substring(1))
                    digits.length != 10 -> fail("I need a ten digit phone number, including the area code.")
                    else -> out.copy(value = digits)
                }
            "zip" ->
                if (digits.length != 5 && digits.length != 9) fail("A zip code has five digits. You can say them one at a time.")
                else out.copy(value = digits)
            "email" -> {
                val email = jsLower(jsTrim(text)).replace(js("\\s+"), "")
                if (!EMAIL.test(email)) fail("I did not get a complete email address. You can spell it out, or say skip.")
                else out.copy(value = email)
            }
            "choice" -> {
                val option = matchChoice(question.options, text)
                if (option == null) fail("Please choose one: ${optionsSentence(question.options)}.")
                else out.copy(value = option.value)
            }
            "date" ->
                if (!js("^\\d{4}-\\d{2}-\\d{2}$").test(text))
                    fail("Could you give me the month, day, and year?")
                else out
            "monthyear" ->
                if (jsLower(text) == "present") out.copy(value = "present")
                else if (!js("^\\d{4}-\\d{2}$").test(text))
                    fail("Could you give me the month and the year?")
                else out
            "money", "number" -> {
                // Nothing numeric at all is not zero (see validate.js).
                val numeric = text.replace(js("[^0-9.\\-]"), "")
                val n = if (js("\\d").test(numeric)) jsNumberOf(numeric) else Double.NaN
                if (!n.isFinite()) fail("Could you say that as a number?")
                else out.copy(value = n)
            }
            else -> {
                val v = jsTrim(text)
                if (v.isEmpty()) fail("I did not catch that. Could you say it again?")
                else out.copy(value = v)
            }
        }

        // A low-confidence read on a sensitive field is a re-ask, not a guess.
        if (!done.needsClarification && done.confidence < 0.5 && question.confirm) {
            done = done.copy(
                needsClarification = true,
                clarifyPrompt = done.clarifyPrompt ?: "I am not sure I heard that correctly. Could you say it again?"
            )
        }
        return done
    }
}

/**
 * Number(s) for the strings normalize() builds: digits, at most one point,
 * optional leading minus. Anything else — "1.2.3", "--5" — is NaN, as in JS.
 */
internal fun jsNumberOf(s: String): Double =
    if (js("^-?(\\d+\\.?\\d*|\\.\\d+)$").test(s)) s.toDouble() else Double.NaN
