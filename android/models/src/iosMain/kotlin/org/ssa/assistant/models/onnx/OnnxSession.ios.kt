@file:OptIn(ExperimentalForeignApi::class)

package org.ssa.assistant.models.onnx

import kotlinx.cinterop.*
import org.ssa.assistant.models.ort.*
import platform.posix.memcpy

/**
 * ONNX Runtime's C API behind [OnnxSession], for iOS. The C calls are the shim
 * in src/nativeInterop/cinterop/onnxruntime.def, which never loads a library,
 * registers a custom op or selects an execution provider: ORT's default CPU
 * provider is the reference's `executionProviders: ['cpu']`.
 *
 * Handles are `void*`, and error strings are malloc'd (see [ortCheck]). The
 * environment is created once per process, on first use, and kept in the
 * shim's `ssa_env`. No session releases it: the shim's `atexit` handler,
 * `ssa_ort_shutdown`, releases it at process exit (see the note there on why
 * that depends on registration order).
 */
actual fun openOnnxSession(path: String): OnnxSession = OrtNativeSession(path)

/** Throws the shim's error message (and frees it), or returns when [error] is NULL. */
private fun ortCheck(error: CPointer<ByteVar>?) {
    if (error == null) return
    val message = error.toKString()
    ssa_ort_free_string(error)
    throw IllegalStateException("ONNX Runtime: $message")
}

/** One ORT environment per process, created on first use. It must outlive every session, so no session releases it; the shim's atexit handler does, at process exit. */
private val ortEnv: COpaquePointer by lazy {
    memScoped {
        val out = alloc<COpaquePointerVar>()
        ortCheck(ssa_ort_create_env(out.ptr))
        out.value ?: throw IllegalStateException("ONNX Runtime: CreateEnv returned no environment")
    }
}

private class OrtNativeSession(path: String) : OnnxSession {
    private var handle: COpaquePointer? = memScoped {
        val out = alloc<COpaquePointerVar>()
        ortCheck(ssa_ort_create_session(ortEnv, path, out.ptr))
        out.value ?: throw IllegalStateException("ONNX Runtime: CreateSession returned no session")
    }

    override val inputNames: List<String> = names(outputs = false)
    override val outputNames: List<String> = names(outputs = true)

    private fun names(outputs: Boolean): List<String> {
        val session = handle ?: throw IllegalStateException("ONNX Runtime: the session is closed")
        return memScoped {
            val count = alloc<ULongVar>()
            ortCheck(ssa_ort_io_count(session, if (outputs) 1 else 0, count.ptr))
            (0 until count.value.toInt()).map { index ->
                val name = alloc<CPointerVar<ByteVar>>()
                ortCheck(ssa_ort_io_name(session, if (outputs) 1 else 0, index.convert(), name.ptr))
                val text = name.value?.toKString() ?: ""
                name.value?.let { ssa_ort_free_string(it) }
                text
            }
        }
    }

    override fun run(inputs: Map<String, Tensor>, outputs: List<String>): Map<String, Tensor> {
        val session = handle ?: throw IllegalStateException("ONNX Runtime: the session is closed")
        val unknown = inputs.keys - inputNames.toSet()
        require(unknown.isEmpty()) {
            "the session has no input ${unknown.joinToString()}; it takes ${inputNames.joinToString()}"
        }

        return memScoped {
            val feeds = inputs.entries.toList()
            val namesIn = allocArray<CPointerVar<ByteVar>>(feeds.size)
            val valuesIn = allocArray<COpaquePointerVar>(feeds.size)
            val namesOut = allocArray<CPointerVar<ByteVar>>(outputs.size)
            val valuesOut = allocArray<COpaquePointerVar>(outputs.size)
            for (i in feeds.indices) {
                namesIn[i] = feeds[i].key.cstr.ptr
                valuesIn[i] = null
            }
            for (i in outputs.indices) {
                namesOut[i] = outputs[i].cstr.ptr
                valuesOut[i] = null
            }

            try {
                for (i in feeds.indices) {
                    val tensor = feeds[i].value
                    val shape = allocArray<LongVar>(tensor.shape.size)
                    for (j in tensor.shape.indices) shape[j] = tensor.shape[j]
                    val out = alloc<COpaquePointerVar>()
                    ortCheck(
                        ssa_ort_create_tensor(shape, tensor.shape.size.convert(), elementType(tensor), out.ptr),
                    )
                    val value = out.value
                        ?: throw IllegalStateException("ONNX Runtime: CreateTensorAsOrtValue returned no value")
                    valuesIn[i] = value
                    if (tensor.elementCount > 0) writeData(tensor, value)
                }

                ortCheck(
                    ssa_ort_run(
                        session,
                        namesIn,
                        valuesIn,
                        feeds.size.convert(),
                        namesOut,
                        outputs.size.convert(),
                        valuesOut,
                    ),
                )

                val result = LinkedHashMap<String, Tensor>()
                for (i in outputs.indices) {
                    val value = valuesOut[i]
                        ?: throw IllegalStateException("ONNX Runtime: output ${outputs[i]} is missing")
                    result[outputs[i]] = readValue(outputs[i], value)
                }
                result
            } finally {
                for (i in feeds.indices) valuesIn[i]?.let { ssa_ort_release_value(it) }
                for (i in outputs.indices) valuesOut[i]?.let { ssa_ort_release_value(it) }
            }
        }
    }

    /** Copies [tensor] into the ORT value's buffer. */
    private fun writeData(tensor: Tensor, value: COpaquePointer) {
        memScoped {
            val out = alloc<COpaquePointerVar>()
            ortCheck(ssa_ort_tensor_data(value, out.ptr))
            val destination = out.value
                ?: throw IllegalStateException("ONNX Runtime: the tensor's data pointer is null")
            when (tensor) {
                is FloatTensor -> tensor.data.usePinned {
                    memcpy(destination, it.addressOf(0), (tensor.data.size * 4).convert())
                }
                is LongTensor -> tensor.data.usePinned {
                    memcpy(destination, it.addressOf(0), (tensor.data.size * 8).convert())
                }
                is BoolTensor -> {
                    val bytes = ByteArray(tensor.data.size) { if (tensor.data[it]) 1 else 0 }
                    bytes.usePinned { memcpy(destination, it.addressOf(0), bytes.size.convert()) }
                }
            }
        }
    }

    /** Copies one ORT output value into a [Tensor]. */
    private fun readValue(name: String, value: COpaquePointer): Tensor = memScoped {
        val elementType = alloc<IntVar>()
        val rank = alloc<ULongVar>()
        val dims = allocArray<LongVar>(DIMS_CAPACITY)
        ortCheck(ssa_ort_tensor_info(value, elementType.ptr, rank.ptr, dims, DIMS_CAPACITY.convert()))
        val shape = LongArray(rank.value.toInt()) { dims[it] }
        val count = shape.fold(1L) { product, dim -> product * dim }.toInt()

        if (count == 0) {
            return@memScoped when (elementType.value) {
                TYPE_FLOAT -> FloatTensor(FloatArray(0), shape)
                TYPE_INT64 -> LongTensor(LongArray(0), shape)
                TYPE_BOOL -> BoolTensor(BooleanArray(0), shape)
                else -> unsupported(name, elementType.value)
            }
        }

        val out = alloc<COpaquePointerVar>()
        ortCheck(ssa_ort_tensor_data(value, out.ptr))
        val source = out.value
            ?: throw IllegalStateException("ONNX Runtime: output $name has a null data pointer")
        when (elementType.value) {
            TYPE_FLOAT -> {
                val data = FloatArray(count)
                data.usePinned { memcpy(it.addressOf(0), source, (count * 4).convert()) }
                FloatTensor(data, shape)
            }
            TYPE_INT64 -> {
                val data = LongArray(count)
                data.usePinned { memcpy(it.addressOf(0), source, (count * 8).convert()) }
                LongTensor(data, shape)
            }
            TYPE_BOOL -> {
                val bytes = ByteArray(count)
                bytes.usePinned { memcpy(it.addressOf(0), source, count.convert()) }
                BoolTensor(BooleanArray(count) { bytes[it].toInt() != 0 }, shape)
            }
            else -> unsupported(name, elementType.value)
        }
    }

    private fun unsupported(name: String, elementType: Int): Nothing =
        throw UnsupportedOperationException(
            "output $name has ONNX element type $elementType, which :models does not read",
        )

    override fun close() {
        handle?.let { ssa_ort_release_session(it) }
        handle = null
    }

    private companion object {
        // The shim's _Static_asserts pin these to the ONNX Runtime header.
        const val TYPE_FLOAT = 1
        const val TYPE_INT64 = 7
        const val TYPE_BOOL = 9
        const val DIMS_CAPACITY = 8
    }
}

private fun elementType(tensor: Tensor): Int = when (tensor) {
    is FloatTensor -> 1
    is LongTensor -> 7
    is BoolTensor -> 9
}
