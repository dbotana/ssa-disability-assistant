package org.ssa.assistant.core.parse

import org.ssa.assistant.core.Question
import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsEscape
import org.ssa.assistant.core.js.jsLower
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test
import java.time.LocalDate

/**
 * Port of src/parse.js: local answer parsing, certain or nothing.
 *
 * Every pattern is the reference's own, in JS syntax, compiled through
 * [js] — which spells out JS's `\s`, `\w`, `\d`, `\b`, `.`, `$` and `/i` as
 * explicit classes, so the port matches what JS matches on the desktop JVM
 * and under Android's ICU alike. Every `trim()` is [jsTrim]. The functions
 * keep the reference's names and order, so the two read side by side.
 */

data class ParsedValue(val value: Any, val confidence: Double)

object Parse {
    // -- yes / no ------------------------------------------------------------------

    private val YES = js("^(y|yes|yeah|yep|yup|sure|correct|right|true|affirmative|ok|okay|that is right|thats right|that's right|uh huh)$")
    private val NO = js("^(n|no|nope|nah|negative|false|incorrect|wrong|that is wrong|thats wrong|that's wrong|uh uh)$")

    /** Filler that carries no meaning and appears at the head of spoken answers. */
    private val LEAD_FILLER = js("^(um|uh|er|well|so|okay|ok|like|i think|i would say|let me see|hmm)\\b[\\s,]*", ignoreCase = true)

    private val DIGIT_WORDS = mapOf(
        "zero" to "0", "oh" to "0", "o" to "0", "naught" to "0", "nought" to "0",
        "one" to "1", "two" to "2", "three" to "3", "four" to "4", "for" to "4", "five" to "5",
        "six" to "6", "seven" to "7", "eight" to "8", "ate" to "8", "nine" to "9", "niner" to "9"
    )

    private val MONTHS = linkedMapOf(
        "january" to 1, "jan" to 1, "february" to 2, "feb" to 2, "march" to 3, "mar" to 3,
        "april" to 4, "apr" to 4, "may" to 5, "june" to 6, "jun" to 6, "july" to 7, "jul" to 7,
        "august" to 8, "aug" to 8, "september" to 9, "sept" to 9, "sep" to 9, "october" to 10,
        "oct" to 10, "november" to 11, "nov" to 11, "december" to 12, "dec" to 12
    )

    // -- spoken numbers inside dates -----------------------------------------------

    private val SMALL_NUMBERS = linkedMapOf(
        "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7,
        "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12, "thirteen" to 13,
        "fourteen" to 14, "fifteen" to 15, "sixteen" to 16, "seventeen" to 17, "eighteen" to 18,
        "nineteen" to 19
    )

    private val TENS_NUMBERS = linkedMapOf(
        "twenty" to 20, "thirty" to 30, "forty" to 40, "fifty" to 50,
        "sixty" to 60, "seventy" to 70, "eighty" to 80, "ninety" to 90
    )

    private val ORDINAL_NUMBERS = linkedMapOf(
        "first" to 1, "second" to 2, "third" to 3, "fourth" to 4, "fifth" to 5, "sixth" to 6,
        "seventh" to 7, "eighth" to 8, "ninth" to 9, "tenth" to 10, "eleventh" to 11,
        "twelfth" to 12, "thirteenth" to 13, "fourteenth" to 14, "fifteenth" to 15,
        "sixteenth" to 16, "seventeenth" to 17, "eighteenth" to 18, "nineteenth" to 19,
        "twentieth" to 20, "thirtieth" to 30
    )

    private fun alt(obj: Map<String, *>): String = obj.keys.joinToString("|")

    private val SMALL = alt(SMALL_NUMBERS)
    private val TENS = alt(TENS_NUMBERS)
    private val ORD = alt(ORDINAL_NUMBERS)

    private fun small(w: String) = SMALL_NUMBERS.getValue(jsLower(w))
    private fun tens(w: String) = TENS_NUMBERS.getValue(jsLower(w))
    private fun century(w: String) = if (jsLower(w) == "nineteen") 1900 else 2000

    /** Rewrite spoken numbers in a date phrase as digits (JS spokenNumbers). */
    private fun spokenNumbers(text: String?): String {
        var s = text ?: ""

        // "two thousand five", "two thousand and twelve", "two thousand"
        s = js("\\btwo thousand(?:\\s+and)?(?:\\s+($TENS)(?:[\\s-]+($SMALL))?|\\s+($SMALL))?\\b", true).replace(s) { m ->
            val g = m.groupValues
            (2000
                + (if (g[1].isNotEmpty()) tens(g[1]) else 0)
                + (if (g[2].isNotEmpty()) small(g[2]) else 0)
                + (if (g[3].isNotEmpty()) small(g[3]) else 0)).toString()
        }

        // "nineteen oh five", "twenty oh eight"
        s = js("\\b(nineteen|twenty)\\s+(?:oh|o)\\s+($SMALL)\\b", true).replace(s) { m ->
            (century(m.groupValues[1]) + small(m.groupValues[2])).toString()
        }

        // "nineteen seventy nine", "twenty twenty four", "nineteen eighty"
        s = js("\\b(nineteen|twenty)\\s+($TENS)(?:[\\s-]+($SMALL))?\\b", true).replace(s) { m ->
            val g = m.groupValues
            (century(g[1]) + tens(g[2]) + (if (g[3].isNotEmpty()) small(g[3]) else 0)).toString()
        }

        // "twenty twelve", "nineteen eighteen"
        s = js("\\b(nineteen|twenty)\\s+($SMALL)\\b", true).replace(s) { m ->
            val g = m.groupValues
            val n = small(g[2])
            if (n < 10) "${g[1]} ${g[2]}" else (century(g[1]) + n).toString()
        }

        // "twenty first", "thirty first" — compound ordinal days.
        s = js("\\b(twenty|thirty)[\\s-]+($ORD)\\b", true).replace(s) { m ->
            val n = ORDINAL_NUMBERS.getValue(jsLower(m.groupValues[2]))
            if (n < 10) "${tens(m.groupValues[1]) + n}th" else m.value
        }

        // "fourteenth" -> "14th". The suffix is kept: parseDate() uses it.
        s = js("\\b($ORD)\\b", true).replace(s) { m -> "${ORDINAL_NUMBERS.getValue(jsLower(m.groupValues[1]))}th" }

        // "twenty one" -> "21", then any bare small number.
        s = js("\\b($TENS)[\\s-]+($SMALL)\\b", true).replace(s) { m ->
            (tens(m.groupValues[1]) + small(m.groupValues[2])).toString()
        }
        s = js("\\b($SMALL|$TENS)\\b", true).replace(s) { m ->
            val w = jsLower(m.groupValues[1])
            (SMALL_NUMBERS[w] ?: TENS_NUMBERS.getValue(w)).toString()
        }

        return s
    }

    /** "Still working there" on an end date. */
    private val PRESENT = js("\\b(still|ongoing|present|current(ly)?|to this day|up to now|continu\\w*)\\b", true)

    /**
     * Interpret a transcript locally. Returns a value, or null when the answer
     * must be asked again. `now` is the current date (the century window and
     * the future-date check).
     */
    fun parseLocal(question: Question, transcript: String?, typed: Boolean = false, now: LocalDate = LocalDate.now()): ParsedValue? {
        val raw = jsTrim(transcript ?: "")
        if (raw.isEmpty()) return null
        return parseByType(question, raw, typed, now)
    }

    private fun parseByType(question: Question, raw: String, typed: Boolean, now: LocalDate): ParsedValue? {
        // The echo is stripped for typed input too; typed free text still
        // returns null below and is kept exactly as written.
        val s = stripEcho(raw, question)
        return when (question.type) {
            "yesno" -> parseYesNo(s)
            "ssn", "routing", "account" -> parseSensitiveDigits(s)
            "phone" -> parsePhone(s)
            "zip" -> parseZip(s)
            "email" -> parseEmail(s)
            "choice" -> parseChoice(s, question)
            "date" -> parseDate(s, question, now)
            "monthyear" -> parseMonthYear(s, question, now)
            "money", "number" -> parseNumber(s, question)
            else -> if (typed) null else parseText(s)
        }
    }

    /** Strip a leading clause that echoes the question ("my date of birth is…"). */
    private fun stripEcho(raw: String, question: Question): String {
        val prompt = jsLower(question.prompt)
        var subject = jsTrim(prompt.replaceFirst(js("\\?.*$"), ""))
        subject = subject.replaceFirst(
            js("^(what is|what was|what are|which|who is|who was|when is|when was|where is|where was|where are|how many|how much|how often|how old|what|who|when|where|how)\\b[ ,]*", true), "")
        subject = jsTrim(subject.replace(js("\\byour\\b"), "my"))
        subject = subject.replaceFirst(js("^my\\s+"), "")
        if (subject.isEmpty()) return raw
        val m = js("^(?:my |the |our )?${jsEscape(subject)} (?:is|was|are|were)[, ]+", true).find(raw) ?: return raw
        val rest = jsTrim(raw.substring(m.value.length))
        return rest.ifEmpty { raw }
    }

    // -- free text -------------------------------------------------------------

    private val TEXT_LEAD = js("^(?:(?:um+|uh+|er+|erm|hmm+|mm+)[\\s,.]+|(?:my answer is|the answer is)[\\s,:]+)", true)
    private val LETTER_OR_NUMBER = Regex("[\\p{L}\\p{N}]")

    private fun parseText(raw: String): ParsedValue? {
        var s = jsTrim(raw.replace(js("\\s+"), " "))
        for (i in 0 until 3) {
            val next = jsTrim(s.replaceFirst(TEXT_LEAD, ""))
            if (next.isEmpty() || next == s) break
            s = next
        }
        s = jsTrim(s.replaceFirst(js("[.!?\\s]+$"), ""))
        if (s.isEmpty() || !LETTER_OR_NUMBER.test(s)) return null
        return ParsedValue(s.substring(0, 1).uppercase() + s.substring(1), 1.0)
    }

    // -- yes / no --------------------------------------------------------------

    // Anchored at both ends: the clause has to be the whole answer.
    private val YES_PHRASE = js("^(yes|yeah|yep|yup)\\b[ ,]+(i|you|he|she|we|they|it)\\s+(do|does|did|am|are|is|was|were|have|has|had|would|will|can|could|should)$", true)
    private val NO_PHRASE = js("^(no|nope|nah)\\b[ ,]+(i|you|he|she|we|they|it)\\s+(do not|don'?t|does not|doesn'?t|did not|didn'?t|am not|are not|aren'?t|is not|isn'?t|was not|wasn'?t|were not|weren'?t|have not|haven'?t|has not|hasn'?t|had not|hadn'?t|would not|wouldn'?t|will not|won'?t|can not|cannot|can'?t|could not|couldn'?t|should not|shouldn'?t)$", true)

    private fun parseYesNo(raw: String?): ParsedValue? {
        val bare = jsTrim(jsLower(raw ?: "").replace("’", "'").replace(js("\\s+"), " "))
            .replaceFirst(js("[.!?,]+$"), "")
        if (YES.test(bare)) return ParsedValue(true, 1.0)
        if (NO.test(bare)) return ParsedValue(false, 1.0)
        if (YES_PHRASE.test(bare)) return ParsedValue(true, 1.0)
        if (NO_PHRASE.test(bare)) return ParsedValue(false, 1.0)

        val s = clean(raw).replace("’", "'").replaceFirst(js("[.!?,]+$"), "")
        if (YES.test(s)) return ParsedValue(true, 1.0)
        if (NO.test(s)) return ParsedValue(false, 1.0)
        return null
    }

    // -- choice ----------------------------------------------------------------

    private fun parseChoice(raw: String, question: Question): ParsedValue? =
        matchChoice(question.options, raw)?.let { ParsedValue(it.value, 1.0) }

    // -- digits ----------------------------------------------------------------

    private fun parseSensitiveDigits(raw: String): ParsedValue? =
        digitsFrom(raw)?.let { ParsedValue(it, 1.0) }

    private fun parsePhone(raw: String): ParsedValue? {
        val digits = digitsFrom(raw) ?: return null
        if (digits.length == 10) return ParsedValue(digits, 1.0)
        if (digits.length == 11 && digits.startsWith("1")) return ParsedValue(digits, 1.0)
        return null
    }

    /**
     * Digits from a transcript, or null if anything ambiguous is present:
     * written digits (ASCII only, as JS `\d`), spoken digit words, and the
     * separators people say or a transcriber writes between groups.
     */
    private fun digitsFrom(raw: String): String? {
        val s = clean(raw)
            .replace(js("[.,!?]+"), " ")
            .replace(js("[-–—()+]"), " ")
            .replace(js("\\bdash\\b|\\bhyphen\\b|\\band\\b"), " ")

        if (js("\\b(double|triple|twice|thrice)\\b").test(s)) return null

        val tokens = s.split(js("\\s+")).filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return null

        val out = StringBuilder()
        for (token in tokens) {
            if (js("^\\d+$").test(token)) { out.append(token); continue }
            out.append(DIGIT_WORDS[token] ?: return null)
        }
        return if (out.isEmpty()) null else out.toString()
    }

    private fun parseZip(raw: String): ParsedValue? {
        val digits = digitsFrom(raw) ?: return null
        return if (digits.length == 5 || digits.length == 9) ParsedValue(digits, 1.0) else null
    }

    // -- email -----------------------------------------------------------------

    private val EMAIL = js("^[a-z0-9._%+-]+@[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z]{2,}$")

    private fun parseEmail(raw: String?): ParsedValue? {
        val s = jsLower(jsTrim(raw ?: "")).replaceFirst(js("[.!?,]+$"), "")
        if (EMAIL.test(s)) return ParsedValue(s, 1.0)
        val spoken = s
            .replace(js("\\s+at\\s+"), "@")
            .replace(js("\\s+dot\\s+"), ".")
            .replace(js("\\s+(underscore)\\s+"), "_")
            .replace(js("\\s+(dash|hyphen)\\s+"), "-")
        if (js("\\s").test(spoken)) return null
        return if (EMAIL.test(spoken)) ParsedValue(spoken, 1.0) else null
    }

    // -- numbers and money -----------------------------------------------------

    private val UNIT_WORDS = mapOf(
        "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7,
        "eight" to 8, "nine" to 9
    )
    private val TEEN_WORDS = mapOf(
        "ten" to 10, "eleven" to 11, "twelve" to 12, "thirteen" to 13, "fourteen" to 14,
        "fifteen" to 15, "sixteen" to 16, "seventeen" to 17, "eighteen" to 18, "nineteen" to 19
    )

    /**
     * Number words to a value, or null unless they are one number said the way
     * a number is said — the spoken grammar, not a sum. See wordsToNumber() in
     * parse.js.
     */
    private fun wordsToNumber(s: String): Int? {
        val tokens = s.split(js("[\\s-]+")).filter { it.isNotEmpty() }
        var i = 0

        fun belowHundred(): Int? {
            val t = tokens.getOrNull(i) ?: return null
            UNIT_WORDS[t]?.let { i++; return it }
            TEEN_WORDS[t]?.let { i++; return it }
            TENS_NUMBERS[t]?.let { tensValue ->
                i++
                val unit = tokens.getOrNull(i)?.let { UNIT_WORDS[it] }
                if (unit != null) { i++; return tensValue + unit }
                return tensValue
            }
            return null
        }

        fun group(): Int? {
            val lead: Int
            if (tokens.getOrNull(i) == "a" && (tokens.getOrNull(i + 1) == "hundred" || tokens.getOrNull(i + 1) == "thousand")) {
                i++
                lead = 1
            } else {
                lead = belowHundred() ?: return null
            }
            if (tokens.getOrNull(i) != "hundred") return lead
            i++
            var value = lead * 100
            if (tokens.getOrNull(i) == "and") {
                i++
                value += belowHundred() ?: return null
            } else if (i < tokens.size && tokens[i] != "thousand") {
                value += belowHundred() ?: return null
            }
            return value
        }

        if (tokens.isEmpty()) return null
        var total = group() ?: return null
        if (tokens.getOrNull(i) == "thousand") {
            if (total >= 1000) return null
            i++
            total *= 1000
            if (i < tokens.size) {
                if (tokens[i] == "and") i++
                val rest = group()
                if (rest == null || rest >= 1000) return null
                total += rest
            }
        }
        return if (i == tokens.size) total else null
    }

    /** Longer phrases first, as in parse.js. */
    private val PERIOD_PHRASES = listOf(
        js("\\bevery (?:two|2|other) weeks?\\b|\\bbi ?weekly\\b") to "biweekly",
        js("\\btwice (?:a|per) month\\b|\\bsemi ?monthly\\b") to "twice_month",
        js("\\b(?:an?|per|each|every) hour\\b|\\bhourly\\b|\\bby the hour\\b") to "hour",
        js("\\b(?:an?|per|each|every) day\\b|\\bdaily\\b") to "day",
        js("\\b(?:an?|per|each|every) week\\b|\\bweekly\\b") to "week",
        js("\\b(?:an?|per|each|every) month\\b|\\bmonthly\\b") to "month",
        js("\\b(?:an?|per|each|every) year\\b|\\byearly\\b|\\bannually\\b|\\bper annum\\b") to "year",
        js("\\b(?:an?|per|each) paycheck\\b") to "paycheck"
    )

    private fun parseNumber(raw: String, question: Question): ParsedValue? {
        var s = jsTrim(clean(raw)
            .replaceFirst(js("[.,!?]+$"), "")
            .replace(js("\\bdollars?\\b|\\bbucks?\\b"), " ")
            .replace(js("[$,]"), ""))

        val periods = LinkedHashSet<String>()
        for ((re, period) in PERIOD_PHRASES) {
            s = re.replace(s) { periods.add(period); " " }
        }
        if (periods.isNotEmpty()) {
            val per = question.per
            if (per != "any" && !(periods.size == 1 && periods.contains(per))) return null
        }

        s = jsTrim(s.replace(js("\\b(approx\\w*|about|around|roughly)\\b"), " ").replace(js("\\s+"), " "))
        if (s.isEmpty()) return null

        wordsToNumber(s)?.let { return ParsedValue(it.toDouble(), 1.0) }

        if (question.kind == "year") {
            val year = jsTrim(spokenNumbers(s))
            if (js("^\\d{4}$").test(year)) return ParsedValue(year.toDouble(), 1.0)
        }

        if (js("\\b(to|or|between|and)\\b").test(s)) return null

        val numeric = js("-?\\d+(\\.\\d+)?").findAll(s).toList()
        if (numeric.size == 1 && js("^[\\s\\d.$-]*$").test(s)) {
            return ParsedValue(numeric[0].value.toDouble(), 1.0)
        }
        return null
    }

    // -- dates -----------------------------------------------------------------

    private fun parseDate(raw: String, question: Question, now: LocalDate): ParsedValue? {
        val s = spokenNumbers(clean(raw))

        var m = js("^(\\d{4})-(\\d{2})-(\\d{2})$").find(s)
        if (m != null) {
            val g = m.groupValues
            return dated(g[1].toInt(), g[2].toInt(), g[3].toInt(), 1.0, question, now)
        }

        // 3/14/79, 03-14-1979
        m = js("^(\\d{1,2})[/\\-.](\\d{1,2})[/\\-.](\\d{2}|\\d{4})$").find(s)
        if (m != null) {
            val g = m.groupValues
            return dated(expandYear(g[3].toInt(), g[3].length, question, now), g[1].toInt(), g[2].toInt(), 1.0, question, now)
        }

        // March 14th 1979 · the 14th of March, 1979 · March 14 1979
        val month = findMonth(s) ?: return null
        val matches = js("\\b(\\d{1,4})(st|nd|rd|th)?\\b").findAll(s).toList()
        val nums = matches.map { it.groupValues[1] }
        if (nums.size != 2) return null

        // The year is whichever number cannot be a day of the month.
        val (a, b) = nums
        val day: String
        val yearRaw: String
        when {
            a.length == 4 -> { yearRaw = a; day = b }
            b.length == 4 -> { yearRaw = b; day = a }
            a.toInt() > 31 -> { yearRaw = a; day = b }
            b.toInt() > 31 -> { yearRaw = b; day = a }
            matches[0].groupValues[2].isNotEmpty() && matches[1].groupValues[2].isEmpty() -> { day = a; yearRaw = b }
            matches[1].groupValues[2].isNotEmpty() && matches[0].groupValues[2].isEmpty() -> { day = b; yearRaw = a }
            else -> return null
        }

        val confidence = if (yearRaw.length == 4) 1.0 else 0.8
        return dated(expandYear(yearRaw.toInt(), yearRaw.length, question, now), month, day.toInt(), confidence, question, now)
    }

    private fun parseMonthYear(raw: String, question: Question, now: LocalDate): ParsedValue? {
        val s = spokenNumbers(clean(raw))

        if (PRESENT.test(s) && !js("\\b(19|20)\\d{2}\\b").test(s)) {
            return ParsedValue("present", 1.0)
        }

        var m = js("^(\\d{4})-(\\d{2})$").find(s)
        if (m != null) return monthYear(m.groupValues[1].toInt(), m.groupValues[2].toInt(), 1.0, question, now)

        // 3/79, 03/1979
        m = js("^(\\d{1,2})[/\\-.](\\d{2}|\\d{4})$").find(s)
        if (m != null) {
            val g = m.groupValues
            return monthYear(expandYear(g[2].toInt(), g[2].length, question, now), g[1].toInt(), if (g[2].length == 4) 1.0 else 0.8, question, now)
        }

        val month = findMonth(s) ?: return null
        val nums = js("\\b(\\d{2,4})\\b").findAll(s).map { it.groupValues[1] }.toList()
        if (nums.size != 1) return null

        val yearRaw = nums[0]
        return monthYear(expandYear(yearRaw.toInt(), yearRaw.length, question, now), month, if (yearRaw.length == 4) 1.0 else 0.8, question, now)
    }

    private fun findMonth(s: String): Int? {
        for ((name, n) in MONTHS) {
            if (js("\\b$name\\b").test(s)) return n
        }
        return null
    }

    private fun expandYear(year: Int, digits: Int, question: Question, now: LocalDate): Int {
        if (digits == 4) return year
        val current = now.year
        val century = (current / 100) * 100
        val candidate = century + year
        if (candidate <= current) return candidate
        if (question.allowFuture && candidate <= current + 20) return candidate
        return candidate - 100
    }

    // ASCII digits whatever the device locale: String.format("%04d") would
    // write Arabic-Indic digits on a phone set to Arabic.
    private fun pad(n: Int, width: Int) = n.toString().padStart(width, '0')

    private fun dated(year: Int, month: Int, day: Int, confidence: Double, question: Question, now: LocalDate): ParsedValue? {
        if (!validYmd(year, month, day)) return null
        if (isFuture(year, month, day, now) && !question.allowFuture) return null
        return ParsedValue("${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}", confidence)
    }

    private fun monthYear(year: Int, month: Int, confidence: Double, question: Question, now: LocalDate): ParsedValue? {
        if (!validYmd(year, month, 1)) return null
        if (isFuture(year, month, 1, now) && !question.allowFuture) return null
        return ParsedValue("${pad(year, 4)}-${pad(month, 2)}", confidence)
    }

    /** Rejects February 30 and friends rather than rolling them over silently. */
    private fun validYmd(year: Int, month: Int, day: Int): Boolean {
        if (year < 1900 || year > 2100) return false
        if (month < 1 || month > 12) return false
        if (day < 1) return false
        return day <= LocalDate.of(year, month, 1).lengthOfMonth()
    }

    private fun isFuture(year: Int, month: Int, day: Int, now: LocalDate): Boolean =
        LocalDate.of(year, month, day).isAfter(now)

    // -- shared ----------------------------------------------------------------

    private fun clean(raw: String?): String {
        val s = jsTrim(jsLower(raw ?: "").replace(js("\\s+"), " "))
        // "okay" and "uh" are filler in "okay, March 14th" but the entire
        // answer in "okay" and "uh huh". Only strip a lead-in when something
        // survives it.
        val stripped = jsTrim(s.replaceFirst(LEAD_FILLER, ""))
        return stripped.ifEmpty { s }
    }
}
