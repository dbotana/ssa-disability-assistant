import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import java.io.File
import java.security.MessageDigest

/**
 * Copies a downloaded model directory (models/whisper-base.en) into generated assets, checking
 * every file against the directory's own SHA256SUMS: the pins `node tools/fetch-model.mjs
 * --verify` checks, so a build ships exactly the bytes the reference ran on.
 *
 * Unlike CopyPinnedAssets, pinned names may sit in subdirectories (onnx/encoder_model_quantized.onnx),
 * and files the pins do not name (SOURCE.txt) are left behind rather than refused: a model
 * directory carries notes that are not part of the model. A pinned file that is missing, or whose
 * hash differs, fails the build. SHA256SUMS travels with the files, as <assetPath>/SHA256SUMS.
 */
@CacheableTask
abstract class CopyPinnedModel : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDir: DirectoryProperty

    /** Where the files land inside the APK's assets: "whisper-base.en" -> assets/whisper-base.en/. */
    @get:Input
    abstract val assetPath: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val src = sourceDir.get().asFile
        val pinFile = src.resolve(PINS_NAME)
        if (!pinFile.isFile) throw GradleException("$pinFile is missing: run node tools/fetch-model.mjs")
        val pinned = LinkedHashMap<String, String>()
        pinFile.readLines().forEachIndexed { i, line ->
            if (line.isBlank() || line.startsWith("#")) return@forEachIndexed
            val m = Regex("^([0-9a-f]{64}) [ *](\\S+)$").matchEntire(line)
                ?: throw GradleException("$pinFile:${i + 1}: not a \"<sha256>  <file>\" line")
            val name = m.groupValues[2]
            if (name.startsWith("/") || name.split('/').any { it.isEmpty() || it == ".." }) {
                throw GradleException("$pinFile:${i + 1}: $name is not a relative path inside $src")
            }
            pinned[name] = m.groupValues[1]
        }
        if (pinned.isEmpty()) throw GradleException("$pinFile pins nothing")

        val out = outputDir.get().asFile.resolve(assetPath.get())
        out.deleteRecursively()
        out.mkdirs()
        val problems = mutableListOf<String>()
        for ((name, want) in pinned) {
            val file = src.resolve(name)
            if (!file.isFile) { problems += "pinned but missing: $name"; continue }
            val got = sha256(file)
            if (got != want) { problems += "$name: sha256 $got, pinned $want"; continue }
            file.copyTo(out.resolve(name), overwrite = true)
        }
        if (problems.isNotEmpty()) {
            throw GradleException(
                "$src does not match $pinFile (run node tools/fetch-model.mjs --verify):\n  " +
                    problems.joinToString("\n  "),
            )
        }
        pinFile.copyTo(out.resolve(PINS_NAME), overwrite = true)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val PINS_NAME = "SHA256SUMS"
    }
}
