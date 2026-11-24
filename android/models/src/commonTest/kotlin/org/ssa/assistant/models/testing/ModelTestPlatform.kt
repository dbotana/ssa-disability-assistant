package org.ssa.assistant.models.testing

/** Reads a test resource such as `golden/whisper.json` or `fixtures/speech/yes.wav`. */
expect fun readTestBytes(path: String): ByteArray

/** Reads an absolute path from the host file system (the model directory). */
expect fun readFileBytes(absolutePath: String): ByteArray

expect fun environmentVariable(name: String): String?

/** JVM checks token ids exactly; the iOS run only counts them (see the plan). */
expect val strictTokenIds: Boolean

/** Printed in the FEATURES and MODELS summary lines. */
expect val runtimeName: String

expect fun runBlockingTest(block: suspend () -> Unit)
