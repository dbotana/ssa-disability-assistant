package org.ssa.assistant.models.testing

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.models.mms.Wav2Vec2Features
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** The MMS graphs a run can name in `MMS_GRAPHS`, in the golden's order. */
val MMS_GRAPH_KEYS: List<String> = listOf("lin", "fra", "eng", "lid")

/**
 * The MMS exports' directory: `<repo>/android/models/third_party/mms-1b-all`, holding
 * `onnx-lin/`, `onnx-fra/`, `onnx-eng/` and `lid-126/` (Run 9). jvmTest fills it in.
 */
fun mmsDir(): String =
    environmentVariable("MMS_DIR")?.takeIf { it.isNotEmpty() }
        ?: throw IllegalStateException(
            "MMS_DIR is not set: point it at <repo>/android/models/third_party/mms-1b-all " +
                "(on iOS: SIMCTL_CHILD_MMS_DIR=<abs>/android/models/third_party/mms-1b-all; on Android: " +
                "the instrumentation argument MMS_DIR, " +
                "-Pandroid.testInstrumentationRunnerArguments.MMS_DIR=<the pushed folder on the device>)",
        )

/** `MMS_GRAPH` (`fp32` or `q8`), or this runtime's [defaultMmsGraph]. */
fun mmsGraph(): String {
    val value = environmentVariable("MMS_GRAPH")?.takeIf { it.isNotEmpty() } ?: defaultMmsGraph
    require(value == "fp32" || value == "q8") { "MMS_GRAPH must be fp32 or q8, not $value" }
    return value
}

/** `MMS_GRAPHS`, comma-separated (default `lin,fra,eng,lid`): which graphs the model tests run. */
fun mmsGraphs(): List<String> {
    val value = environmentVariable("MMS_GRAPHS")?.takeIf { it.isNotEmpty() } ?: MMS_GRAPH_KEYS.joinToString(",")
    val graphs = value.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    val unknown = graphs.filter { it !in MMS_GRAPH_KEYS }
    require(unknown.isEmpty()) { "MMS_GRAPHS names ${unknown.joinToString()}; the graphs are ${MMS_GRAPH_KEYS.joinToString()}" }
    return graphs
}

/** The `<hash>  <path>` lines of a SHA256SUMS file, in file order. */
fun parseSha256Sums(text: String): Map<String, String> {
    val pattern = Regex("^([0-9a-f]{64})\\s+\\*?(\\S+)$")
    val result = LinkedHashMap<String, String>()
    for (line in text.lineSequence()) {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) continue
        val match = pattern.matchEntire(trimmed)
            ?: throw IllegalArgumentException("not a SHA256SUMS line: $trimmed")
        result[match.groupValues[2]] = match.groupValues[1]
    }
    return result
}

/** The little-endian float32 bytes of [values], as the golden hashes a normalized clip. */
fun littleEndianBytes(values: FloatArray): ByteArray {
    val bytes = ByteArray(values.size * 4)
    for (i in values.indices) {
        val bits = values[i].toRawBits()
        bytes[4 * i] = bits.toByte()
        bytes[4 * i + 1] = (bits ushr 8).toByte()
        bytes[4 * i + 2] = (bits ushr 16).toByte()
        bytes[4 * i + 3] = (bits ushr 24).toByte()
    }
    return bytes
}

/** Reads [clip]'s fixture WAV, after checking its SHA-256 and sample count against the golden. */
fun readMmsClip(clip: MmsGoldenClip): FloatArray {
    val wav = readTestBytes("fixtures/speech/${clip.file}")
    check(sha256Hex(wav) == clip.sha256) { "${clip.file} does not match the golden's SHA-256" }
    val samples = readWav16k(wav)
    check(samples.size == clip.sampleCount) {
        "${clip.file} has ${samples.size} samples; the golden says ${clip.sampleCount}"
    }
    return samples
}

/** [Wav2Vec2Features] built from the golden's `features.config` and `features.epsilon`. */
fun goldenWav2Vec2Features(): Wav2Vec2Features {
    val config = MmsGolden.featureConfig
    fun number(key: String): Double =
        config[key]?.asDouble() ?: throw IllegalArgumentException("mms.json: features.config.$key is not a number")
    fun flag(key: String): Boolean =
        config[key]?.asBoolean() ?: throw IllegalArgumentException("mms.json: features.config.$key is not a boolean")
    return Wav2Vec2Features(
        samplingRate = number("sampling_rate").toInt(),
        doNormalize = flag("do_normalize"),
        epsilon = MmsGolden.epsilon.toFloat(),
        featureSize = number("feature_size").toInt(),
        paddingValue = number("padding_value"),
        returnAttentionMask = flag("return_attention_mask"),
    )
}

/** What two [Wav2Vec2Features] must agree on, for an assertEquals. */
fun Wav2Vec2Features.settings(): List<Any> =
    listOf(samplingRate, doNormalize, epsilon.toRawBits(), featureSize, paddingValue, returnAttentionMask)

/** The first `features.lidWindowSamples` samples (3 s), or all of a shorter clip. */
fun firstWindow(samples: FloatArray, window: Int): FloatArray =
    if (samples.size > window) samples.copyOf(window) else samples

data class MmsGoldenClip(val name: String, val file: String, val sha256: String, val sampleCount: Int)

/**
 * One window's statistics: `features.clips.<clip>.full` or `.first3s`. `meanStd` holds what
 * zero_mean_unit_var_norm uses (tools/golden/mms.py: `mean = data.mean()`,
 * `std = np.sqrt(data.var() + EPSILON)`), so [std] is the divisor `sqrt(var + 1e-7)`, epsilon
 * included, not `x.std()`.
 */
data class MmsFeatureStats(val sampleCount: Int, val mean: Float, val std: Float, val sha256: String)

class MmsGoldenDecoding(
    val blankId: Int,
    val wordDelimiterToken: String,
    val replaceWordDelimiterChar: String,
    val groupTokens: Boolean,
    val skipSpecialTokens: Boolean,
    val cleanUpTokenizationSpaces: Boolean,
    val argmaxTies: String,
    val sources: List<String>,
)

class MmsGoldenGraph(
    val key: String,
    val folder: String,
    /** The app's language code (`ln`, `fr`, `en`); null for `lid`. */
    val code: String?,
    val targetLang: String?,
    /** `<path in the folder's SHA256SUMS>` to its hash, every line. */
    val files: Map<String, String>,
    val inputNames: List<String>,
    val outputNames: List<String>,
    val outputDim: Int,
    /** `lid` only. */
    val labels: List<String>?,
    val candidates: Map<String, String>?,
    val candidateIndices: Map<String, Int>?,
)

class MmsGoldenAsr(val frameIds: List<Int>, val ids: List<Int>, val text: String, val gaps: FloatArray)

class MmsGoldenLid(val logits: FloatArray, val top: String, val probabilities: Map<String, Double>)

data class MmsDecodeCase(val name: String, val ids: List<Int>, val text: String)

/**
 * The committed golden from `tools/golden/mms.py` (Run 9, Decision 2), never edited by hand:
 * `golden/mms.json`, read lazily, against the schema the generator and this reader share.
 * When the LID export is missing, the golden has no `graphs.lid` and no `lid`.
 */
object MmsGolden {
    private val root: Json.Obj by lazy {
        JsonParser.parse(readTestBytes("golden/mms.json").decodeToString()) as? Json.Obj
            ?: throw IllegalArgumentException("mms.json is not a JSON object")
    }

    val generator: String get() = string(root, "generator")

    val clips: List<MmsGoldenClip> by lazy {
        array(root, "clips").map {
            val clip = obj(it, "clip")
            MmsGoldenClip(string(clip, "name"), string(clip, "file"), string(clip, "sha256"), int(clip, "sampleCount"))
        }
    }

    private val features: Json.Obj get() = obj(root["features"], "features")

    /** `features.config`: the five preprocessor settings, as JSON values. */
    val featureConfig: Json.Obj get() = obj(features["config"], "features.config")
    val epsilon: Double get() = double(features, "epsilon")
    val lidWindowSamples: Int get() = int(features, "lidWindowSamples")
    val featureSources: List<String> get() = strings(features["sources"], "features.sources")

    fun featureStats(clip: String, window: String): MmsFeatureStats {
        val clips = obj(features["clips"], "features.clips")
        val stats = obj(obj(clips[clip], "features.clips.$clip")[window], "features.clips.$clip.$window")
        val meanStd = floats(stats["meanStd"], "features.clips.$clip.$window.meanStd")
        require(meanStd.size == 2) { "features.clips.$clip.$window.meanStd must hold 2 values, has ${meanStd.size}" }
        return MmsFeatureStats(int(stats, "sampleCount"), meanStd[0], meanStd[1], string(stats, "sha256"))
    }

    /** `features.yes`: the full normalized `yes.wav`, or null if the golden has none. */
    val yesNormalized: FloatArray? get() = features["yes"]?.let { floats(it, "features.yes") }

    val decoding: MmsGoldenDecoding by lazy {
        val d = obj(root["decoding"], "decoding")
        MmsGoldenDecoding(
            blankId = int(d, "blankId"),
            wordDelimiterToken = string(d, "wordDelimiterToken"),
            replaceWordDelimiterChar = string(d, "replaceWordDelimiterChar"),
            groupTokens = bool(d, "groupTokens"),
            skipSpecialTokens = bool(d, "skipSpecialTokens"),
            cleanUpTokenizationSpaces = bool(d, "cleanUpTokenizationSpaces"),
            argmaxTies = string(d, "argmaxTies"),
            sources = strings(d["sources"], "decoding.sources"),
        )
    }

    /** The graphs the golden describes, in its order (`lid` is absent without the LID export). */
    val graphKeys: List<String> get() = obj(root["graphs"], "graphs").entries.keys.toList()

    /** `graphs.<key>`, or null when the golden has no such graph. */
    fun graph(key: String): MmsGoldenGraph? {
        val graphs = obj(root["graphs"], "graphs")
        val g = graphs[key]?.let { obj(it, "graphs.$key") } ?: return null
        val files = obj(g["files"], "graphs.$key.files").entries.mapValues { (path, value) ->
            value.asString() ?: throw IllegalArgumentException("graphs.$key.files[$path] is not a string")
        }
        return MmsGoldenGraph(
            key = key,
            folder = string(g, "folder"),
            code = nullableString(g, "code"),
            targetLang = nullableString(g, "targetLang"),
            files = files,
            inputNames = strings(g["inputNames"], "graphs.$key.inputNames"),
            outputNames = strings(g["outputNames"], "graphs.$key.outputNames"),
            outputDim = int(g, "outputDim"),
            labels = g["labels"]?.let { strings(it, "graphs.$key.labels") },
            candidates = g["candidates"]?.let { c ->
                obj(c, "graphs.$key.candidates").entries.mapValues { (label, code) ->
                    code.asString() ?: throw IllegalArgumentException("graphs.$key.candidates[$label] is not a string")
                }
            },
            candidateIndices = g["candidateIndices"]?.let { c ->
                obj(c, "graphs.$key.candidateIndices").entries.mapValues { (label, index) ->
                    requireInt(index, "graphs.$key.candidateIndices[$label]")
                }
            },
        )
    }

    /** `asr.<graph>.<clip>`. */
    fun asr(graph: String, clip: String): MmsGoldenAsr {
        val asr = obj(obj(root["asr"], "asr")[graph], "asr.$graph")
        val entry = obj(asr[clip], "asr.$graph.$clip")
        return MmsGoldenAsr(
            frameIds = ints(entry["frameIds"], "asr.$graph.$clip.frameIds"),
            ids = ints(entry["ids"], "asr.$graph.$clip.ids"),
            text = string(entry, "text"),
            gaps = floats(entry["gaps"], "asr.$graph.$clip.gaps"),
        )
    }

    /** `lid.<clip>`, or null when the golden has no `lid` (no LID export). */
    fun lid(clip: String): MmsGoldenLid? {
        val lid = root["lid"]?.let { obj(it, "lid") } ?: return null
        val entry = obj(lid[clip], "lid.$clip")
        val probabilities = obj(entry["probabilities"], "lid.$clip.probabilities").entries.mapValues { (label, p) ->
            p.asDouble() ?: throw IllegalArgumentException("lid.$clip.probabilities[$label] is not a number")
        }
        return MmsGoldenLid(
            logits = floats(entry["logits"], "lid.$clip.logits"),
            top = string(entry, "top"),
            probabilities = probabilities,
        )
    }

    /** `decodeCases.<graph>`. */
    fun decodeCases(graph: String): List<MmsDecodeCase> {
        val cases = obj(root["decodeCases"], "decodeCases")
        return array(cases, graph).map {
            val case = obj(it, "decodeCases.$graph[]")
            MmsDecodeCase(string(case, "name"), ints(case["ids"], "decodeCases.$graph.ids"), string(case, "text"))
        }
    }

    private fun obj(value: Json?, what: String): Json.Obj =
        value as? Json.Obj ?: throw IllegalArgumentException("mms.json: $what is not a JSON object")

    private fun array(parent: Json.Obj, key: String): List<Json> =
        (parent[key] as? Json.Arr ?: throw IllegalArgumentException("mms.json: $key is not a JSON array")).items

    private fun string(parent: Json.Obj, key: String): String =
        parent[key]?.asString() ?: throw IllegalArgumentException("mms.json: $key is not a JSON string")

    private fun nullableString(parent: Json.Obj, key: String): String? = when (val value = parent[key]) {
        null, Json.Null -> null
        else -> value.asString() ?: throw IllegalArgumentException("mms.json: $key is not a string or null")
    }

    private fun bool(parent: Json.Obj, key: String): Boolean =
        parent[key]?.asBoolean() ?: throw IllegalArgumentException("mms.json: $key is not a JSON boolean")

    private fun double(parent: Json.Obj, key: String): Double =
        parent[key]?.asDouble() ?: throw IllegalArgumentException("mms.json: $key is not a JSON number")

    private fun int(parent: Json.Obj, key: String): Int = requireInt(parent[key], key)

    private fun requireInt(value: Json?, what: String): Int {
        val number = value?.asDouble() ?: throw IllegalArgumentException("mms.json: $what is not a JSON number")
        require(number == number.toInt().toDouble()) { "mms.json: $what is not an integer: $number" }
        return number.toInt()
    }

    private fun ints(value: Json?, what: String): List<Int> =
        (value as? Json.Arr ?: throw IllegalArgumentException("mms.json: $what is not a JSON array"))
            .items.map { requireInt(it, what) }

    private fun strings(value: Json?, what: String): List<String> =
        (value as? Json.Arr ?: throw IllegalArgumentException("mms.json: $what is not a JSON array"))
            .items.map { it.asString() ?: throw IllegalArgumentException("mms.json: $what holds a non-string") }

    /** A packed float32 array, as whisper.json packs them. */
    @OptIn(ExperimentalEncodingApi::class)
    private fun floats(packed: Json?, what: String): FloatArray {
        val p = obj(packed, what)
        require(p["dtype"]?.asString() == "float32") { "mms.json: $what is not a float32 packed array" }
        require(p["byteOrder"]?.asString() == "little-endian") { "mms.json: $what is not little-endian" }
        val dims = ints(p["dims"], "$what.dims")
        val count = dims.fold(1L) { product, dim -> product * dim }
        val bytes = Base64.Default.decode(string(p, "base64"))
        require(count * 4 == bytes.size.toLong()) { "mms.json: $what needs ${count * 4} bytes, has ${bytes.size}" }
        return FloatArray(count.toInt()) { i ->
            var bits = 0
            for (j in 0 until 4) bits = bits or ((bytes[4 * i + j].toInt() and 0xFF) shl (8 * j))
            Float.fromBits(bits)
        }
    }
}
