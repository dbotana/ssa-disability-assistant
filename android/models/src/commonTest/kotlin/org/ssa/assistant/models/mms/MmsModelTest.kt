package org.ssa.assistant.models.mms

import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.Question
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.model.cleanTranscript
import org.ssa.assistant.core.parse.Parse
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.core.validate.Validate
import org.ssa.assistant.models.onnx.OnnxSession
import org.ssa.assistant.models.onnx.openOnnxSession
import org.ssa.assistant.models.testing.MmsGolden
import org.ssa.assistant.models.testing.MmsGoldenGraph
import org.ssa.assistant.models.testing.WhisperGolden
import org.ssa.assistant.models.testing.mmsDir
import org.ssa.assistant.models.testing.mmsGraph
import org.ssa.assistant.models.testing.mmsGraphs
import org.ssa.assistant.models.testing.parseSha256Sums
import org.ssa.assistant.models.testing.peakResidentBytes
import org.ssa.assistant.models.testing.readFileBytes
import org.ssa.assistant.models.testing.readMmsClip
import org.ssa.assistant.models.testing.readTestBytes
import org.ssa.assistant.models.testing.runtimeName
import org.ssa.assistant.models.testing.settings
import org.ssa.assistant.models.testing.goldenWav2Vec2Features
import org.ssa.assistant.models.testing.sha256File
import org.ssa.assistant.models.testing.strictTokenIds
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.TimeSource

/**
 * The real MMS graphs on all 9 clips, one `@Test` per graph so that each opens only its own
 * graph and closes it before it returns: at most one ONNX session is open (Run 9, "one model
 * process at a time"). `MMS_GRAPHS` picks the graphs and `MMS_GRAPH` the variant (`fp32` or
 * `q8`). Only the host JVM with fp32 must match the golden exactly; elsewhere the agreement is
 * counted and printed (Decision 1).
 */
class MmsModelTest {
    @Test
    fun asrLin() = runAsr("lin")

    @Test
    fun asrFra() = runAsr("fra")

    @Test
    fun asrEng() = runAsr("eng")

    @Test
    fun lid() {
        if ("lid" !in mmsGraphs()) {
            println("MMS[$runtimeName] lid: not in MMS_GRAPHS, not run")
            return
        }
        val graph = MmsGolden.graph("lid")
        if (graph == null) {
            println("MMS[$runtimeName] lid: the golden has no graphs.lid (no LID export), not run")
            return
        }
        val variant = mmsGraph()
        val strict = strictTokenIds && variant == "fp32"
        val folder = "${mmsDir()}/${graph.folder}"
        checkPins(graph, folder, variant, asr = false)

        val features = Wav2Vec2Features.fromJson(readFileBytes("$folder/preprocessor_config.json").decodeToString())
        assertEquals(goldenWav2Vec2Features().settings(), features.settings(), "lid preprocessor_config.json against features.config")
        val labels = MmsConfig.labels(readFileBytes("$folder/config.json").decodeToString())
        assertEquals(graph.labels, labels, "lid labels")
        assertEquals(graph.outputDim, labels.size, "lid label count")
        val candidates = graph.candidates ?: throw AssertionError("graphs.lid has no candidates")
        assertEquals(mapOf("lin" to "ln", "fra" to "fr", "eng" to "en"), candidates, "lid candidates")
        for ((label, index) in graph.candidateIndices ?: throw AssertionError("graphs.lid has no candidateIndices")) {
            assertEquals(index, labels.indexOf(label), "lid index of $label")
        }

        val session = openTimed(graph, folder, variant)
        val failures = mutableListOf<String>()
        try {
            assertEquals(graph.inputNames, session.inputNames, "lid input names")
            assertEquals(graph.outputNames, session.outputNames, "lid output names")
            val languageId = MmsLanguageId(
                open = { session },
                labels = labels,
                features = features,
                minProbability = 0.0,
                windowSamples = MmsGolden.lidWindowSamples,
                candidates = candidates,
            )
            var topRight = 0
            var largest = 0.0
            for (clip in MmsGolden.clips) {
                val samples = readMmsClip(clip)
                val result = languageId.detectDetailed(samples)
                assertEquals(graph.outputDim, result.logits.size, "lid output dim")
                val reference = MmsGolden.lid(clip.name) ?: throw AssertionError("the golden has no lid.${clip.name}")
                var clipLargest = 0.0
                for (i in result.logits.indices) {
                    clipLargest = maxOf(clipLargest, abs(result.logits[i].toDouble() - reference.logits[i].toDouble()))
                }
                largest = maxOf(largest, clipLargest)
                val topMatch = result.topLabel == reference.top
                if (topMatch) topRight++
                if (strict && !topMatch) failures += "lid ${clip.name}: top label ${result.topLabel}, reference ${reference.top}"
                val probabilities = candidates.keys.joinToString(", ") { label ->
                    "p($label) ${result.probabilities[label]} (reference ${reference.probabilities[label]})"
                }
                println(
                    "MMS[$runtimeName] lid ${clip.name}: features ${result.features.inWholeMilliseconds} ms, " +
                        "model ${result.model.inWholeMilliseconds} ms, ${result.samples} samples, " +
                        "top ${result.topLabel} (reference ${reference.top}), top label match: $topMatch, " +
                        "$probabilities, largest |logit - golden| $clipLargest, " +
                        "best candidate ${result.bestLabel} (${result.code})",
                )
            }
            if (strict && largest > LOGIT_BOUND) failures += "lid: largest logit difference $largest exceeds $LOGIT_BOUND"
            println(
                "MMS[$runtimeName] lid ($variant): top label matches the reference: $topRight/${MmsGolden.clips.size}; " +
                    "largest logit difference $largest",
            )
            printPeak("lid")
        } finally {
            session.close()
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    private fun runAsr(key: String) {
        if (key !in mmsGraphs()) {
            println("MMS[$runtimeName] $key: not in MMS_GRAPHS, not run")
            return
        }
        val graph = MmsGolden.graph(key) ?: throw AssertionError("the golden has no graphs.$key")
        val code = graph.code ?: throw AssertionError("graphs.$key has no code")
        val variant = mmsGraph()
        val strict = strictTokenIds && variant == "fp32"
        val folder = "${mmsDir()}/${graph.folder}"
        checkPins(graph, folder, variant, asr = true)

        val features = Wav2Vec2Features.fromJson(readFileBytes("$folder/preprocessor_config.json").decodeToString())
        assertEquals(goldenWav2Vec2Features().settings(), features.settings(), "$key preprocessor_config.json against features.config")
        val tokenizer = CtcTokenizer.fromJson(
            readFileBytes("$folder/vocab.json").decodeToString(),
            readFileBytes("$folder/tokenizer_config.json").decodeToString(),
        )
        assertEquals(graph.targetLang, tokenizer.targetLang, "$key target_lang")
        assertEquals(graph.outputDim, MmsConfig.vocabSize(readFileBytes("$folder/config.json").decodeToString()), "$key vocab_size")

        val expectedRoot = JsonParser.parse(readTestBytes("fixtures/speech/expected.json").decodeToString()).asObject()
            ?: throw IllegalStateException("expected.json is not a JSON object")
        val nowParts = WhisperGolden.now.take(10).split("-").map { it.toInt() }
        val now = CivilDate(nowParts[0], nowParts[1], nowParts[2])

        val session = openTimed(graph, folder, variant)
        val failures = mutableListOf<String>()
        try {
            assertEquals(graph.inputNames, session.inputNames, "$key input names")
            assertEquals(graph.outputNames, session.outputNames, "$key output names")
            val transcriber = MmsTranscriber(listOf(MmsGraph(code, { session }, tokenizer)), features)
            var framesRight = 0
            var textRight = 0
            var keptRight = 0
            var checkedDim = false
            for (clip in MmsGolden.clips) {
                val samples = readMmsClip(clip)
                var outputDim = -1L
                val result = transcriber.transcribeDetailed(samples, code) { logits -> outputDim = logits.shape[2] }
                if (!checkedDim) {
                    assertEquals(graph.outputDim.toLong(), outputDim, "$key output dim")
                    checkedDim = true
                }
                val reference = MmsGolden.asr(key, clip.name)
                val ours = result.frameIds.toList()
                var firstDiff = -1
                for (i in 0 until minOf(ours.size, reference.frameIds.size)) {
                    if (ours[i] != reference.frameIds[i]) {
                        firstDiff = i
                        break
                    }
                }
                if (firstDiff < 0 && ours.size != reference.frameIds.size) firstDiff = minOf(ours.size, reference.frameIds.size)
                val framesMatch = firstDiff < 0
                val textMatch = result.text == reference.text
                if (framesMatch) framesRight++
                if (textMatch) textRight++
                val detail = if (framesMatch) {
                    ""
                } else {
                    " [first differing frame $firstDiff: reference ${reference.frameIds.getOrNull(firstDiff)}, " +
                        "ours ${ours.getOrNull(firstDiff)}, golden gap ${reference.gaps.getOrNull(firstDiff)}]"
                }
                if (strict && !framesMatch) failures += "$key ${clip.name}: frame ids differ from the reference$detail"
                if (strict && !textMatch) failures += "$key ${clip.name}: text \"${result.text}\", reference \"${reference.text}\""
                println(
                    "MMS[$runtimeName] $key ${clip.name}: features ${result.features.inWholeMilliseconds} ms, " +
                        "model ${result.model.inWholeMilliseconds} ms, decode ${result.decode.inWholeMilliseconds} ms, " +
                        "${result.frameIds.size} frames, frame ids match reference: $framesMatch$detail, " +
                        "text match: $textMatch, text \"${result.text}\"",
                )

                if (key == "eng") {
                    // As WhisperModelTest keeps a value (and tools/stt-eval.mjs), never required:
                    // Whisper is the English model.
                    val heard = cleanTranscript(result.text)
                    val expectedEntry = expectedRoot[clip.name]?.asObject()
                        ?: throw IllegalStateException("expected.json has no entry for ${clip.name}")
                    val type = expectedEntry["type"]?.asString()
                        ?: throw IllegalStateException("expected.json has no type for ${clip.name}")
                    val question = Question(id = clip.name, prompt = "", type = type, confirm = true)
                    val local = if (heard.isNotEmpty() && !TurnController.isEmptyTranscript(heard, 0.0)) {
                        Parse.parseLocal(question, heard, typed = false, now = now, lang = "en")
                    } else {
                        null
                    }
                    val value = local?.let { Validate.normalize(it, question) }
                        ?.takeIf { !it.needsClarification }
                        ?.value
                    val kept = Json.of(value)
                    val expectedValue = expectedEntry["value"] ?: Json.Null
                    if (kept.treeEquals(expectedValue)) keptRight++
                    println(
                        "MMS[$runtimeName] eng ${clip.name} kept: ${kept.writeJson()} (want ${expectedValue.writeJson()})",
                    )
                }
            }
            val count = MmsGolden.clips.size
            println(
                "MMS[$runtimeName] $key ($variant): frame ids match the reference: $framesRight/$count; " +
                    "text matches: $textRight/$count" + (if (key == "eng") "; kept values: $keptRight/$count" else ""),
            )
            printPeak(key)
        } finally {
            session.close()
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    /**
     * The folder's SHA256SUMS must be the golden's `graphs.<key>.files`, and every file this
     * variant reads is stream-hashed against its pin before the graph is opened (Decision 8).
     */
    private fun checkPins(graph: MmsGoldenGraph, folder: String, variant: String, asr: Boolean) {
        val sums = parseSha256Sums(readFileBytes("$folder/SHA256SUMS").decodeToString())
        assertEquals(graph.files, sums, "$folder/SHA256SUMS against the golden's graphs.${graph.key}.files")
        val needed = buildList {
            if (variant == "fp32") {
                add("model.onnx")
                add("model.onnx_data")
            } else {
                add("q8/model_quantized.onnx")
            }
            add("config.json")
            add("preprocessor_config.json")
            if (asr) {
                add("tokenizer_config.json")
                add("vocab.json")
            }
        }
        val start = TimeSource.Monotonic.markNow()
        for (name in needed) {
            val pin = graph.files[name] ?: throw AssertionError("graphs.${graph.key}.files has no $name")
            assertEquals(pin, sha256File("$folder/$name"), "$folder/$name does not match its pin")
        }
        println(
            "MMS[$runtimeName] ${graph.key} ($variant): ${needed.size} files match their pins " +
                "(hashed in ${start.elapsedNow().inWholeMilliseconds} ms)",
        )
    }

    private fun openTimed(graph: MmsGoldenGraph, folder: String, variant: String): OnnxSession {
        val path = if (variant == "fp32") "$folder/model.onnx" else "$folder/q8/model_quantized.onnx"
        val start = TimeSource.Monotonic.markNow()
        val session = openOnnxSession(path)
        println("MMS[$runtimeName] ${graph.key} ($variant) load: ${start.elapsedNow().inWholeMilliseconds} ms")
        return session
    }

    private fun printPeak(key: String) {
        val peak = peakResidentBytes()
        println(
            "MMS[$runtimeName] $key peak resident memory: " +
                (peak?.let { "$it bytes (${it / (1024 * 1024)} MiB)" } ?: "not measured on this runtime"),
        )
    }

    private companion object {
        /** Run 9 Step 3: on the host JVM with fp32 the LID logits are within 1e-3 of the golden. */
        const val LOGIT_BOUND = 1e-3
    }
}
