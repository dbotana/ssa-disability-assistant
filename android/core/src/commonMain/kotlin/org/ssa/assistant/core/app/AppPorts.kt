package org.ssa.assistant.core.app

import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.LanguageSettings
import org.ssa.assistant.core.Option
import org.ssa.assistant.core.Phrases
import org.ssa.assistant.core.Question
import org.ssa.assistant.core.engine.Engine
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.parse.Correct
import org.ssa.assistant.core.parse.Parse
import org.ssa.assistant.core.parse.ParsedValue
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.speakableValue
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.core.validate.Normalized
import org.ssa.assistant.core.validate.Validate

/**
 * Everything a platform must supply to run an interview: the four turn ports
 * that touch a device ([store], [speech], [audio], [stt]), time, and the four
 * callbacks the UI and the shell listen to.
 *
 * The platform supplies only these. Everything that decides something lives in
 * `AppPorts` below, shared by Android and iOS, so the two apps run exactly the
 * same state machine (plan, Phase A1).
 */
interface PlatformServices {
    /** The encrypted session file, as a [TurnController.StorePort]. */
    val store: TurnController.StorePort
    val speech: TurnController.SpeechPort
    val audio: TurnController.AudioPort
    val stt: TurnController.SttPort
    val timers: TurnController.TimersPort

    /** Milliseconds since the epoch, as Date.now. Every reader of the time goes through it. */
    val clock: () -> Long

    /** The local calendar date at [epochMs] of [clock], in the device's zone. */
    fun localDate(epochMs: Long): CivilDate

    /** A one-shot announcement for the screen reader, never a question. */
    val announce: (String, Boolean) -> Unit

    /** Every state change, as the snapshot the UI draws. */
    val onState: (Json.Obj) -> Unit

    /** Export was asked for: the forms named, the answers, and the languages. */
    val onExport: suspend (List<String>, Json.Obj, LanguageSettings) -> Unit

    /** Read the whole summary aloud (the review screen's "read back everything"). */
    val onReadBack: suspend (Json.Obj) -> Unit
}

/**
 * The production wiring of [TurnController.Ports] (plan, Phase A1).
 *
 * The pure parts — the engine, the parser, normalisation, the speech
 * formatters, the phrase tables — are built here, once, for both platforms.
 * The device parts come from [services]. `TurnHarness` builds its fakes into a
 * [PlatformServices] too, so the turn goldens exercise this class rather than
 * a second, test-only copy of the same wiring.
 */
class AppPorts(
    private val schema: Schema,
    private val services: PlatformServices,
) : TurnController.Ports {

    override val say = Phrases(schema)
    override val correct = Correct(schema)
    override val i18n = I18n(schema)

    override val store: TurnController.StorePort get() = services.store
    override val speech: TurnController.SpeechPort get() = services.speech
    override val audio: TurnController.AudioPort get() = services.audio
    override val stt: TurnController.SttPort get() = services.stt
    override val timers: TurnController.TimersPort get() = services.timers
    override val clock: () -> Long get() = services.clock
    override fun localDate(epochMs: Long): CivilDate = services.localDate(epochMs)
    override val announce: (String, Boolean) -> Unit get() = services.announce
    override val onState: (Json.Obj) -> Unit get() = services.onState
    override val onExport: suspend (List<String>, Json.Obj, LanguageSettings) -> Unit get() = services.onExport
    override val onReadBack: suspend (Json.Obj) -> Unit get() = services.onReadBack

    override fun createEngine(saved: Json.Obj?, now: () -> Double): Engine = Engine(schema, saved, now)

    override fun parseLocal(
        question: Question,
        transcript: String,
        typed: Boolean,
        now: CivilDate,
        lang: String,
        readBack: Boolean,
    ): ParsedValue? = Parse.parseLocal(question, transcript, typed, now, lang, i18n, readBack)

    override fun normalize(result: ParsedValue?, question: Question): Normalized =
        Validate.normalize(result, question)

    override fun speakable(value: Any?, type: String, options: List<Option>?, lang: String): String =
        speakableValue(value, type, options, lang)

    override fun formatTimeRemaining(seconds: Int?, lang: String): String? =
        org.ssa.assistant.core.formatTimeRemaining(seconds, lang)
}
