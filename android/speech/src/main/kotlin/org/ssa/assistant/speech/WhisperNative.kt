package org.ssa.assistant.speech

/**
 * Native probe for the speech module's JNI surface.
 *
 * A placeholder until whisper.cpp is vendored under third_party/ (milestone
 * M1b). It exists so the NDK build, 16 KB alignment and symbol-visibility
 * checks in CI run against a real .so from the first commit of the skeleton.
 */
object WhisperNative {
    init {
        System.loadLibrary("whisper_jni")
    }

    external fun probe(): String
}
