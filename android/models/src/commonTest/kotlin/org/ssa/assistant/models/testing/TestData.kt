package org.ssa.assistant.models.testing

import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.sha256
import org.ssa.assistant.models.onnx.OnnxSession
import org.ssa.assistant.models.onnx.Tensor
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

private fun requireObject(value: Json?, what: String): Json.Obj =
    value as? Json.Obj ?: throw IllegalArgumentException("$what is not a JSON object")

private fun requireArray(value: Json?, what: String): List<Json> =
    (value as? Json.Arr ?: throw IllegalArgumentException("$what is not a JSON array")).items

private fun requireString(value: Json?, what: String): String =
    value?.asString() ?: throw IllegalArgumentException("$what is not a JSON string")

private fun requireInt(value: Json?, what: String): Int {
    val number = value?.asDouble() ?: throw IllegalArgumentException("$what is not a JSON number")
    require(number == number.toInt().toDouble()) { "$what is not an integer: $number" }
    return number.toInt()
}

/** The committed golden from `tools/golden/models.mjs`, never edited by hand. */
object WhisperGolden {
    private val root: Json.Obj by lazy {
        JsonParser.parse(readTestBytes("golden/whisper.json").decodeToString()) as? Json.Obj
            ?: throw IllegalArgumentException("whisper.json is not a JSON object")
    }

    val clips: List<Json.Obj> get() = requireArray(root["clips"], "clips").map { requireObject(it, "clip") }
    val decoding: Json.Obj get() = requireObject(root["decoding"], "decoding")
    val features: Json.Obj get() = requireObject(root["features"], "features")
    val sessions: Json.Obj get() = requireObject(root["sessions"], "sessions")
    val decodeCases: List<Json.Obj> get() =
        requireArray(root["decodeCases"], "decodeCases").map { requireObject(it, "decode case") }
    val model: Json.Obj get() = requireObject(root["model"], "model")
    val now: String get() = requireString(root["now"], "now")

    fun obj(parent: Json.Obj, key: String): Json.Obj = requireObject(parent[key], key)
    fun array(parent: Json.Obj, key: String): List<Json> = requireArray(parent[key], key)
    fun string(parent: Json.Obj, key: String): String = requireString(parent[key], key)
    fun int(parent: Json.Obj, key: String): Int = requireInt(parent[key], key)

    fun ints(value: Json?): List<Int> = requireArray(value, "int array").map { requireInt(it, "int") }
    fun longs(value: Json?): List<Long> = ints(value).map { it.toLong() }
    fun strings(value: Json?): List<String> = requireArray(value, "string array").map { requireString(it, "string") }

    fun floats(packed: Json?): FloatArray {
        val bits = unpack(packed, 4)
        return FloatArray(bits.size) { Float.fromBits(bits[it].toInt()) }
    }

    fun doubles(packed: Json?): DoubleArray {
        val bits = unpack(packed, 8)
        return DoubleArray(bits.size) { Double.fromBits(bits[it]) }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun unpack(packed: Json?, bytesPerValue: Int): LongArray {
        val obj = requireObject(packed, "packed array")
        require(obj["byteOrder"]?.asString() == "little-endian") {
            "packed arrays must be little-endian"
        }
        val dims = requireArray(obj["dims"], "dims").map { requireInt(it, "dim").toLong() }
        val count = dims.fold(1L) { product, dim -> product * dim }
        val bytes = Base64.Default.decode(requireString(obj["base64"], "base64"))
        require(count * bytesPerValue == bytes.size.toLong()) {
            "packed array needs ${count * bytesPerValue} bytes, got ${bytes.size}"
        }
        val bits = LongArray(count.toInt())
        for (i in bits.indices) {
            var value = 0L
            for (j in 0 until bytesPerValue) {
                value = value or ((bytes[i * bytesPerValue + j].toInt() and 0xFF).toLong() shl (8 * j))
            }
            bits[i] = value
        }
        return bits
    }
}

/** Reads a 16 kHz mono PCM WAV the way `tools/stt-common.mjs` reads the fixtures. */
fun readWav16k(bytes: ByteArray): FloatArray {
    fun ascii(offset: Int, length: Int): String = buildString(length) {
        for (i in 0 until length) append(bytes[offset + i].toInt().toChar())
    }
    fun u16(offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or ((bytes[offset + 1].toInt() and 0xFF) shl 8)
    fun u32(offset: Int): Int =
        u16(offset) or (u16(offset + 2) shl 16)

    require(bytes.size >= 12 && ascii(0, 4) == "RIFF" && ascii(8, 4) == "WAVE") {
        "not a RIFF/WAVE file"
    }
    var offset = 12
    var rate = 0
    while (offset + 8 <= bytes.size) {
        val id = ascii(offset, 4)
        val size = u32(offset + 4)
        val body = offset + 8
        require(body + size <= bytes.size) { "WAV chunk $id runs past the end of the file" }
        when (id) {
            "fmt " -> {
                require(size >= 16) { "WAV fmt chunk is too short" }
                rate = u32(offset + 12)
            }
            "data" -> {
                require(rate == 16000) { "WAV sample rate is $rate, expected 16000" }
                val count = size / 2
                require(size % 2 == 0) { "WAV data chunk has a half sample" }
                return FloatArray(count) { i ->
                    val raw = u16(body + 2 * i)
                    val signed = if (raw >= 0x8000) raw - 0x10000 else raw
                    (signed / 32768.0).toFloat()
                }
            }
        }
        offset = body + size + (size and 1)
    }
    throw IllegalArgumentException("WAV has no data chunk")
}

fun modelDir(): String =
    environmentVariable("MODEL_DIR")?.takeIf { it.isNotEmpty() }
        ?: throw IllegalStateException(
            "MODEL_DIR is not set: point it at <repo>/models/whisper-base.en " +
                "(on iOS: SIMCTL_CHILD_MODEL_DIR=<abs>/models/whisper-base.en)",
        )

private val HEX = "0123456789abcdef"

private fun ByteArray.hex(): String = buildString(size * 2) {
    for (byte in this@hex) {
        val value = byte.toInt() and 0xFF
        append(HEX[value shr 4])
        append(HEX[value and 0x0F])
    }
}

fun sha256Hex(bytes: ByteArray): String = sha256(bytes).hex()

/** The downloaded model directory, checked file by file before any file is read. */
object PinnedModel {
    private val rawDir: String by lazy { modelDir() }
    private val pins: Map<String, String> by lazy {
        val text = readFileBytes("$rawDir/SHA256SUMS").decodeToString()
        val pattern = Regex("^([0-9a-f]{64})\\s+(\\S+)$")
        val result = LinkedHashMap<String, String>()
        for (line in text.lineSequence()) {
            val match = pattern.matchEntire(line.trim()) ?: continue
            result[match.groupValues[2]] = match.groupValues[1]
        }
        require(result.isNotEmpty()) { "$rawDir/SHA256SUMS has no pins" }
        result
    }
    private val verified: Boolean by lazy {
        for ((name, expected) in pins) {
            val bytes = try {
                readFileBytes("$rawDir/$name")
            } catch (e: Exception) {
                throw IllegalStateException(
                    "model file $name is missing; run node tools/fetch-model.mjs --verify",
                    e,
                )
            }
            require(sha256Hex(bytes) == expected) {
                "model file $name does not match SHA256SUMS; run node tools/fetch-model.mjs --verify"
            }
        }
        true
    }

    /** Absolute path; reading it verifies every pinned file first. */
    val dir: String get() {
        verified
        return rawDir
    }

    fun hashes(): Map<String, String> {
        verified
        return pins
    }

    fun text(name: String): String {
        verified
        return readFileBytes("$rawDir/$name").decodeToString()
    }
}

data class ScriptedCall(
    val inputs: Map<String, Tensor>,
    val outputs: List<String>,
    val result: Map<String, Tensor>,
)

/** An `OnnxSession` that records every call for the decoder tests. */
class ScriptedSession(
    override val inputNames: List<String>,
    override val outputNames: List<String>,
    private val respond: (call: Int, inputs: Map<String, Tensor>, outputs: List<String>) -> Map<String, Tensor>,
) : OnnxSession {
    val calls = mutableListOf<ScriptedCall>()

    override fun run(inputs: Map<String, Tensor>, outputs: List<String>): Map<String, Tensor> {
        val result = respond(calls.size, inputs, outputs)
        calls += ScriptedCall(inputs, outputs, result)
        return result
    }

    override fun close() = Unit
}

/** The merged decoder's name lists, in the golden's order. */
fun mergedDecoderNames(layers: Int): Pair<List<String>, List<String>> {
    val inputs = mutableListOf("input_ids", "encoder_hidden_states")
    val outputs = mutableListOf("logits")
    for (i in 0 until layers) {
        for (part in listOf("decoder.key", "decoder.value", "encoder.key", "encoder.value")) {
            inputs += "past_key_values.$i.$part"
            outputs += "present.$i.$part"
        }
    }
    inputs += "use_cache_branch"
    return inputs to outputs
}
