@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package org.ssa.assistant.core.golden

// Not compiled or run yet: written on Linux, with no Xcode (see build.gradle.kts).

import kotlinx.cinterop.toKString
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.stringWithContentsOfFile
import platform.posix.getenv

// The test binary has no bundle holding the test resources, so they are read
// from the host's disk, which the simulator shares. `simctl spawn` passes
// SIMCTL_CHILD_GOLDEN_DIR into the test process as GOLDEN_DIR.
actual fun readTestResource(path: String): String {
    val dir = getenv("GOLDEN_DIR")?.toKString()?.takeIf { it.isNotEmpty() }
        ?: throw IllegalStateException(
            "GOLDEN_DIR is not set: run the iOS tests with " +
                "SIMCTL_CHILD_GOLDEN_DIR=<android>/core/build/ios-test-resources",
        )
    return NSString.stringWithContentsOfFile("$dir/$path", NSUTF8StringEncoding, null)
        ?: throw IllegalArgumentException("missing test resource: $dir/$path")
}

actual fun runTestBlocking(block: suspend CoroutineScope.() -> Unit) {
    runBlocking(block = block)
}
