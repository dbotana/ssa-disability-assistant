// Native side of the speech module.
//
// Placeholder for the whisper.cpp JNI (milestone M1b/M5): the skeleton ships a
// trivial probe so the NDK toolchain, 16 KB alignment and the export-only-JNI
// version script are exercised by CI before whisper.cpp is vendored in
// third_party/. The real port loads `ggml-base.en` q8_0 through whisper.cpp's
// loader-callback API and runs greedy decoding, English-only, no timestamps,
// non-speech tokens suppressed.
#include <jni.h>
#include <string>

extern "C" JNIEXPORT jstring JNICALL
Java_org_ssa_assistant_speech_WhisperNative_probe(JNIEnv *env, jobject /* thiz */) {
    return env->NewStringUTF("whisper_jni");
}
