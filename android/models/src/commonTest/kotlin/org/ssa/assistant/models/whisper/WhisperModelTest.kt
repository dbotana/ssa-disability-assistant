package org.ssa.assistant.models.whisper

import org.ssa.assistant.core.CivilDate
import org.ssa.assistant.core.Question
import org.ssa.assistant.core.model.cleanTranscript
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.treeEquals
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.parse.Parse
import org.ssa.assistant.core.turn.TurnController
import org.ssa.assistant.core.validate.Validate
import org.ssa.assistant.models.onnx.FloatTensor
import org.ssa.assistant.models.onnx.openOnnxSession
import org.ssa.assistant.models.testing.PinnedModel
import org.ssa.assistant.models.testing.peakResidentBytes
import org.ssa.assistant.models.testing.WhisperGolden
import org.ssa.assistant.models.testing.readTestBytes
import org.ssa.assistant.models.testing.readWav16k
import org.ssa.assistant.models.testing.runtimeName
import org.ssa.assistant.models.testing.sha256Hex
import org.ssa.assistant.models.testing.strictTokenIds
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.TimeSource

class WhisperModelTest {
    @Test
    fun runsThePinnedModelOnAllNineClips() {
        val dir = PinnedModel.dir
        val goldenFiles = WhisperGolden.obj(WhisperGolden.model, "files").entries
            .mapValues { (_, value) -> value.asString() ?: throw IllegalStateException("model file hash is not a string") }
        assertEquals(goldenFiles, PinnedModel.hashes())

        val config = WhisperConfig.fromJson(
            PinnedModel.text("config.json"),
            PinnedModel.text("generation_config.json"),
        )
        val decoding = WhisperGolden.decoding
        assertEquals(WhisperGolden.longs(decoding["prompt"]), config.prompt.map { it.toLong() })
        assertEquals(WhisperGolden.int(decoding, "decoderStartTokenId"), config.prompt.first())
        assertEquals(WhisperGolden.int(decoding, "noTimestampsTokenId"), config.prompt[1])
        assertEquals(WhisperGolden.int(decoding, "eosTokenId"), config.eosTokenId)
        assertEquals(WhisperGolden.int(decoding, "maxLength"), config.maxLength)
        assertEquals(WhisperGolden.longs(decoding["beginSuppressTokens"]), config.beginSuppressTokens.map { it.toLong() })

        val featureConfig = WhisperFeatures.fromJson(PinnedModel.text("preprocessor_config.json"))
        val goldenFeatureConfig = WhisperGolden.obj(WhisperGolden.features, "config")
        assertEquals(WhisperGolden.int(goldenFeatureConfig, "sampling_rate"), featureConfig.samplingRate)
        assertEquals(WhisperGolden.int(goldenFeatureConfig, "n_fft"), featureConfig.nFft)
        assertEquals(WhisperGolden.int(goldenFeatureConfig, "hop_length"), featureConfig.hopLength)
        assertEquals(WhisperGolden.int(goldenFeatureConfig, "n_samples"), featureConfig.nSamples)
        assertEquals(WhisperGolden.int(goldenFeatureConfig, "nb_max_frames"), featureConfig.nbMaxFrames)
        assertEquals(WhisperGolden.int(goldenFeatureConfig, "feature_size"), featureConfig.featureSize)

        val encoderStart = TimeSource.Monotonic.markNow()
        val encoder = openOnnxSession("$dir/onnx/encoder_model_quantized.onnx")
        val encoderLoad = encoderStart.elapsedNow().inWholeMilliseconds
        val decoderStart = TimeSource.Monotonic.markNow()
        val decoder = openOnnxSession("$dir/onnx/decoder_model_merged_quantized.onnx")
        val decoderLoad = decoderStart.elapsedNow().inWholeMilliseconds
        println("MODELS[$runtimeName] load: encoder $encoderLoad ms, decoder $decoderLoad ms")

        val goldenEncoder = WhisperGolden.obj(WhisperGolden.sessions, "model")
        assertEquals(WhisperGolden.strings(goldenEncoder["inputNames"]), encoder.inputNames)
        assertEquals(WhisperGolden.strings(goldenEncoder["outputNames"]), encoder.outputNames)
        val goldenDecoder = WhisperGolden.obj(WhisperGolden.sessions, "decoder_model_merged")
        assertEquals(WhisperGolden.strings(goldenDecoder["inputNames"]), decoder.inputNames)
        assertEquals(WhisperGolden.strings(goldenDecoder["outputNames"]), decoder.outputNames)

        val tokenizer = WhisperTokenizer.fromJson(
            PinnedModel.text("tokenizer.json"),
            PinnedModel.text("tokenizer_config.json"),
        )
        val transcriber = WhisperTranscriber(encoder, decoder, tokenizer, config, featureConfig)
        val expectedRoot = JsonParser.parse(
            readTestBytes("fixtures/speech/expected.json").decodeToString(),
        ).asObject() ?: throw IllegalStateException("expected.json is not a JSON object")
        val nowParts = WhisperGolden.now.take(10).split("-").map { it.toInt() }
        val now = CivilDate(nowParts[0], nowParts[1], nowParts[2])

        var keptRight = 0
        var idsRight = 0
        val failures = mutableListOf<String>()
        for (clip in WhisperGolden.clips) {
            val name = WhisperGolden.string(clip, "name")
            val file = WhisperGolden.string(clip, "file")
            val wav = readTestBytes("fixtures/speech/$file")
            assertEquals(WhisperGolden.string(clip, "sha256"), sha256Hex(wav), "$file SHA-256")
            val samples = readWav16k(wav)
            assertEquals(WhisperGolden.int(clip, "sampleCount"), samples.size, "$file sample count")

            val gaps = mutableMapOf<Int, Float>()
            val result = transcriber.transcribeDetailed(samples, "en") { position, scores ->
                gaps[position] = topGap(scores)
            }

            // Decision 9: the filler rule at peak 0.0 is the reference's rule.
            // None of the nine clips is punctuation-only, so that extra check
            // in isEmptyTranscript changes no kept value here.
            val heard = cleanTranscript(result.text)
            val expectedEntry = expectedRoot[name]?.asObject()
                ?: throw IllegalStateException("expected.json has no entry for $name")
            val type = expectedEntry["type"]?.asString()
                ?: throw IllegalStateException("expected.json has no type for $name")
            val question = Question(id = name, prompt = "", type = type, confirm = true)
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
            val goldenValue = clip["kept"] ?: Json.Null
            val keptMatches = kept.treeEquals(expectedValue) && kept.treeEquals(goldenValue)
            if (keptMatches) keptRight++

            val referenceIds = WhisperGolden.longs(clip["ids"])
            val actualIds = result.ids.map { it.toLong() }
            var tokenMatch = actualIds.size == referenceIds.size
            var firstDiff = -1
            if (tokenMatch) {
                for (i in referenceIds.indices) {
                    if (referenceIds[i] != actualIds[i]) {
                        tokenMatch = false
                        firstDiff = i
                        break
                    }
                }
            }
            if (tokenMatch) {
                idsRight++
            } else if (strictTokenIds) {
                if (firstDiff < 0) firstDiff = minOf(referenceIds.size, actualIds.size)
                val reference = referenceIds.getOrElse(firstDiff) { -1 }
                val ours = actualIds.getOrElse(firstDiff) { -1 }
                val gap = gaps[firstDiff] ?: Float.NaN
                failures += "$name: first differs at position $firstDiff " +
                    "(reference $reference, ours $ours); top-two logit gap there $gap"
            }

            println(
                "MODELS[$runtimeName] $name: features ${result.features.inWholeMilliseconds} ms, " +
                    "encoder ${result.encoder.inWholeMilliseconds} ms, " +
                    "decoder ${result.decoder.inWholeMilliseconds} ms, " +
                    "${result.ids.size} ids, ids match reference: $tokenMatch, " +
                    "kept ${kept.writeJson()} (want ${goldenValue.writeJson()})",
            )
        }

        val yes = WhisperGolden.clips.first { WhisperGolden.string(it, "name") == "yes" }
        val exactMatrix = WhisperGolden.floats(WhisperGolden.obj(yes, "features")["matrix"])
        val exactHidden = encoder.run(
            mapOf(
                "input_features" to FloatTensor(
                    exactMatrix,
                    longArrayOf(1, featureConfig.featureSize.toLong(), featureConfig.nbMaxFrames.toLong()),
                ),
            ),
            listOf("last_hidden_state"),
        )["last_hidden_state"] as FloatTensor
        val exactIds = WhisperDecoder(decoder, config).generate(exactHidden).map { it.toLong() }
        val exactReference = WhisperGolden.longs(yes["ids"])
        val exactMatch = exactIds == exactReference
        if (!exactMatch && strictTokenIds) {
            failures += "yes golden-feature matrix: ids differ from the reference"
        }
        println("MODELS[$runtimeName] yes golden-feature matrix ids match reference: $exactMatch")

        println(
            "MODELS[$runtimeName] token ids match the reference: $idsRight/${WhisperGolden.clips.size}; " +
                "kept values right: $keptRight/${WhisperGolden.clips.size}",
        )
        val peak = peakResidentBytes()
        println(
            "MODELS[$runtimeName] peak resident memory: " +
                (peak?.let { "$it bytes (${it / (1024 * 1024)} MiB)" } ?: "not measured on this runtime"),
        )
        encoder.close()
        decoder.close()
        assertEquals(WhisperGolden.clips.size, keptRight)
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }
}

/** The top-1 minus top-2 logit gap the plan asks to record at each step. */
private fun topGap(scores: FloatArray): Float {
    var best = Float.NEGATIVE_INFINITY
    var second = Float.NEGATIVE_INFINITY
    for (value in scores) {
        if (value.isNaN()) continue
        if (value > best) {
            second = best
            best = value
        } else if (value > second) {
            second = value
        }
    }
    return best - second
}
