package org.ssa.assistant.models.testing

/** Reads a test resource such as `golden/whisper.json` or `fixtures/speech/yes.wav`. */
expect fun readTestBytes(path: String): ByteArray

/** Reads an absolute path from the host file system (the model directory). */
expect fun readFileBytes(absolutePath: String): ByteArray

/**
 * The SHA-256 of a file, as lowercase hex, read in 1 MiB pieces (Run 9, Decision 9): an MMS
 * `model.onnx_data` is 3.86 GB, more than one array holds and more than the emulator's RAM.
 * Fails when the file is missing.
 */
expect fun sha256File(absolutePath: String): String

expect fun environmentVariable(name: String): String?

/** JVM checks token ids exactly; the iOS run only counts them (see the plan). */
expect val strictTokenIds: Boolean

/** Printed in the FEATURES and MODELS summary lines. */
expect val runtimeName: String

/**
 * The MMS graph variant run when `MMS_GRAPH` is not set (Run 9, Decision 1): `fp32` on the host
 * JVM and the iOS simulator, `q8` on Android, whose 4 GB emulator can't hold the fp32 graph.
 */
expect val defaultMmsGraph: String

expect fun runBlockingTest(block: suspend () -> Unit)

/**
 * Peak resident memory of this test process so far, in bytes: VmHWM from
 * /proc/self/status on Android (and Linux), `resident_size_peak` from
 * `task_vm_info` on iOS; null where it is not measured (the macOS host JVM).
 */
expect fun peakResidentBytes(): Long?
