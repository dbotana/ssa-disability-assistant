package org.ssa.assistant.core

import java.security.MessageDigest
import java.text.Normalizer

actual fun nfd(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFD)

actual fun nfkd(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKD)

actual fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

private object ResourceAnchor

actual fun readResource(path: String): String {
    val stream = ResourceAnchor::class.java.classLoader.getResourceAsStream(path)
        ?: throw IllegalArgumentException("missing resource: $path")
    return stream.use { it.readBytes().toString(Charsets.UTF_8) }
}
