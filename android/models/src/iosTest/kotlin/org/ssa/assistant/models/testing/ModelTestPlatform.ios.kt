@file:OptIn(ExperimentalForeignApi::class)

package org.ssa.assistant.models.testing

import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.UByteVar
import kotlinx.cinterop.UIntVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.convert
import kotlinx.cinterop.get
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.sizeOf
import kotlinx.cinterop.toKString
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import kotlinx.coroutines.runBlocking
import platform.CoreCrypto.CC_SHA256_CTX
import platform.CoreCrypto.CC_SHA256_DIGEST_LENGTH
import platform.CoreCrypto.CC_SHA256_Final
import platform.CoreCrypto.CC_SHA256_Init
import platform.CoreCrypto.CC_SHA256_Update
import platform.Foundation.NSFileManager
import platform.darwin.KERN_SUCCESS
import platform.darwin.TASK_VM_INFO
import platform.darwin.mach_msg_type_number_tVar
import platform.darwin.mach_task_self_
import platform.darwin.task_info
import platform.darwin.task_vm_info
import platform.posix.fclose
import platform.posix.ferror
import platform.posix.fopen
import platform.posix.fread
import platform.posix.getenv
import platform.posix.memcpy

actual fun readTestBytes(path: String): ByteArray {
    val dir = environmentVariable("GOLDEN_DIR")?.takeIf { it.isNotEmpty() }
        ?: throw IllegalStateException(
            "GOLDEN_DIR is not set: run with " +
                "SIMCTL_CHILD_GOLDEN_DIR=<android>/models/build/ios-test-resources",
        )
    return readFileBytes("$dir/$path")
}

actual fun readFileBytes(absolutePath: String): ByteArray {
    val data = NSFileManager.defaultManager.contentsAtPath(absolutePath)
        ?: throw IllegalArgumentException("file $absolutePath is missing")
    val length = data.length.toInt()
    if (length == 0) return ByteArray(0)
    val source = data.bytes ?: throw IllegalArgumentException("file $absolutePath has no data pointer")
    val bytes = ByteArray(length)
    bytes.usePinned { memcpy(it.addressOf(0), source, length.convert()) }
    return bytes
}

private const val HASH_BUFFER = 1 shl 20

/** CommonCrypto's streaming SHA-256 over `fopen`/`fread` in 1 MiB pieces (Run 9, Decision 9). */
actual fun sha256File(absolutePath: String): String = memScoped {
    val file = fopen(absolutePath, "rb") ?: throw IllegalArgumentException("file $absolutePath is missing")
    try {
        val context = alloc<CC_SHA256_CTX>()
        check(CC_SHA256_Init(context.ptr) == 1) { "CC_SHA256_Init failed" }
        val buffer = allocArray<ByteVar>(HASH_BUFFER)
        while (true) {
            val read = fread(buffer, 1.convert(), HASH_BUFFER.convert(), file)
            if (read.toLong() == 0L) break
            check(CC_SHA256_Update(context.ptr, buffer, read.convert()) == 1) { "CC_SHA256_Update failed" }
        }
        check(ferror(file) == 0) { "reading $absolutePath failed" }
        val digest = allocArray<UByteVar>(CC_SHA256_DIGEST_LENGTH)
        check(CC_SHA256_Final(digest, context.ptr) == 1) { "CC_SHA256_Final failed" }
        hexOf(ByteArray(CC_SHA256_DIGEST_LENGTH) { digest[it].toByte() })
    } finally {
        fclose(file)
    }
}

actual fun environmentVariable(name: String): String? = getenv(name)?.toKString()

actual val strictTokenIds: Boolean = false

actual val runtimeName: String = "iOS simulator"

actual val defaultMmsGraph: String = "fp32"

actual fun runBlockingTest(block: suspend () -> Unit) {
    runBlocking { block() }
}

actual fun peakResidentBytes(): Long? = memScoped {
    val info = alloc<task_vm_info>()
    val count = alloc<mach_msg_type_number_tVar>()
    count.value = (sizeOf<task_vm_info>() / sizeOf<UIntVar>()).convert()
    val result = task_info(mach_task_self_, TASK_VM_INFO.convert(), info.ptr.reinterpret(), count.ptr)
    if (result == KERN_SUCCESS) info.resident_size_peak.toLong() else null
}
