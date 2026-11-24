@file:OptIn(ExperimentalForeignApi::class)

package org.ssa.assistant.models.testing

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.convert
import kotlinx.cinterop.toKString
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.runBlocking
import platform.Foundation.NSData
import platform.Foundation.NSFileManager
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

actual fun environmentVariable(name: String): String? = getenv(name)?.toKString()

actual val strictTokenIds: Boolean = false

actual val runtimeName: String = "iOS simulator"

actual fun runBlockingTest(block: suspend () -> Unit) {
    runBlocking { block() }
}
