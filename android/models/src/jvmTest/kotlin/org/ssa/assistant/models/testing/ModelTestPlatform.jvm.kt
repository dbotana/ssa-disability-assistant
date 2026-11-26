package org.ssa.assistant.models.testing

import kotlinx.coroutines.runBlocking
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

private object TestResources

actual fun readTestBytes(path: String): ByteArray =
    TestResources::class.java.classLoader.getResourceAsStream(path)?.use { it.readBytes() }
        ?: throw IllegalArgumentException("test resource $path is missing")

actual fun readFileBytes(absolutePath: String): ByteArray = File(absolutePath).readBytes()

actual fun sha256File(absolutePath: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(absolutePath).use { input ->
        val buffer = ByteArray(1 shl 20)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    return hexOf(digest.digest())
}

actual fun environmentVariable(name: String): String? = System.getenv(name)

actual val strictTokenIds: Boolean = true

actual val runtimeName: String = "host JVM"

actual val defaultMmsGraph: String = "fp32"

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
