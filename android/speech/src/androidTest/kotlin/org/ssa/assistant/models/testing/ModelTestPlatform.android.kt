package org.ssa.assistant.models.testing

import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import java.io.File

// :models' ModelTestPlatform.kt (expect declarations) and its JVM and iOS actuals, as plain
// functions: :speech compiles :models' commonTest sources into its instrumented test APK
// without expect/actual and leaves ModelTestPlatform.kt out (see build.gradle.kts), as
// :core-device does for :core.

private object TestResources

/** Java resources in the test APK: golden/whisper.json and fixtures/speech/. */
fun readTestBytes(path: String): ByteArray =
    TestResources::class.java.classLoader?.getResourceAsStream(path)?.use { it.readBytes() }
        ?: throw IllegalArgumentException("test resource $path is missing")

fun readFileBytes(absolutePath: String): ByteArray = File(absolutePath).readBytes()

/**
 * MODEL_DIR is the pinned model the test APK carries as assets (whisper-base.en/), copied out
 * to the test's no-backup storage on first use, because ONNX Runtime opens a model from a file
 * path. PinnedModel then re-checks every file against SHA256SUMS. Any other name is the
 * process environment.
 */
fun environmentVariable(name: String): String? =
    if (name == "MODEL_DIR") ModelAssets.dir else System.getenv(name)

/** As on iOS: token ids are counted against the reference, not required (Parity contract). */
val strictTokenIds: Boolean = false

val runtimeName: String =
    "Android ${Build.MODEL}, API ${Build.VERSION.SDK_INT}, ${Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown ABI"}"

fun runBlockingTest(block: suspend () -> Unit) {
    runBlocking { block() }
}

/** VmHWM from /proc/self/status: the test process's peak resident set, in bytes. */
fun peakResidentBytes(): Long? {
    val line = File("/proc/self/status").readLines().firstOrNull { it.startsWith("VmHWM:") } ?: return null
    val kb = Regex("^VmHWM:\\s+(\\d+)\\s+kB$").matchEntire(line.trim())?.groupValues?.get(1)?.toLongOrNull()
        ?: return null
    return kb * 1024
}

private object ModelAssets {
    private const val ASSET_DIR = "whisper-base.en"
    private val PIN = Regex("^[0-9a-f]{64}\\s+(\\S+)$")

    val dir: String by lazy {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val assets = instrumentation.context.assets
        val out = File(instrumentation.targetContext.noBackupFilesDir, ASSET_DIR)
        out.deleteRecursively()
        val pins = assets.open("$ASSET_DIR/SHA256SUMS").use { it.readBytes() }.decodeToString()
        val names = listOf("SHA256SUMS") +
            pins.lineSequence().mapNotNull { PIN.matchEntire(it.trim())?.groupValues?.get(1) }.toList()
        for (name in names) {
            val target = File(out, name)
            target.parentFile?.mkdirs()
            assets.open("$ASSET_DIR/$name").use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
        }
        out.absolutePath
    }
}
