package org.ssa.assistant.core

/**
 * The few things common Kotlin has no API for. Each platform supplies them
 * from its own library: java.text and java.security on the JVM (and under
 * Android's ICU), Foundation and CommonCrypto on iOS.
 */

/** Unicode canonical decomposition (NFD), as String.prototype.normalize('NFD'). */
expect fun nfd(s: String): String

/** Unicode compatibility decomposition (NFKD), as String.prototype.normalize('NFKD'). */
expect fun nfkd(s: String): String

/** The SHA-256 digest of [bytes]. */
expect fun sha256(bytes: ByteArray): ByteArray

/**
 * A bundled resource as UTF-8 text: the classpath on the JVM, the app bundle
 * on iOS. Throws IllegalArgumentException when it is missing.
 */
expect fun readResource(path: String): String
