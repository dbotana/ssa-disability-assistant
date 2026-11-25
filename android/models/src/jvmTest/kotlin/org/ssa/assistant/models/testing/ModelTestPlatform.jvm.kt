package org.ssa.assistant.models.testing

import kotlinx.coroutines.runBlocking
import java.io.File

private object TestResources

actual fun readTestBytes(path: String): ByteArray =
    TestResources::class.java.classLoader.getResourceAsStream(path)?.use { it.readBytes() }
        ?: throw IllegalArgumentException("test resource $path is missing")

actual fun readFileBytes(absolutePath: String): ByteArray = File(absolutePath).readBytes()

actual fun environmentVariable(name: String): String? = System.getenv(name)

actual val strictTokenIds: Boolean = true

actual val runtimeName: String = "host JVM"

actual fun runBlockingTest(block: suspend () -> Unit) {
    runBlocking { block() }
}

actual fun peakResidentBytes(): Long? {
    val status = File("/proc/self/status")
    if (!status.isFile) return null
    val line = status.readLines().firstOrNull { it.startsWith("VmHWM:") } ?: return null
    val kb = Regex("^VmHWM:\\s+(\\d+)\\s+kB$").matchEntire(line.trim())?.groupValues?.get(1)?.toLongOrNull()
        ?: return null
    return kb * 1024
}
