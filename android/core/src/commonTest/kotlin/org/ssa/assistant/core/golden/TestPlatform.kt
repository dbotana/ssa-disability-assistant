package org.ssa.assistant.core.golden

import kotlinx.coroutines.CoroutineScope

/*
 * What the shared tests need from the platform they run on. :core-device
 * compiles these test sources as plain Android code, with no expect/actual,
 * so it leaves this file and TestPlatform.jvm.kt out and supplies the same
 * two functions itself (core-device/src/androidTest).
 */

/**
 * A test resource (golden/, turn-scenarios/, fixtures/answers/) as UTF-8
 * text: the classpath on the JVM; on iOS the directory named by the
 * GOLDEN_DIR environment variable (see the iOS note in core/build.gradle.kts).
 * Throws IllegalArgumentException when the file is missing.
 */
expect fun readTestResource(path: String): String

/** Runs [block] to completion on the calling thread, real time and all. */
expect fun runTestBlocking(block: suspend CoroutineScope.() -> Unit)
