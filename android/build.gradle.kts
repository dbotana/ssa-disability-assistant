// Top-level build file. Module configuration lives in each module's build file.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.android.assetpack) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

// ONNX Runtime 1.22.0 (spike 3b). The Android AAR and the desktop jar come from Maven Central
// and the iOS xcframework zip from tools/fetch-onnxruntime.mjs; every one is checked against
// models/onnxruntime.SHA256SUMS before anything uses it. The verified iOS zip is unpacked under
// models/build/, never under src/.
val onnxRuntimeFiles = configurations.detachedConfiguration(
    dependencies.create("com.microsoft.onnxruntime:onnxruntime-android:${libs.versions.onnxruntime.get()}@aar"),
    dependencies.create("com.microsoft.onnxruntime:onnxruntime:${libs.versions.onnxruntime.get()}@jar"),
)
val onnxRuntimeIosZip = layout.projectDirectory.file("models/third_party/onnxruntime.xcframework.zip")

val verifyOnnxRuntime = tasks.register<VerifyPinnedFiles>("verifyOnnxRuntime") {
    files.from(onnxRuntimeFiles, onnxRuntimeIosZip)
    pins = layout.projectDirectory.file("models/onnxruntime.SHA256SUMS")
}

// The AAR and the jar alone: all that :speech (Android) and :models' JVM tasks use, so an
// Android or host build (CI's Linux job among them) does not need the iOS zip, which only
// tools/fetch-onnxruntime.mjs fetches. iOS tasks keep the full verifyOnnxRuntime.
tasks.register<VerifyPinnedFiles>("verifyOnnxRuntimeJava") {
    files.from(onnxRuntimeFiles)
    pins = layout.projectDirectory.file("models/onnxruntime.SHA256SUMS")
    only.set(listOf(
        "onnxruntime-android-${libs.versions.onnxruntime.get()}.aar",
        "onnxruntime-${libs.versions.onnxruntime.get()}.jar",
    ))
}

tasks.register<Sync>("unpackOnnxRuntimeIos") {
    dependsOn(verifyOnnxRuntime)
    from(zipTree(onnxRuntimeIosZip))
    into(layout.projectDirectory.dir("models/build/onnxruntime-ios"))
}
