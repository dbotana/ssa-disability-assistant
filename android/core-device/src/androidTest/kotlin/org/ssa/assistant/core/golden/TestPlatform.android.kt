package org.ssa.assistant.core.golden

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import org.ssa.assistant.core.readResource

// :core's TestPlatform.kt and TestPlatform.jvm.kt, as plain functions: this
// module compiles :core's test sources without expect/actual, and leaves
// those two files out (see build.gradle.kts).

fun readTestResource(path: String): String = readResource(path)

fun runTestBlocking(block: suspend CoroutineScope.() -> Unit) {
    runBlocking(block = block)
}
