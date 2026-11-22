package org.ssa.assistant.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlin.test.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.readTestResource
import org.ssa.assistant.core.golden.runTestBlocking
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.parse.Correct
import org.ssa.assistant.core.parse.Parse
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.turn.TurnController

/**
 * Shared fake-port harness used by both TurnGoldenTest and AppControllerGoldenTest.
 * Provides a fixed clock, fake timers, recorded spoken/announced lines,
 * snapshots, exports, and the jsonOf helper.  The ports are held as a named
 * property so that callers can build a TurnController from the same ports.
 *
 * Move SCENARIO_EPOCH_MS and FAKE_TIMER_MS with it; subclasses may override
 * the fixed values if desired.
 */
open class TurnHarness(val schema: Schema, private val scope: CoroutineScope) {

    // -- fixed clock & fake timers -------------------------------------------

    val spoken = mutableListOf<String>()
    val announced = mutableListOf<String>()
    val recordSpoken = mutableListOf<String>()
    val recordAnnounced = mutableListOf<String>()
    var peak = 0.5
    var hadSpeech = true
    var durationMs = 1000
    var recording = false
    var savedWrote = 0
    var withheld = mutableListOf<String>()
    var nextTranscript = ""

    val snapshots = mutableListOf<Json.Obj>()
    val exports = mutableListOf<List<String>>()

    var nowMs: Long = SCENARIO_EPOCH_MS
    private val fake = LinkedHashMap<Long, Pair<Long, suspend () -> Unit>>()
    private var nextTimer = 1

    // -- TurnController with a named ports property -------------------------

    /** Subclasses must initialise this to a TurnController.Ports object before
     *  the turn field is accessed. */
    val turn: TurnController by lazy {
        TurnController(ports, schema)
    }

    /** Hold the ports as a named property so that AppControllerGoldenTest can
     *  construct its own TurnController from the same ports. */
    val ports: TurnController.Ports

    // -- timer operations ----------------------------------------------------

    val turn: TurnController get() = TurnController(ports, schema)

    /** Move the clock forward, running each fake timer that comes due, in order. */
    open suspend fun advance(ms: Long) {
        val target = nowMs + ms
        while (true) {
            // Copy the due timer's id, time and callback before deleting it.
            val next = fake.entries
                .filter { it.value.first <= target }
                .map { Triple(it.key, it.value.first, it.value.second) }
                .minByOrNull { it.second }
                ?: break
            fake.remove(next.first)
            nowMs = next.second
            scope.launch { next.third() }.join()
        }
        nowMs = target
    }

    /** Set the transcript for the current step. */
    open fun setTranscript(t: String) { nextTranscript = t }

    /** Set quiet mode for the hands-free path. */
    open fun setQuiet(q: Boolean) {
        hadSpeech = !q
        peak = if (q) 0.004 else 0.5
    }

    /** A saved session as store.js would hand it back: the answers walked
     *  to their first unanswered question, then redacted. */
    open fun savedSession(fixture: String?, answers: Map<String, Any?>): Pair<Json.Obj, List<Json.Obj>> {
        val base = if (fixture != null) {
            org.ssa.assistant.core.golden.fixture(fixture)
        } else Json.Obj()
        val merged = Json.Obj(LinkedHashMap(base.entries))
        answers.forEach { (k, v) -> merged[k] = jsonOf(v) }
        val saved = Json.Obj().also { it["answers"] = merged }
        val engine = Engine(schema, saved) { SCENARIO_EPOCH_MS / 1000.0 }
        return Sensitive.redact(schema, engine.getState())
    }

    companion object {
        const val SCENARIO_EPOCH_MS = 1_800_206_400_000L   // Date.UTC(2026, 8, 19, 12, 0, 0)
        private const val FAKE_TIMER_MS = 1000L

        /** Build a [Json] from any value (null, String, Double, Boolean, List, Map). */
        fun jsonOf(v: Any?): Json = when (v) {
            null -> Json.Null
            is String -> Json.Str(v)
            is Double -> Json.Num(v)
            is Boolean -> Json.bool(v)
            is List<*> -> Json.Arr(v.mapTo(mutableListOf()) { jsonOf(it) })
            is Map<*, *> -> Json.Obj(LinkedHashMap<String, Json>().also { m ->
                v.forEach { (k, vv) -> m[k.toString()] = jsonOf(vv) }
            })
            else -> Json.Str(v.toString())
        }
    }
}