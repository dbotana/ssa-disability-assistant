package org.ssa.assistant.core.golden

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import org.ssa.assistant.core.readResource

actual fun readTestResource(path: String): String = readResource(path)

actual fun runTestBlocking(block: suspend CoroutineScope.() -> Unit) {
    runBlocking(block = block)
}
