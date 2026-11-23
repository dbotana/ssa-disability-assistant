@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class, ExperimentalUnsignedTypes::class)

package org.ssa.assistant.core

// Not compiled or run yet: written on Linux, with no Xcode (see build.gradle.kts).

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.convert
import kotlinx.cinterop.usePinned
import platform.CoreCrypto.CC_SHA256
import platform.CoreCrypto.CC_SHA256_DIGEST_LENGTH
import platform.Foundation.NSBundle
import platform.Foundation.NSFileManager
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.decomposedStringWithCanonicalMapping
import platform.Foundation.decomposedStringWithCompatibilityMapping
import platform.Foundation.stringWithContentsOfFile

@Suppress("CAST_NEVER_SUCCEEDS")
actual fun nfd(s: String): String = (s as NSString).decomposedStringWithCanonicalMapping

@Suppress("CAST_NEVER_SUCCEEDS")
actual fun nfkd(s: String): String = (s as NSString).decomposedStringWithCompatibilityMapping

actual fun sha256(bytes: ByteArray): ByteArray {
    val out = UByteArray(CC_SHA256_DIGEST_LENGTH)
    out.usePinned { digest ->
        if (bytes.isEmpty()) {
            CC_SHA256(null, 0u, digest.addressOf(0))
        } else {
            bytes.usePinned { input -> CC_SHA256(input.addressOf(0), bytes.size.convert(), digest.addressOf(0)) }
        }
    }
    return out.asByteArray()
}

actual fun readResource(path: String): String {
    // XCTest bundles have no app main bundle, so the tests point readResource
    // at the repository directories first (IosResources.roots). In an app this
    // list is empty and the main bundle is used as before.
    for (root in IosResources.roots) {
        val candidate = "$root/$path"
        if (NSFileManager.defaultManager.fileExistsAtPath(candidate)) {
            return NSString.stringWithContentsOfFile(candidate, NSUTF8StringEncoding, null)
                ?: throw IllegalArgumentException("missing resource: $path")
        }
    }
    val root = NSBundle.mainBundle.resourcePath ?: throw IllegalArgumentException("missing resource: $path")
    return NSString.stringWithContentsOfFile("$root/$path", NSUTF8StringEncoding, null)
        ?: throw IllegalArgumentException("missing resource: $path")
}
