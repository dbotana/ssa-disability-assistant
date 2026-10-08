package org.ssa.assistant.core

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.Schema

/**
 * Every fixed string the interview speaks, read from the schema export (the
 * `phrases` table tools/export-schema.mjs writes from src/phrases.js) rather
 * than kept by hand. Each one has a pre-synthesized clip in audio/, found by
 * its ttshash, and a copy that drifted from the clip's text would silently be
 * spoken by the device's TTS instead.
 *
 * The wording is still the web app's — "hold the space bar", "check your
 * downloads folder" — and the Android screens will need their own for those,
 * with clips of their own. That lands with the UI (TODO.md, Android port).
 */
class Phrases(private val table: Json.Obj) {
    constructor(schema: Schema) : this(schema.phrases)

    /** One phrase by its name in phrases.js: `text("ANSWER_AGAIN")`. */
    fun text(name: String): String =
        table[name]?.asString() ?: throw IllegalArgumentException("no phrase $name")

    /** One of the keyed tables: INTRO, REASK, ERRORS. */
    fun table(name: String): Map<String, String> =
        (table[name]?.asObject() ?: throw IllegalArgumentException("no phrase table $name"))
            .entries.mapValues { it.value.asString()!! }

    val intro: Map<String, String> get() = table("INTRO")
    val reask: Map<String, String> get() = table("REASK")
    val errors: Map<String, String> get() = table("ERRORS")

    /** Every fixed string, flattened in the order of allPhrases() in phrases.js. */
    fun allPhrases(): List<String> =
        intro.values.toList() +
            listOf(
                "SAVED", "STARTING_OVER", "DOWNLOADED", "BOTH_DOWNLOADED", "ALL_DONE", "DOWNLOAD_HINT",
                "FORMS_CHANGED", "WORKSHEET_FALLBACK",
                "HELP", "WHICH_FIELD", "UNCHANGED",
                "TRANSCRIPT_CHECK", "ANSWER_AGAIN", "TYPING_LANE", "VOICE_LANE"
            ).map(::text) +
            reask.values.toList() +
            errors.values.toList() +
            listOf("LET_US_TRY_AGAIN", "GOING_BACK", "FILL_IN_MISSING").map(::text)
}
