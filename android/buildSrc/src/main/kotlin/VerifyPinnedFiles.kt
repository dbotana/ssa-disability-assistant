import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import java.security.MessageDigest

/**
 * Checks files that Gradle resolved or that were fetched out of band (ONNX Runtime's
 * AAR, jar and iOS zip) against SHA-256 pins, matched by file name. The pin file has
 * "<hex>  <file name>" lines, like the repo's other SHA256SUMS files.
 *
 * It fails on a hash that differs, on a pinned name with no file, and on a file that is
 * not pinned: a new ONNX Runtime version has to be pinned on purpose. Anything that uses
 * these files depends on this task.
 */
@CacheableTask
abstract class VerifyPinnedFiles : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val files: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val pins: RegularFileProperty

    @TaskAction
    fun verify() {
        val pinFile = pins.get().asFile
        val pinned = LinkedHashMap<String, String>()
        pinFile.readLines().forEachIndexed { i, line ->
            if (line.isBlank() || line.startsWith("#")) return@forEachIndexed
            val m = Regex("^([0-9a-f]{64}) [ *](\\S+)$").matchEntire(line)
                ?: throw GradleException("$pinFile:${i + 1}: not a \"<sha256>  <file>\" line")
            pinned[m.groupValues[2]] = m.groupValues[1]
        }
        if (pinned.isEmpty()) throw GradleException("$pinFile pins nothing")

        val present = files.files.associateBy { it.name }
        val problems = mutableListOf<String>()
        (pinned.keys - present.keys).forEach { problems += "pinned but missing: $it" }
        (present.keys - pinned.keys).forEach { problems += "not pinned: $it" }
        for ((name, file) in present) {
            val want = pinned[name] ?: continue
            val got = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
                .joinToString("") { "%02x".format(it) }
            if (got != want) problems += "$name: got $got, pinned $want"
        }
        if (problems.isNotEmpty()) {
            throw GradleException("$pinFile: ${problems.joinToString("; ")}")
        }
    }
}
