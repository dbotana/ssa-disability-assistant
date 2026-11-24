package org.ssa.assistant.models.onnx

/**
 * A dense row-major tensor. Only what Whisper (and later MMS, NLLB, Simba)
 * needs: float32 features and logits, int64 token ids, and the decoder's
 * `use_cache_branch` boolean.
 *
 * The values are copied into and out of ONNX Runtime on both platforms; there
 * is no zero-copy view, so a tensor handed to [OnnxSession.run] may be kept or
 * mutated by the caller afterwards without touching ORT's buffers.
 */
sealed class Tensor(val shape: LongArray) {
    /** Number of values in [shape], as the ONNX element count. */
    val elementCount: Int = shape.fold(1L) { product, dim -> product * dim }.toInt()
}

/** float32, as the model's `input_features`, `logits` and KV cache entries. */
class FloatTensor(val data: FloatArray, shape: LongArray) : Tensor(shape) {
    init {
        checkShape(shape, data.size)
    }
}

/** int64, as `input_ids`. */
class LongTensor(val data: LongArray, shape: LongArray) : Tensor(shape) {
    init {
        checkShape(shape, data.size)
    }
}

/** bool, as `use_cache_branch` (a [1] tensor). */
class BoolTensor(val data: BooleanArray, shape: LongArray) : Tensor(shape) {
    init {
        checkShape(shape, data.size)
    }
}

private fun checkShape(shape: LongArray, size: Int) {
    require(shape.all { it >= 0 }) { "shape ${shape.contentToString()} has a negative dimension" }
    val expected = shape.fold(1L) { product, dim -> product * dim }
    require(expected == size.toLong()) {
        "shape ${shape.contentToString()} needs $expected values, got $size"
    }
}

/**
 * ONNX Runtime behind a port: nothing else in `:models` knows about ORT.
 * Implemented over ORT's Java API on the host JVM and over its C API through
 * cinterop on iOS, so the Whisper code above it runs the same on both.
 */
interface OnnxSession {
    /** The model's input names, in the model's own order. */
    val inputNames: List<String>

    /** The model's output names, in the model's own order. */
    val outputNames: List<String>

    /**
     * Runs on [inputs] (each one a model input, by name) and returns exactly
     * [outputs], by name. Data is copied in and out: the returned tensors own
     * their arrays.
     */
    fun run(inputs: Map<String, Tensor>, outputs: List<String> = outputNames): Map<String, Tensor>

    /** Releases the session. Closing twice is harmless. */
    fun close()
}

/** Opens the model at [path] (a file path) with ORT's default options and its CPU provider. */
expect fun openOnnxSession(path: String): OnnxSession
