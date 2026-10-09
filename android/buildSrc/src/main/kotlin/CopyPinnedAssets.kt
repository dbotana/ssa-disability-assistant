import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import java.security.MessageDigest

/**
 * Copies a directory from the repository root (forms/, audio/) into an
 * Android module's assets, checking every file against pinned SHA-256 hashes.
 *
 * The pins live in the module (`<name>.SHA256SUMS`, "<hex>  <file>" lines, the
 * format of the repo's other SHA256SUMS files), so the Android build says
 * exactly which bytes it ships. The build fails on a file whose hash differs,
 * on a pinned file that is missing, and on a file that is not pinned at all:
 * a template revision or a regenerated clip has to be pinned on purpose.
 *
 * To re-pin after a deliberate change: `(cd <dir> && shasum -a 256 *) > <pins>`.
 */
@CacheableTask
abstract class CopyPinnedAssets : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDir: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val pins: RegularFileProperty

    /** Where the files land inside the APK's assets: "forms" -> assets/forms/. */
    @get:Input
    abstract val assetPath: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val pinFile = pins.get().asFile
        val pinned = LinkedHashMap<String, String>()
        pinFile.readLines().forEachIndexed { i, line ->
            if (line.isBlank() || line.startsWith("#")) return@forEachIndexed
            val m = Regex("^([0-9a-f]{64}) [ *](\\S+)$").matchEntire(line)
                ?: throw GradleException("$pinFile:${i + 1}: not a \"<sha256>  <file>\" line")
            pinned[m.groupValues[2]] = m.groupValues[1]
        }
        if (pinned.isEmpty()) throw GradleException("$pinFile pins nothing")

        val src = sourceDir.get().asFile
        val present = src.listFiles { f -> f.isFile && !f.name.startsWith(".") }?.map { it.name }?.toSet()
            ?: throw GradleException("$src is not a directory")
        val unpinned = present - pinned.keys
        val missing = pinned.keys - present
        val problems = mutableListOf<String>()
        if (unpinned.isNotEmpty()) problems += "not pinned: ${unpinned.sorted().joinToString()}"
        if (missing.isNotEmpty()) problems += "pinned but missing: ${missing.sorted().joinToString()}"

        val out = outputDir.get().asFile.resolve(assetPath.get())
        out.deleteRecursively()
        out.mkdirs()
        for ((name, want) in pinned) {
            val file = src.resolve(name)
            if (!file.isFile) continue
            val got = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
                .joinToString("") { "%02x".format(it) }
            if (got != want) problems += "$name: sha256 $got, pinned $want"
            else file.copyTo(out.resolve(name), overwrite = true)
        }
        if (problems.isNotEmpty()) {
            throw GradleException("$src does not match $pinFile:\n  " + problems.joinToString("\n  "))
        }
        // The pins travel with the files, as <assetPath>/SHA256SUMS: inside an
        // APK a directory cannot be listed, so this is the index readers use,
        // and the hashes a loader re-checks at runtime are the same ones the
        // build checked.
        pinFile.copyTo(out.resolve(PINS_NAME), overwrite = true)
    }

    companion object {
        const val PINS_NAME = "SHA256SUMS"
    }
}
