package org.ssa.assistant.core.turn

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import org.ssa.assistant.core.KEY_COMMANDS
import org.ssa.assistant.core.Option
import org.ssa.assistant.core.Phrases
import org.ssa.assistant.core.Question
import org.ssa.assistant.core.engine.Engine
import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.js.jsTrim
import org.ssa.assistant.core.js.test
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.localCommand
import org.ssa.assistant.core.parse.Correct
import org.ssa.assistant.core.parse.Target
import org.ssa.assistant.core.parse.ParsedValue
import org.ssa.assistant.core.schema.Node
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.flatten
import org.ssa.assistant.core.validate.Normalized

/**
 * Port of src/turn.js: ask -> listen -> transcribe -> interpret -> confirm
 * once -> commit -> advance, as a pure state machine over injected ports.
 *
 * The turn is interpret-first: a voice answer is transcribed, gated, parsed
 * and validated, and the *parsed value* is read back once — never the raw
 * transcript and then the value. One confirmation, whatever produced the
 * value. State is a base mode plus at most one open overlay, held in nullable
 * fields exactly as turn.js holds them; the plan's sealed-state refactor
 * lands with M4-M8.
 */
class TurnController(private val ports: Ports, schema: Schema) {

    interface Ports {
        val say: Phrases
        val correct: Correct
        val store: StorePort
        val speech: SpeechPort
        val audio: AudioPort
        val stt: SttPort
        val timers: TimersPort
        /** Milliseconds, as Date.now — every reader of the time goes through it. */
        val clock: () -> Long
        val announce: (String, Boolean) -> Unit
        val onState: (Json.Obj) -> Unit
        val onExport: suspend (List<String>, Json.Obj) -> Unit
        val onReadBack: suspend (Json.Obj) -> Unit
        fun createEngine(saved: Json.Obj?, now: () -> Double): Engine
        fun parseLocal(question: Question, transcript: String, typed: Boolean, now: LocalDate): ParsedValue?
        fun normalize(result: ParsedValue?, question: Question): Normalized
        fun speakable(value: Any?, type: String, options: List<Option>?): String
        fun formatTimeRemaining(seconds: Int?): String?
    }

    interface StorePort {
        fun saveState(state: Json.Obj): Boolean
        suspend fun flush()
        fun markWithheld(fields: List<Json.Obj>)
        fun sensitiveAnswers(state: Json.Obj): List<Json.Obj>
        fun isPersisting(): Boolean
        fun clearState()
        fun forgetKey()
    }

    interface SpeechPort {
        suspend fun speak(text: String, interrupt: Boolean)
        fun cancel()
    }

    data class Blob(val size: Int, val text: String?)

    interface AudioPort {
        suspend fun startRecording(options: Json.Obj)
        suspend fun stopRecording(): Blob
        fun cancelRecording()
        fun isRecording(): Boolean
        fun lastCaptureDurationMs(): Int
        fun lastCaptureHadSpeech(): Boolean
        fun lastCapturePeak(): Double
        fun releaseMic()
        fun earcon(name: String)
    }

    interface SttPort {
        suspend fun transcribe(blob: Blob): String
    }

    interface TimersPort {
        fun setTimeout(fn: suspend () -> Unit, ms: Long): String
        fun clearTimeout(id: String?)
    }

    class SttError(val kind: String) : Exception(kind)

    companion object {
        const val MIN_CAPTURE_MS = 350
        const val QUIET_PEAK = 0.05
        const val DIGIT_SILENCE_MS = 3000
        const val DIGIT_MAX_CAPTURE_MS = 60000
        const val IDLE_LOCK_MS = 15 * 60 * 1000L

        // What a transcriber tends to emit when handed silence or room tone.
        private val FILLER_TRANSCRIPTS = setOf(
            "you", "thank you", "thanks", "thanks for watching", "thank you for watching",
            "bye", "okay", "ok", "uh", "um", "hmm", "mm", "oh", "the"
        )

        private val ACCURATE_DIGIT_TYPES = setOf("ssn", "routing", "account", "phone")

        /** Is this transcript empty, punctuation, or silence-filler from a quiet mic? */
        fun isEmptyTranscript(text: String?, peak: Double): Boolean {
            val s = jsTrim(text ?: "")
            if (s.isEmpty()) return true
            // Nothing but punctuation, dashes, quotes or ellipses.
            if (s.codePoints().noneMatch { Character.isLetterOrDigit(it) }) return true
            val bare = jsTrim(s.lowercase().replaceFirst(js("[.!?,\\s]+$"), ""))
            return FILLER_TRANSCRIPTS.contains(bare) && peak < QUIET_PEAK
        }
    }

    private val sensitiveTypes: Set<String> = schema.sensitiveTypes.toSet()
    private val schemaNodes: List<Node> = flatten(schema.sections)

    private val ACCEPT_HINT = "Press the space bar to keep it, or N to answer again. " +
        "You can also say yes or no."

    // -- state -----------------------------------------------------------------

    private var mode = "voice"              // voice | handsfree | text
    private var voiceDisabled = false
    private var lastInputWasText = false
    private var busy = false
    private var confirmEachAnswer = true
    private var revealSensitive = false

    // The one overlay a value read-back opens, awaiting yes or no.
    private var pending: Pending? = null
    private data class Pending(val question: Question, val value: Any?)

    // Correction state. Exactly one of these is active at a time.
    private var correcting: Correction? = null
    private data class Correction(val target: Target, val question: Question, val restore: Json.Obj)
    private var choosing: List<Target>? = null
    private var choosingItem: ChoosingItem? = null
    private data class ChoosingItem(
        val loopId: String,
        val itemLabel: String,
        val candidates: List<Correct.ItemDescription>
    )
    private var confirmingDelete: ConfirmingDelete? = null
    private data class ConfirmingDelete(val loopId: String, val item: Correct.ItemDescription)
    private var adding: Adding? = null
    private data class Adding(val loopId: String, val itemLabel: String, val startCount: Int)
    private var resumeAfterPrompt = false
    private var awaitingFieldName = false

    private var withheld = mutableListOf<Json.Obj>()   // [{ id, loopId?, loopIndex?, idle? }]
    private var lastSpoken = ""
    private var lastSegments = mutableListOf<String>()
    private var lastSection: String? = null
    private var lastSpokenEstimate: String? = null
    private var idleTimer: String? = null
    private var panel = "interview"          // interview | review

    private var sectionLabel = ""
    private var statusText = ""
    private var questionTextContent = ""
    private var hintTextContent = ""
    private var reviewIntro = ""

    private var engine: Engine? = null

    private val isSensitive = { q: Question? -> sensitiveTypes.contains(q?.type) }

    // -- small helpers -----------------------------------------------------------

    /** The question whatever is on screen right now is about. */
    private fun displayQuestion(): Question? =
        pending?.question ?: correcting?.question ?: engine?.current()

    fun readBackOpen(): Boolean = pending != null

    private data class FieldRef(val id: String, val loopId: String?, val loopIndex: Int?)

    private fun sameField(a: FieldRef, b: FieldRef): Boolean =
        a.id == b.id && a.loopId == b.loopId && (a.loopIndex ?: 0) == (b.loopIndex ?: 0)

    private fun fieldOf(f: Json.Obj): FieldRef = FieldRef(
        id = f["id"]?.asString() ?: "",
        loopId = f["loopId"]?.asString(),
        loopIndex = (f["loopIndex"] as? Json.Num)?.value?.toInt()
    )

    private fun fieldOf(t: Target): FieldRef = FieldRef(t.id, t.loopId, t.loopIndex)

    /** Where an answer lives, as `withheld` and the store record it: the
     *  value dropped, loopIndex defaulted to 0, exactly as fieldOf() in
     *  turn.js builds it. */
    private fun withheldShape(h: Json.Obj): Json.Obj = Json.Obj().also { o ->
        o["id"] = h["id"] ?: Json.Null
        val loopId = h["loopId"]?.asString()
        if (loopId != null) {
            o["loopId"] = h["loopId"]!!
            o["loopIndex"] = Json.Num((h["loopIndex"] as? Json.Num)?.value ?: 0.0)
        }
    }

    private fun withheldShape(f: FieldRef): Json.Obj = Json.Obj().also { o ->
        o["id"] = Json.Str(f.id)
        if (f.loopId != null) {
            o["loopId"] = Json.Str(f.loopId)
            o["loopIndex"] = Json.Num((f.loopIndex ?: 0).toDouble())
        }
    }

    private fun isAnswered(f: FieldRef): Boolean {
        val answers = engine!!.answers()
        val v = if (f.loopId != null) {
            (answers[f.loopId] as? Json.Arr)?.items?.getOrNull(f.loopIndex ?: 0)?.asObject()?.get(f.id)
        } else answers[f.id]
        return v != null && v !== Json.Null && !(v is Json.Str && v.value.isEmpty())
    }

    private fun saveSession(): Boolean =
        ports.store.saveState(engine!!.getState(correcting?.restore))

    private fun touchActivity() {
        ports.timers.clearTimeout(idleTimer)
        idleTimer = ports.timers.setTimeout({ lockSensitive() }, IDLE_LOCK_MS)
    }

    private fun isFirstFieldOfItem(q: Question?): Boolean {
        if (q?.loopId == null) return false
        val node = schemaNodes.firstOrNull { it.id == q.loopId }
        return node?.fields?.getOrNull(0)?.get("id")?.asString() == q.id
    }

    // -- the ask ------------------------------------------------------------------

    private suspend fun askCurrent(announceSection: Boolean = false, prefix: String = "") {
        pending = null
        val q = engine!!.current()

        if (q == null) { awaitFinishInterview(); return }

        val segments = mutableListOf<String>()
        if (correcting != null) {
            sectionLabel = "Changing an answer — ${q.sectionTitle}"
        } else if (adding != null) {
            sectionLabel = "Adding a ${adding!!.itemLabel} — ${q.sectionTitle}"
        } else if (announceSection || q.section != lastSection) {
            val p = engine!!.progress()
            if (p.sectionCount != null) {
                segments.add("Section ${p.sectionNumber} of ${p.sectionCount}.")
                segments.add("${q.sectionTitle}.")
                sectionLabel = "Section ${p.sectionNumber} of ${p.sectionCount} — ${q.sectionTitle}"
            } else {
                segments.add("${q.sectionTitle}.")
                sectionLabel = q.sectionTitle ?: ""
            }
            lastSection = q.section
            val left = ports.formatTimeRemaining(p.secondsRemaining)
            if (left != null && left != lastSpokenEstimate) {
                segments.add("$left left.")
                lastSpokenEstimate = left
            }
        }
        if (q.warn != null && correcting == null) segments.add(q.warn)
        if (correcting == null && q.loopPhase == "field" && (q.itemNumber ?: 0) > 1 && isFirstFieldOfItem(q)) {
            segments.add("${titleCase(q.itemLabel ?: "")} ${q.itemNumber}.")
        }
        if (prefix.isNotEmpty()) segments.add(prefix)
        segments.add(q.prompt)

        questionTextContent = q.prompt
        hintTextContent = q.hint ?: ""
        reviewIntro = ""
        awaitSpeakSegments(segments)

        resumeListening()
    }

    private suspend fun awaitSpeakSegments(segments: List<String>) {
        lastSegments = segments.filter { it.isNotEmpty() }.toMutableList()
        lastSpoken = lastSegments.joinToString(" ")
        for ((i, text) in lastSegments.withIndex()) {
            ports.speech.speak(text, interrupt = i == 0)
        }
    }

    private fun progressText(): String {
        val p = engine!!.progress()
        val left = ports.formatTimeRemaining(p.secondsRemaining)
        return if (left != null) "${p.percent}% done · $left left" else "${p.percent}% done"
    }

    private fun resumeListening() {
        if (mode == "handsfree" && !voiceDisabled) { queueListen(); return }
        emit()
    }

    private fun queueListen(attempt: Int = 0) {
        if (attempt > 100) return
        ports.timers.setTimeout({
            if (busy) { queueListen(attempt + 1); return@setTimeout }
            listenHandsFree()
        }, 60)
    }

    // -- starting ------------------------------------------------------------------

    // A second start while the first is still under way — a double press of
    // Start or Resume while the intro is being spoken — joins the first rather
    // than running over it.
    private var starting: Job? = null

    suspend fun start(opts: StartOptions = StartOptions()) {
        val inFlight = starting
        if (inFlight != null) { inFlight.join(); return }
        val job = CoroutineScope(currentCoroutineContext()).launch {
            try {
                startNow(opts)
            } finally {
                starting = null
            }
        }
        starting = job
        job.join()
    }

    data class StartOptions(
        val mode: String = "voice",
        val confirm: Boolean = true,
        val reveal: Boolean = false,
        val saved: SavedSession? = null,
        val withheldFrom: List<Json.Obj>? = null,
    )

    data class SavedSession(val state: Json.Obj?, val withheld: List<Json.Obj>?)

    private suspend fun startNow(opts: StartOptions) {
        mode = opts.mode
        confirmEachAnswer = opts.confirm
        revealSensitive = opts.reveal
        engine = ports.createEngine(opts.saved?.state, { ports.clock() / 1000.0 })
        // The numbers a resumed session did not save. `withheldFrom` overrides
        // the saved list only when a caller passes one: defaulting it to []
        // would throw the saved list away, and a resumed session would never
        // ask for the Social Security and bank numbers again.
        val list = opts.withheldFrom ?: opts.saved?.withheld ?: emptyList<Json.Obj>()
        withheld = list.filter { w -> !isAnswered(fieldOf(w)) }.toMutableList()
        if (opts.saved != null) saveSession()
        panel = "interview"
        lastInputWasText = mode == "text"

        ports.speech.speak(introFor(mode), interrupt = true)
        if (!ports.store.isPersisting()) {
            val msg = "You did not set a PIN, so nothing is being saved. " +
                "If you close this page, your answers will be lost."
            ports.announce(msg, true)
            ports.speech.speak(msg, interrupt = false)
        }
        if (withheld.isNotEmpty()) {
            val msg = "For your security, your Social Security and bank numbers were not saved when you " +
                "stopped last time. I will ask for them again before your forms are ready."
            ports.announce(msg, true)
            ports.speech.speak(msg, interrupt = false)
        }
        touchActivity()
        askCurrent(announceSection = true)
        emit()
    }

    private fun introFor(m: String): String =
        ports.say.table("INTRO")[m] ?: ports.say.table("INTRO")["voice"]!!

    // -- input: voice ----------------------------------------------------------------

    suspend fun onTalkDown() {
        if (busy || voiceDisabled || ports.audio.isRecording()) return
        lastInputWasText = false
        statusText = "Listening…"
        emit()
        try {
            ports.audio.startRecording(Json.Obj())
        } catch (e: Exception) {
            ports.announce("The microphone is not available. Switching to typing.", true)
            disableVoice()
        }
    }

    suspend fun onTalkUp() {
        if (!ports.audio.isRecording()) return
        val blob = ports.audio.stopRecording()
        sendAudio(blob)
    }

    private suspend fun listenHandsFree() {
        if (busy || voiceDisabled || mode != "handsfree") return
        statusText = "Listening…"
        emit()
        // Nobody reads out nine digits without breathing. Digit fields get a
        // silence window long enough to group them in.
        val digits = needsAccurateDigits(askedQuestion())
        try {
            ports.audio.startRecording(Json.Obj().also { o ->
                o["autoStop"] = Json.True
                if (digits) {
                    o["silenceMs"] = Json.Num(DIGIT_SILENCE_MS.toDouble())
                    o["maxMs"] = Json.Num(DIGIT_MAX_CAPTURE_MS.toDouble())
                }
            })
        } catch (e: Exception) {
            disableVoice()
        }
    }

    /** The question a capture starting right now would be answering. */
    private fun askedQuestion(): Question? {
        val q = displayQuestion() ?: return null
        return pending?.let { q.copy(type = "yesno") } ?: q
    }

    suspend fun sendAudio(blob: Blob) {
        touchActivity()
        // Four cheap filters before transcribing: nothing recorded, a bumped
        // button, or a capture of only room tone. All end the same way — ask
        // again — because the one thing that must not happen is the form
        // moving on from a question the user never answered.
        if (blob.size < 800
            || ports.audio.lastCaptureDurationMs() < MIN_CAPTURE_MS
            || !ports.audio.lastCaptureHadSpeech()) {
            reask(ports.say.table("REASK")["nothingHeard"]!!)
            return
        }
        busy = true
        statusText = "Transcribing…"
        emit()
        try {
            val asked = askedQuestion()
            if (asked == null) return

            val transcript = ports.stt.transcribe(blob)

            // A transcriber handed near-silence does not return nothing; it
            // returns a short plausible phrase. Reject those rather than
            // record them.
            if (isEmptyTranscript(transcript, ports.audio.lastCapturePeak())) {
                reask(ports.say.table("REASK")["nothingHeard"]!!)
                return
            }

            // These are the fields where a misread digit does lasting damage.
            if (needsAccurateDigits(asked) && localCommand(transcript) == null
                && !namesSomethingToDelete(transcript)
                && !digitsSurviveNormalize(asked, transcript)) {
                statusText = "You said: $transcript"
                emit()
                reask(ports.say.table("REASK")["unsure"]!!)
                return
            }

            statusText = "You said: $transcript"
            emit()
            handleTranscript(transcript)
        } catch (err: SttError) {
            if (err.kind == "empty") { reask(ports.say.table("REASK")["nothingHeard"]!!); return }
            handleSttError(err)
        } finally {
            busy = false
        }
    }

    private val needsAccurateDigits = { q: Question? -> ACCURATE_DIGIT_TYPES.contains(q?.type) }

    private fun digitsSurviveNormalize(question: Question, transcript: String): Boolean {
        val local = parse(question, transcript)
        return local != null && !ports.normalize(local, question).needsClarification
    }

    private fun parse(question: Question, text: String, typed: Boolean = false): ParsedValue? =
        ports.parseLocal(question, text, typed, parseNow())

    /** The parser's "now", as JS derives it from a Date: the local date. */
    private fun parseNow(): LocalDate =
        Instant.ofEpochMilli(ports.clock()).atZone(ZoneId.systemDefault()).toLocalDate()

    /**
     * Handle one answer: extract, validate, confirm once, commit.
     */
    private suspend fun handleTranscript(transcript: String) {
        // "Which answer would you like to change?" is matched by correct.js,
        // not by the answer parser.
        if (inCorrectionPrompt()) { statusText = ""; handleFieldName(transcript); return }

        // "Remove that last provider" mid-interview is a command, not an answer.
        if (pending == null && namesSomethingToDelete(transcript)) {
            statusText = ""
            deleteMidInterview(transcript)
            return
        }

        // Navigation words are matched on the voice path too, not only when typed.
        if (pending == null) {
            val cmd = localCommand(transcript)
            if (cmd != null) { statusText = ""; runCommand(cmd); return }
        }

        val q = pending?.question ?: engine!!.current()
        if (q == null) return

        // A confirmation read-back is a yes/no question about the value just
        // heard. Yes and no are matched first — "correct" is both a way to say
        // yes and the name of the change-an-answer command, and here it plainly
        // means the first. Otherwise a command still wins.
        if (pending != null) {
            val yn = parse(q.copy(type = "yesno", prompt = "Is that correct?"), transcript)
            if (yn?.value == true) { acceptReadBack(); return }
            if (yn?.value == false) { rejectReadBack(); return }
            val cmd = localCommand(transcript)
            if (cmd != null) { statusText = ""; runCommand(cmd); return }
            reask(ports.say.table("REASK")["yesno"]!!)
            return
        }

        val local = parse(q, transcript)
        if (local == null) {
            reask(if (q.hint != null) "${ports.say.table("REASK")["generic"]} ${q.hint}" else ports.say.table("REASK")["generic"]!!)
            return
        }
        val result = ports.normalize(local, q)

        if (result.command != null) { runCommand(result.command); return }

        if (result.needsClarification || result.value == null) {
            reask(result.clarifyPrompt ?: ports.say.table("REASK")["generic"]!!)
            return
        }

        // One confirmation, for everything the user spoke (or for the fields
        // that demand it). The read-back speaks the parsed value, digit by
        // digit where that is how a misheard digit is caught.
        if (q.confirm || confirmEachAnswer) {
            pending = Pending(q, result.value)
            val readBack = "I heard ${ports.speakable(result.value, q.type, q.options)}. Is that correct?"
            questionTextContent = readBack
            hintTextContent = ACCEPT_HINT
            ports.announce(readBack, false)
            // Through speakSegments, so `repeat` replays the read-back rather
            // than the question it is about.
            awaitSpeakSegments(listOf(readBack))
            emit()
            resumeListening()
            return
        }

        commit(result.value)
    }

    private suspend fun commit(value: Any?) {
        touchActivity()
        val asked = correcting?.question ?: engine!!.current()
        statusText = if (!confirmEachAnswer && asked != null && value != null)
            "Recorded: ${ports.speakable(value, asked.type, asked.options)}" else ""
        if (correcting != null) { finishCorrection(value); return }
        engine!!.submit(value)
        saveSession()
        if (adding != null && !stillAdding()) { finishAddition(); return }
        askCurrent()
    }

    private fun stillAdding(): Boolean {
        val a = adding ?: return false
        return engine!!.current()?.loopId == a.loopId
    }

    private suspend fun reask(message: String) {
        val q = engine!!.current()
        val hint = if (q?.hint != null) " ${q.hint}" else ""
        ports.announce(message + hint, true)
        ports.speech.speak(message + hint, interrupt = false)
        resumeListening()
    }

    suspend fun acceptReadBack() {
        if (!readBackOpen()) return
        if (ports.audio.isRecording()) ports.audio.cancelRecording()
        val value = pending!!.value
        pending = null
        commit(value)
    }

    suspend fun rejectReadBack() {
        if (!readBackOpen()) return
        if (ports.audio.isRecording()) ports.audio.cancelRecording()
        val q = pending!!.question
        pending = null
        // The same question reopens without its prompt being read again. The
        // user heard it a moment ago and is only fixing what was heard.
        questionTextContent = q.prompt
        hintTextContent = q.hint ?: ""
        ports.announce(ports.say.text("ANSWER_AGAIN"), true)
        awaitSpeakSegments(listOf(ports.say.text("ANSWER_AGAIN")))
        lastSegments = mutableListOf(q.prompt)
        lastSpoken = q.prompt
        resumeListening()
    }

    // -- input: typing -----------------------------------------------------------------

    suspend fun submitTyped(text: String?) {
        val t = jsTrim(text ?: "")
        if (t.isEmpty()) return
        lastInputWasText = true
        busy = true
        try {
            if (pending != null) {
                val yes = js("^(y|yes|yeah|correct|right)$", true).test(t)
                val no = js("^(n|no|nope|wrong)$", true).test(t)
                if (yes) { acceptReadBack(); return }
                if (no) { rejectReadBack(); return }
                // As on the spoken path: a command still wins over the read-back.
                val cmd = localCommand(t)
                if (cmd != null) { runCommand(cmd); return }
                reask(ports.say.table("REASK")["yesno"]!!)
                return
            }

            // While naming a field to correct, the words are a field name, not
            // a navigation command.
            if (inCorrectionPrompt()) { handleFieldName(t); return }

            handleTypedDirect(t)
        } finally {
            busy = false
        }
    }

    /** A typed answer: parsed locally, or taken as written for free text. */
    private suspend fun handleTypedDirect(text: String) {
        val cmd = localCommand(text)
        if (cmd != null) { runCommand(cmd); return }

        if (pending == null && namesSomethingToDelete(text)) {
            deleteMidInterview(text)
            return
        }

        val q = pending?.question ?: engine!!.current()
        if (q == null) return

        if (pending != null) {
            val yes = js("^(y|yes|yeah|correct|right)$", true).test(text)
            val no = js("^(n|no|nope|wrong)$", true).test(text)
            if (yes) { acceptReadBack(); return }
            if (no) { rejectReadBack(); return }
            reask(ports.say.table("REASK")["yesno"]!!)
            return
        }

        // Through the local parser first, the same way a spoken answer goes.
        // Free text is the exception: `typed` keeps it exactly as written.
        val local = parse(q, text, typed = true)
        val result = ports.normalize(
            local ?: ParsedValue(text, 1.0),
            q
        )
        if (result.command != null) { runCommand(result.command); return }
        if (result.needsClarification || result.value == null) {
            reask(result.clarifyPrompt ?: ports.say.table("REASK")["notRight"]!!)
            return
        }
        if (q.confirm) {
            pending = Pending(q, result.value)
            val readBack = "I have ${ports.speakable(result.value, q.type, q.options)}. Is that correct? Type yes or no."
            questionTextContent = readBack
            hintTextContent = ACCEPT_HINT
            ports.announce(readBack, false)
            awaitSpeakSegments(listOf(readBack))
            emit()
            resumeListening()
            return
        }
        commit(result.value)
    }

    // -- commands -----------------------------------------------------------------

    private val KEEPS_CORRECTION = setOf("repeat", "help", "where", "readback", "save_quit")

    suspend fun runCommand(cmd: String) {
        if (cmd == "repeat" && readBackOpen()) {
            ports.announce(lastSpoken, false)
            awaitSpeakSegments(if (lastSegments.isNotEmpty()) lastSegments else listOf(lastSpoken))
            resumeListening()
            return
        }

        pending = null

        if (correcting != null && (cmd == "back" || cmd == "skip")) {
            returnToReview(ports.say.text("UNCHANGED"))
            return
        }
        if ((correcting != null || inCorrectionPrompt()) && !KEEPS_CORRECTION.contains(cmd)) {
            clearCorrectionState()
        }

        when (cmd) {
            "repeat" -> {
                ports.announce(lastSpoken, false)
                awaitSpeakSegments(if (lastSegments.isNotEmpty()) lastSegments else listOf(lastSpoken))
                if (mode == "handsfree") queueListen()
            }
            "back" -> {
                engine!!.back()
                saveSession()
                if (adding != null && !stillAdding()) { finishAddition(); return }
                askCurrent(prefix = ports.say.text("GOING_BACK"))
            }
            "skip" -> {
                engine!!.skip()
                saveSession()
                if (adding != null && !stillAdding()) { finishAddition(); return }
                askCurrent()
            }
            "where" -> {
                val p = engine!!.progress()
                val left = ports.formatTimeRemaining(p.secondsRemaining)
                val where = if (p.sectionCount != null)
                    "You are in section ${p.sectionNumber} of ${p.sectionCount}, ${p.sectionTitle}."
                else "You are at the start, choosing which form to fill out."
                val msg = "$where About ${p.percent} percent done" +
                    (if (left != null) ", $left left at the pace you have been going." else ".")
                ports.announce(msg, true)
                ports.speech.speak(msg, interrupt = false)
                if (mode == "handsfree") queueListen()
            }
            "readback" -> {
                ports.onReadBack(engine!!.answers())
                if (mode == "handsfree") queueListen()
            }
            "correct" -> askWhichField()
            "save_quit" -> {
                if (saveSession()) {
                    ports.store.flush()
                    ports.speech.speak(ports.say.text("SAVED"), interrupt = false)
                    statusText = "Saved, encrypted with your PIN. Your place is kept on this device."
                    emit()
                } else {
                    val msg = "Nothing is being saved, because no PIN was set when you started. " +
                        "If you close this page, your answers will be lost."
                    statusText = msg
                    ports.announce(msg, true)
                    ports.speech.speak(msg, interrupt = false)
                }
            }
            "restart" -> {
                engine!!.reset()
                ports.store.clearState()
                withheld = mutableListOf()
                ports.speech.speak(ports.say.text("STARTING_OVER"), interrupt = false)
                askCurrent(announceSection = true)
            }
            "clear_data" -> clearEverything()
            "finish" -> awaitFinishInterview()
            "help" -> {
                ports.speech.speak(ports.say.text("HELP"), interrupt = false)
                if (mode == "handsfree") queueListen()
            }
        }
    }

    // -- correction flow --------------------------------------------------------

    private fun inCorrectionPrompt(): Boolean =
        awaitingFieldName || choosingItem != null || confirmingDelete != null

    private fun clearCorrectionState() {
        correcting?.let { engine?.restoreCursor(it.restore) }
        correcting = null
        adding = null
        choosing = null
        choosingItem = null
        confirmingDelete = null
        awaitingFieldName = false
        resumeAfterPrompt = false
        pending = null
    }

    suspend fun askWhichField() {
        clearCorrectionState()
        awaitingFieldName = true

        sectionLabel = "Changing an answer"
        val msg = ports.say.text("WHICH_FIELD")
        questionTextContent = "Which answer would you like to change?"
        hintTextContent = "Name a field, such as \"my date of birth\" or \"the first job's employer\". " +
            "To put a new entry on a list, say \"add another condition\". " +
            "To delete a whole entry, say \"remove the second provider\"."
        lastSpoken = msg
        ports.announce(msg, false)
        ports.speech.speak(msg, interrupt = false)
        emit()
        resumeListening()
    }

    /** The user named a field (or answered a disambiguation question). */
    private suspend fun handleFieldName(text: String) {
        if (confirmingDelete != null) {
            handleDeleteConfirmation(text)
            return
        }

        if (js("^(never ?mind|cancel|nothing|stop|go back|back|done|no)\\b", true).test(jsTrim(text))) {
            returnToReview("No changes made.")
            return
        }

        // Answering "which one did you want to delete?"
        if (choosingItem != null) {
            val picked = pickItem(text, choosingItem!!.candidates)
            if (picked == null) {
                sayAndListen("I did not catch which one. " + itemOptions(choosingItem!!))
                return
            }
            val loopId = choosingItem!!.loopId
            choosingItem = null
            confirmDelete(loopId, picked)
            return
        }

        // Answering "did you mean A or B?"
        if (choosing != null) {
            val picked = ports.correct.resolveChoice(text, choosing)
            if (picked == null) {
                sayAndListen("I did not catch which one. " + optionsSentence(choosing!!))
                return
            }
            choosing = null
            beginCorrection(picked)
            return
        }

        // "Remove that last provider" deletes a whole item; "change the
        // provider's phone" edits one field.
        if (ports.correct.isDeletionPhrase(text)) { beginDeletion(text); return }

        // "Add another condition" grows the list.
        if (ports.correct.isAdditionPhrase(text)) {
            val add = ports.correct.resolveAddition(text, engine!!.answers())
            if (add !is Correct.AdditionResult.None) { beginAddition(add); return }
        }

        val result = ports.correct.resolveTarget(text, engine!!.answers())

        if (result is Correct.Resolution.Ok) { beginCorrection(result.target); return }

        if (result is Correct.Resolution.Ambiguous) {
            choosing = result.candidates
            sayAndListen("I found more than one answer like that. ${optionsSentence(result.candidates)}")
            return
        }

        sayAndListen("I could not find an answer by that name. " +
            "You can name it the way I asked it, for example, my date of birth, " +
            "or say never mind to go back.")
    }

    private fun optionsSentence(candidates: List<Target>): String {
        val list = candidates.mapIndexed { i, c -> "${i + 1}. ${ports.correct.describeTarget(c)}" }.joinToString(". ")
        return "Did you mean: $list. Say the number, or the name."
    }

    // -- adding a loop entry ------------------------------------------------------

    private suspend fun beginAddition(add: Correct.AdditionResult) {
        when (add) {
            is Correct.AdditionResult.Ambiguous -> {
                val names = add.candidates.map { it.second }
                sayAndListen("I can add to more than one list. Did you mean a " +
                    "${names.joinToString(", or a ")}? Say which one, or say never mind to go back.")
                return
            }
            is Correct.AdditionResult.Full -> {
                sayAndListen("That is as many ${add.itemLabel} entries as I can take. " +
                    "You can change one of them instead, or say never mind to go back.")
                return
            }
            is Correct.AdditionResult.None -> return
            is Correct.AdditionResult.Ok -> {
                val loopId = add.loopId
                val itemLabel = add.itemLabel
                val nextNumber = add.nextNumber
                if (engine!!.jumpTo(loopId) == null) {
                    sayAndListen("I could not open that list. Try naming a different one, or say never mind.")
                    return
                }
                val q = engine!!.submit(true)
                if (q == null || q.loopId != loopId || q.loopPhase != "field") {
                    sayAndListen("I could not start a new $itemLabel. " +
                        "Try naming a different one, or say never mind.")
                    return
                }

                awaitingFieldName = false
                choosing = null
                adding = Adding(loopId, itemLabel, startCount = nextNumber - 1)
                saveSession()

                if ((q.itemNumber ?: 0) > 1) {
                    askCurrent()
                } else {
                    askCurrent(prefix = "Adding a new $itemLabel.")
                }
            }
        }
    }

    private suspend fun finishAddition() {
        val a = adding!!
        val loopId = a.loopId
        val itemLabel = a.itemLabel
        val startCount = a.startCount
        val added = ((engine!!.answers()[loopId] as? Json.Arr)?.items?.size ?: 0) - startCount
        adding = null
        saveSession()
        returnToReview(
            when {
                added == 1 -> "I added $itemLabel ${startCount + 1}."
                added > 1 -> "I added $added entries."
                else -> "No $itemLabel was added."
            }
        )
    }

    // -- deleting a loop entry -------------------------------------------------------

    private fun namesSomethingToDelete(text: String): Boolean {
        if (!ports.correct.isDeletionPhrase(text)) return false
        return ports.correct.resolveDeletion(text, engine!!.answers()) !is Correct.DeletionResult.None
    }

    private suspend fun deleteMidInterview(text: String) {
        if (correcting != null) clearCorrectionState()
        resumeAfterPrompt = true
        beginDeletion(text)
    }

    private suspend fun beginDeletion(text: String) {
        val r = ports.correct.resolveDeletion(text, engine!!.answers())

        when (r) {
            is Correct.DeletionResult.Ok -> {
                val item = Correct.ItemDescription(r.loopIndex, r.number, r.itemLabel, r.title)
                confirmDelete(r.loopId, item)
                return
            }
            is Correct.DeletionResult.Empty -> {
                sayAndListen("There is no ${r.itemLabel} recorded to remove. " +
                    "You can name something else, or say never mind to go back.")
                return
            }
            is Correct.DeletionResult.Ambiguous -> {
                choosingItem = ChoosingItem(r.loopId, r.itemLabel, r.candidates)
                sayAndListen("Which ${r.itemLabel} should I remove? ${itemOptions(choosingItem!!)}")
                return
            }
            is Correct.DeletionResult.None -> {}
        }

        sayAndListen("I could not tell what to remove. You can say, for example, " +
            "remove the second provider, or delete that last job. Say never mind to go back.")
    }

    private fun itemOptions(c: ChoosingItem): String {
        val list = c.candidates.map { ports.correct.describeItem(it) }.joinToString(". ")
        return "$list. Say the number, or the name."
    }

    private fun pickItem(text: String, candidates: List<Correct.ItemDescription>): Correct.ItemDescription? {
        val targets = candidates.map { c ->
            Target(
                id = "__item_${c.index}",
                type = "text",
                options = null,
                prompt = "${c.itemLabel} ${c.number}",
                label = c.title ?: "${c.itemLabel} ${c.number}",
                section = "",
                sectionTitle = ""
            )
        }
        val picked = ports.correct.resolveChoice(text, targets) ?: return null
        val index = targets.indexOf(picked)
        return if (index >= 0) candidates.getOrNull(index) else null
    }

    private suspend fun confirmDelete(loopId: String, item: Correct.ItemDescription) {
        choosingItem = null
        confirmingDelete = ConfirmingDelete(loopId, item)

        val what = ports.correct.describeItem(item)
        val msg = "Remove $what? This erases every answer recorded for that " +
            "${item.itemLabel}, and I cannot bring it back. Say yes to remove it, or no to keep it."
        questionTextContent = "Remove $what?"
        hintTextContent = "Say yes to remove it, or no to keep it."
        sayAndListen(msg)
    }

    private suspend fun handleDeleteConfirmation(text: String) {
        val s = jsTrim(text)
        val yes = js("^(y|yes|yeah|yep|correct|right|do it|remove it|delete it)\\b", true).test(s)
        val no = js("^(n|no|nope|nah|keep it|cancel|never ?mind|stop)\\b", true).test(s)

        if (!yes && !no) {
            sayAndListen("Please say yes to remove it, or no to keep it.")
            return
        }

        val c = confirmingDelete!!
        confirmingDelete = null

        if (no) {
            returnToReview("I kept ${ports.correct.describeItem(c.item)}.")
            return
        }

        val removed = engine!!.removeItem(c.loopId, c.item.index)
        saveSession()
        returnToReview(
            if (removed) "I removed ${ports.correct.describeItem(c.item)}."
            else "That entry could not be removed."
        )
    }

    // -- correcting an answer ---------------------------------------------------------

    private suspend fun beginCorrection(target: Target) {
        val restore = engine!!.cursorSnapshot()
        val q = engine!!.jumpTo(target.id, target.loopIndex ?: 0, target.loopId)
        if (q == null) {
            sayAndListen("I could not open that answer. Try naming a different one, or say never mind.")
            return
        }

        awaitingFieldName = false
        correcting = Correction(target, q, restore)
        pending = null

        val current = target.value
        val heard = if (current == null || current == "")
            "${ports.correct.describeTarget(target)} is blank right now."
        else "Right now ${ports.correct.describeTarget(target)} is ${ports.speakable(current, target.type, target.options)}."

        askCurrent(prefix = "$heard What should it be instead?")
    }

    private suspend fun finishCorrection(value: Any?) {
        val c = correcting!!
        val t = c.target
        val restore = c.restore
        val ok = engine!!.setAnswer(t.id, value, t.loopId, t.loopIndex ?: 0)
        engine!!.restoreCursor(restore)
        correcting = null
        pending = null

        if (ok && t.id == "forms" && t.loopId == null) {
            val next = engine!!.rewalk()
            saveSession()
            if (next != null) {
                clearCorrectionState()
                ports.speech.speak(ports.say.text("FORMS_CHANGED"), interrupt = false)
                askCurrent(announceSection = true)
                return
            }
        }

        saveSession()

        val what = ports.correct.describeTarget(t)
        returnToReview(
            if (ok) "${titleCase(what)} is now ${ports.speakable(value, t.type, t.options)}."
            else "That answer could not be changed.",
            about = t
        )
    }

    private suspend fun returnToReview(note: String, about: Target? = null) {
        if (resumeAfterPrompt) {
            clearCorrectionState()
            saveSession()
            askCurrent(prefix = "$note Back to your question.")
            return
        }
        if (askNextWithheld(note)) return

        clearCorrectionState()
        panel = "review"

        val missing = engine!!.missingRequired()
        val tail = if (missing.isNotEmpty())
            " ${missing.size} required ${if (missing.size == 1) "answer is" else "answers are"} still blank."
        else ""
        val msg = "$note$tail You can change another answer, or download your forms."
        reviewIntro = msg
        ports.announce(msg, true)
        ports.speech.speak(msg, interrupt = false)
        emit(focus = "fix")
    }

    private suspend fun sayAndListen(msg: String) {
        lastSpoken = msg
        ports.announce(msg, true)
        ports.speech.speak(msg, interrupt = false)
        resumeListening()
    }

    // -- finishing ---------------------------------------------------------------------

    suspend fun finishInterview() = awaitFinishInterview()

    private suspend fun awaitFinishInterview() {
        if (askNextWithheld()) return
        saveSession()
        panel = "review"
        ports.audio.earcon("done")

        val missing = engine!!.missingRequired()
        val intro = if (missing.isNotEmpty()) {
            "Your answers are ready. ${missing.size} required ${if (missing.size == 1) "answer is" else "answers are"} still blank: " +
                missing.mapNotNull { it.prompt }.joinToString(" ") +
                " You can change an answer, or download your forms as they are."
        } else ports.say.text("ALL_DONE")

        reviewIntro = intro
        ports.announce(intro, true)
        awaitSpeakSegments(listOf(intro, ports.say.text("DOWNLOAD_HINT")))
        emit(focus = "download")
    }

    /**
     * Ask for the next sensitive answer that a resumed session did not have.
     * Asked as a correction — written in place, then back to the review.
     */
    private suspend fun askNextWithheld(note: String = ""): Boolean {
        while (withheld.isNotEmpty()) {
            val w = withheld.removeAt(0)
            if (isAnswered(fieldOf(w))) continue
            val target = ports.correct.buildTargets(engine!!.answers())
                .firstOrNull { t -> sameField(fieldOf(t), fieldOf(w)) }
            if (target == null) continue
            clearCorrectionState()
            val restore = engine!!.cursorSnapshot()
            val q = engine!!.jumpTo(target.id, target.loopIndex ?: 0, target.loopId)
            if (q == null) continue
            correcting = Correction(target, q, restore)
            panel = "interview"
            val why = if (w["idle"] === Json.True)
                "I cleared this while the page was not in use."
            else "This was not saved when you stopped last time, for your security."
            val which = if (target.loopId != null) " This one is for ${target.itemLabel} ${target.itemNumber}." else ""
            askCurrent(prefix = "${if (note.isNotEmpty()) "$note " else ""}$why$which")
            return true
        }
        return false
    }

    /** Fill the chosen forms. Returns the controller to the review screen. */
    suspend fun exportForms(ids: List<String>) {
        touchActivity()
        if (askNextWithheld("Before I fill in your forms, I need a number again.")) return
        val answers = engine!!.answers()
        try {
            ports.onExport(ids, answers)
            val erase = "When you have checked your forms, select Erase everything to remove your " +
                "answers from this computer. The downloaded forms stay in your downloads folder."
            val msg = "Downloaded ${ids.joinToString(" and ")}. $erase"
            statusText = msg
            ports.announce(msg, true)
            awaitSpeakSegments(listOf(
                if (ids.size > 1) ports.say.text("BOTH_DOWNLOADED") else ports.say.text("DOWNLOADED"),
                erase
            ))
            emit()
        } catch (e: Exception) {
            val msg = "The PDF could not be created. Your answers are safe — try saving them as a file instead."
            statusText = msg
            ports.announce(msg, true)
        }
    }

    suspend fun clearEverything() {
        ports.store.clearState()
        ports.store.forgetKey()
        withheld = mutableListOf()
        ports.timers.clearTimeout(idleTimer)
        engine!!.reset()
        ports.audio.releaseMic()
        val msg = "Everything has been erased from this device."
        ports.announce(msg, true)
        ports.speech.speak(msg, interrupt = false)
        statusText = msg
        panel = "setup"
        emit()
    }

    // -- errors --------------------------------------------------------------------

    private suspend fun handleSttError(err: SttError) {
        ports.audio.earcon("error")
        val table = ports.say.table("ERRORS")
        val msg = table[err.kind] ?: table["unknown"]!!
        statusText = msg
        ports.announce(msg, true)
        ports.speech.speak(msg, interrupt = false)
        if (mode == "handsfree") queueListen()
    }

    fun disableVoice() {
        voiceDisabled = true
        mode = "text"
        lastInputWasText = true
        emit()
    }

    // -- the idle lock -----------------------------------------------------------------

    private suspend fun lockSensitive() {
        val held = ports.store.sensitiveAnswers(engine!!.getState())
        val midAnswer = isSensitive(displayQuestion()) && readBackOpen()
        if (held.isEmpty() && !midAnswer) return

        val dropped = held.map { h -> withheldShape(h) }.toMutableList()
        if (midAnswer && correcting != null) dropped.add(withheldShape(fieldOf(correcting!!.target)))
        for (a in held) {
            val id = a["id"]?.asString() ?: continue
            engine!!.setAnswer(
                id, null, a["loopId"]?.asString(),
                (a["loopIndex"] as? Json.Num)?.value?.toInt() ?: 0
            )
        }
        for (w in dropped) {
            if (withheld.none { x -> sameField(fieldOf(x), fieldOf(w)) }) {
                withheld.add(Json.Obj(LinkedHashMap(w.entries)).also { o ->
                    o["idle"] = Json.True
                })
            }
        }
        ports.store.markWithheld(dropped)
        saveSession()
        statusText = ""

        val msg = "For your security, I cleared your Social Security and bank numbers from this page " +
            "after ${Math.round(IDLE_LOCK_MS / 60000.0)} minutes without activity. " +
            "I will ask for them again before your forms are ready."

        if (panel == "review") {
            reviewIntro = msg
            ports.announce(msg, true)
            ports.speech.speak(msg, interrupt = false)
            emit()
            return
        }
        if (midAnswer) {
            if (correcting != null) { returnToReview(msg); return }
            pending = null
            askCurrent(prefix = msg)
            return
        }
        ports.announce(msg, true)
        ports.speech.speak(msg, interrupt = false)
        // The last snapshot the screen holds carries the answers, numbers
        // included; replace it, or the cleared number lives on in the UI's copy.
        emit()
    }

    // -- keys ------------------------------------------------------------------------

    /**
     * Returns a Json result object, or null: {accepted}, {rejected},
     * {startTalk}, {leaveTextLane}, {cancelled}, {useTextLane}, {ranCommand}.
     */
    suspend fun onKey(code: String, typing: Boolean = false): Json.Obj? {
        touchActivity()
        if (panel != "interview") return null

        // While an answer is being read back the space bar keeps it.
        if (!typing && readBackOpen()) {
            if (code == "Space" || code == "Enter") {
                acceptReadBack()
                return Json.Obj().also { it["accepted"] = Json.True }
            }
            if (code == "KeyN" || code == "Escape") {
                rejectReadBack()
                return Json.Obj().also { it["rejected"] = Json.True }
            }
        }

        if (code == "Space" && !typing && !voiceDisabled) {
            return Json.Obj().also { it["startTalk"] = Json.True }
        }
        if (typing) {
            if (code == "Escape") return Json.Obj().also { it["leaveTextLane"] = Json.True }
            return null
        }
        if (code == "Escape" && ports.audio.isRecording()) {
            ports.audio.cancelRecording()
            statusText = "Cancelled."
            ports.announce("Cancelled", true)
            emit()
            return Json.Obj().also { it["cancelled"] = Json.True }
        }
        if (code == "KeyT") return Json.Obj().also { it["useTextLane"] = Json.True }
        if (code == "KeyH" && !voiceDisabled) {
            mode = if (mode == "handsfree") "voice" else "handsfree"
            ports.announce(if (mode == "handsfree") "Hands free mode on" else "Hands free mode off", true)
            if (mode == "handsfree") queueListen()
            return null
        }
        val cmd = KEY_COMMANDS[code]
        if (cmd != null) { runCommand(cmd); return Json.Obj().also { it["ranCommand"] = Json.True } }
        return null
    }

    /**
     * Start a correction. Missing required answers come first, since those
     * block a complete form; otherwise ask which answer to change.
     */
    suspend fun startReview() {
        val missing = engine!!.missingRequired()
        val target = missing.getOrNull(0)
        if (target != null) {
            val landed = engine!!.jumpTo(target.id, target.loopIndex, target.loopId)
            if (landed != null) {
                panel = "interview"
                clearCorrectionState()
                askCurrent(prefix = ports.say.text("FILL_IN_MISSING"))
                return
            }
        }
        askWhichField()
    }

    // -- UI snapshot -------------------------------------------------------------

    private fun emit(focus: String? = null) {
        ports.onState(snapshot(focus))
    }

    private fun snapshot(focus: String? = null): Json.Obj {
        val q = displayQuestion()
        val progress = engine!!.progress()
        val progressJson = Json.Obj().also { o ->
            o["section"] = progress.section?.let { Json.Str(it) } ?: Json.Null
            o["sectionTitle"] = progress.sectionTitle?.let { Json.Str(it) } ?: Json.Null
            o["sectionNumber"] = progress.sectionNumber?.let { Json.Num(it.toDouble()) } ?: Json.Null
            o["sectionCount"] = progress.sectionCount?.let { Json.Num(it.toDouble()) } ?: Json.Null
            o["answered"] = Json.Num(progress.answered.toDouble())
            o["remaining"] = Json.Num(progress.remaining.toDouble())
            o["total"] = Json.Num(progress.total.toDouble())
            o["percent"] = Json.Num(progress.percent.toDouble())
            o["rawPercent"] = Json.Num(progress.rawPercent.toDouble())
            o["secondsRemaining"] = progress.secondsRemaining?.let { Json.Num(it.toDouble()) } ?: Json.Null
        }
        return Json.Obj().also { o ->
            o["panel"] = Json.Str(panel)
            o["sectionLabel"] = Json.Str(sectionLabel)
            o["questionText"] = Json.Str(if (q != null) questionTextContent else "")
            o["hintText"] = Json.Str(
                if (readBackOpen() || panel == "review") hintTextContent
                else (q?.hint ?: hintTextContent)
            )
            o["statusText"] = Json.Str(statusText)
            o["readbackOpen"] = Json.bool(readBackOpen())
            o["inputMasked"] = Json.bool(!revealSensitive && isSensitive(q))
            o["voiceDisabled"] = Json.bool(voiceDisabled)
            o["progressText"] = Json.Str(progressText())
            o["reviewIntro"] = Json.Str(reviewIntro)
            o["answers"] = engine!!.answers()
            o["revealSensitive"] = Json.bool(revealSensitive)
            o["lane"] = Json.Str(if (lastInputWasText || mode == "text") "text" else "voice")
            o["focus"] = Json.Str(focus ?: (if (panel == "review") "fix" else ""))
            o["section"] = progressJson
            o["missing"] = Json.Str(engine!!.missingRequired().mapNotNull { it.prompt }.joinToString(" | "))
        }
    }

    fun snapshot(): Json.Obj = snapshot(focus = null)

    fun engineState(): Json.Obj = engine!!.getState(correcting?.restore)

    fun touch() = touchActivity()

    fun isRecording(): Boolean = ports.audio.isRecording()

    fun voiceDisabled(): Boolean = voiceDisabled

    fun mode(): String = mode

    fun setConfirmEachAnswer(v: Boolean) { confirmEachAnswer = v }

    fun setRevealSensitive(v: Boolean) { revealSensitive = v; emit() }
}

internal fun titleCase(s: String): String =
    if (s.isEmpty()) s else s.first().uppercaseChar() + s.substring(1)
