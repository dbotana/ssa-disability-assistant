package org.ssa.assistant.core

import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.sectionActive
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.turn.titleCase
import java.security.MessageDigest

/**
 * The cache key for a pre-synthesized clip — a port of src/ttshash.js. The
 * clips in audio/ are named by it, so this must agree with the build's hash
 * byte for byte or every lookup misses and the device's TTS speaks instead.
 * The `tts` golden pins it to the JS side for every fixed string.
 */
object TtsHash {
    const val VOICE = "alloy"
    const val TTS_INSTRUCTIONS =
        "Speak clearly and unhurriedly, in a warm and patient tone, as if helping someone fill out an important government form."

    /** Whitespace runs collapse and the ends are trimmed, as JS does. */
    fun normalizeText(text: String?): String = jsTrim((text ?: "").replace(js("\\s+"), " "))

    /** NUL-separated, so no two combinations hash the same bytes. */
    fun canonical(text: String?, voice: String = VOICE, instructions: String = TTS_INSTRUCTIONS): String =
        "${normalizeText(text)}\u0000$voice\u0000$instructions"

    /** The first 16 hex digits of SHA-256 over the UTF-8 canonical string. */
    fun hash(text: String?, voice: String = VOICE, instructions: String = TTS_INSTRUCTIONS): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical(text, voice, instructions).toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }.substring(0, 16)
    }
}

/**
 * The fixed spoken corpus — a port of tools/tts-corpus.mjs: every string the
 * interview can speak without a user's answer in it. The clip player only
 * needs [TtsHash]; this exists so a test can prove that what the Kotlin side
 * speaks is exactly what was synthesized.
 */
object TtsCorpus {
    /** Must match MAX_LOOP_ITEMS in correct.js (item 13 would have no clip). */
    const val MAX_LOOP_ITEMS = 12

    /** Enough sample points to hit every bucket formatTimeRemaining returns. */
    val TIME_SAMPLES: List<Int> = buildList {
        add(30)
        for (m in 1..60) add(m * 60)
        for (m in 60..300 step 15) add(m * 60)
    }

    fun collect(schema: Schema, phrases: Phrases = Phrases(schema)): Set<String> {
        val out = LinkedHashSet<String>()
        fun add(t: String?) { val s = TtsHash.normalizeText(t); if (s.isNotEmpty()) out.add(s) }

        phrases.allPhrases().forEach(::add)

        val counts = LinkedHashSet<Int>()
        for (forms in listOf("ssa", "ds", "both")) {
            val answers = Json.Obj().also { it["forms"] = Json.Str(forms) }
            counts.add(schema.sections.count { sectionActive(it, answers) })
        }
        for (count in counts) for (i in 1..count) add("Section $i of $count.")

        for (section in schema.sections) {
            add("${section["title"]?.asString()}.")
            for (q in section["questions"]?.asArray()?.items.orEmpty().mapNotNull { it.asObject() }) {
                for (key in listOf("prompt", "warn", "hint", "entryPrompt", "repeatPrompt")) add(q[key]?.asString())
                for (f in q["fields"]?.asArray()?.items.orEmpty().mapNotNull { it.asObject() }) {
                    for (key in listOf("prompt", "warn", "hint")) add(f[key]?.asString())
                }
                val label = q["itemLabel"]?.asString()
                if (label != null) {
                    for (n in 2..MAX_LOOP_ITEMS) add("${titleCase(label)} $n.")
                    add("Adding a new $label.")
                }
            }
        }

        for (seconds in TIME_SAMPLES) formatTimeRemaining(seconds)?.let { add("$it left.") }
        return out
    }
}
