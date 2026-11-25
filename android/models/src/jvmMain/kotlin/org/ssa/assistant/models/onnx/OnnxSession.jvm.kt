package org.ssa.assistant.models.onnx

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OnnxValue
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * ONNX Runtime's Java API behind [OnnxSession], for the host JVM (the desktop
 * tests) and, through the pinned AAR that `:speech` adds, on Android. The CPU
 * provider is ORT's default, as the reference's `executionProviders: ['cpu']`.
 */
actual fun openOnnxSession(path: String): OnnxSession = OrtJvmSession(path)

private class OrtJvmSession(path: String) : OnnxSession {
    // The environment is the process's single ORT environment. ORT owns it and
    // it must outlive every session, so close() never touches it.
    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession = OrtSession.SessionOptions().use { env.createSession(path, it) }

    override val inputNames: List<String> = session.inputInfo.keys.toList()
    override val outputNames: List<String> = session.outputInfo.keys.toList()

    override fun run(inputs: Map<String, Tensor>, outputs: List<String>): Map<String, Tensor> {
        val known = inputNames.toSet()
        val unknown = inputs.keys - known
        require(unknown.isEmpty()) {
            "the session has no input ${unknown.joinToString()}; it takes ${inputNames.joinToString()}"
        }

        val feeds = LinkedHashMap<String, OnnxTensor>()
        try {
            for ((name, tensor) in inputs) {
                feeds[name] = createTensor(tensor)
            }
            session.run(feeds, outputs.toSet()).use { result ->
                val out = LinkedHashMap<String, Tensor>()
                for (name in outputs) {
                    val value = result.get(name).orElseThrow {
                        IllegalStateException("the session produced no output named $name")
                    } as OnnxTensor
                    out[name] = toTensor(name, value)
                }
                return out
            }
        } finally {
            for (tensor in feeds.values) tensor.close()
        }
    }

    private fun createTensor(tensor: Tensor): OnnxTensor = when (tensor) {
        is FloatTensor -> OnnxTensor.createTensor(env, FloatBuffer.wrap(tensor.data), tensor.shape)
        is LongTensor -> OnnxTensor.createTensor(env, LongBuffer.wrap(tensor.data), tensor.shape)
        is BoolTensor -> {
            // The Java API reads bool tensors out of a byte buffer, one 0/1 byte
            // per element, and only from a direct buffer.
            val bytes = ByteBuffer.allocateDirect(tensor.elementCount).order(ByteOrder.nativeOrder())
            for (value in tensor.data) bytes.put(if (value) 1 else 0)
            bytes.rewind()
            OnnxTensor.createTensor(env, bytes, tensor.shape, OnnxJavaType.BOOL)
        }
    }

    private fun toTensor(name: String, value: OnnxTensor): Tensor {
        val info = (value as OnnxValue).info as TensorInfo
        val shape = info.shape
        val count = shape.fold(1L) { product, dim -> product * dim }.toInt()
        return when (info.type) {
            OnnxJavaType.FLOAT -> {
                val data = FloatArray(count)
                value.floatBuffer.get(data)
                FloatTensor(data, shape)
            }
            OnnxJavaType.INT64 -> {
                val data = LongArray(count)
                value.longBuffer.get(data)
                LongTensor(data, shape)
            }
            OnnxJavaType.BOOL -> {
                val buffer = value.byteBuffer
                BoolTensor(BooleanArray(count) { buffer.get(it) != 0.toByte() }, shape)
            }
            else -> throw UnsupportedOperationException(
                "output $name has element type ${info.type}, which :models does not read",
            )
        }
    }

    override fun close() {
        session.close()
    }
}
