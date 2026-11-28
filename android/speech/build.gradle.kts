// Speech: on-device capture and transcription, and offline playback. See the plan: "Speech, UI
// and privacy".
//
// Transcription runs on ONNX Runtime (mirror plan D6, spike 3b): the shared Whisper and MMS code
// is :models, and this module supplies ORT on Android through the pinned AAR
// (com.microsoft.onnxruntime:onnxruntime-android 1.22.0, checked against
// models/onnxruntime.SHA256SUMS by :verifyOnnxRuntimeJava before every build). ORT's libraries
// are checked for 16 KB alignment by tools/audit-native.sh. The whisper.cpp JNI probe
// (src/main/cpp/, WhisperNative.kt) was removed by owner decision on 2026-11-28, so this
// module builds no native code of its own.
//
// `./gradlew :speech:connectedDebugAndroidTest` runs :models' common tests on a device, as
// :core-device does for :core: their sources are compiled into this module's instrumented test
// APK, the golden and the fixture WAVs travel as Java resources (pinned by hash), and the pinned
// whisper-base.en model as assets, with .onnx stored uncompressed. The model goes into the test
// APK only, never into the library or the app.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "org.ssa.assistant.speech"
    compileSdk = 35
    ndkVersion = "28.0.12916984"

    defaultConfig {
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Keeps ORT's native libraries to these two ABIs.
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("androidTest") {
            java.srcDir("../models/src/commonTest/kotlin")
            java.srcDir("src/androidTest/kotlin")
            resources.srcDir("../models/src/commonTest/resources")
        }
    }

    androidResources {
        noCompress += "onnx"
    }

    packaging {
        resources {
            excludes += listOf("META-INF/LICENSE*", "META-INF/NOTICE*")
        }
    }
}

// :models' test sources reach the platform through ModelTestPlatform.kt (expect
// declarations), which a plain Android module cannot compile; this module leaves it out and
// supplies the same functions in src/androidTest/kotlin/.../ModelTestPlatform.android.kt.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    if (name.endsWith("AndroidTestKotlin")) {
        exclude("**/models/testing/ModelTestPlatform.kt")
        // The tests exercise :models' internal helpers too, so :models' JVM jar is a friend
        // path: the helpers stay internal in the library but resolve from these tests. The
        // friend path must be build/libs/models-jvm.jar, the same file the compiler already has
        // on its classpath through implementation(project(":models")); pointing it at :models'
        // compiled-classes directory instead still fails with "it is internal in file" (Run 8
        // Step 5). That classpath entry already makes Gradle build the jar first, so the
        // dependsOn below is not what makes this work; it is kept as Run 8 left it.
        dependsOn(":models:compileKotlinJvm")
        friendPaths.from(project(":models").layout.buildDirectory.file("libs/models-jvm.jar"))
    }
}

// Every build that resolves the ORT AAR checks it against its pin first.
tasks.named("preBuild") { dependsOn(":verifyOnnxRuntimeJava") }

dependencies {
    api(project(":core"))
    implementation(project(":models"))
    implementation(libs.onnxruntime.android)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit)
    androidTestImplementation(libs.junit)
    // :models' tests are written against kotlin.test, which maps onto JUnit 4 here.
    androidTestImplementation(kotlin("test-junit"))
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.espresso.core)
}

// The pre-synthesized prompt clips, from the repo's audio/, checked against
// the pins in audio.SHA256SUMS; the clip player finds them by ttshash.
androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val copy = tasks.register<CopyPinnedAssets>("copy${name}PinnedAudio") {
            sourceDir.set(rootProject.layout.projectDirectory.dir("../audio"))
            pins.set(layout.projectDirectory.file("audio.SHA256SUMS"))
            assetPath.set("audio")
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyPinnedAssets::outputDir)

        variant.androidTest?.let { test ->
            // tests/fixtures/speech, pinned by hash exactly as :models pins it for its own tests.
            val fixtures = tasks.register<CopyPinnedAssets>("copy${name}SpeechFixtures") {
                sourceDir.set(rootProject.layout.projectDirectory.dir("../tests/fixtures/speech"))
                pins.set(rootProject.layout.projectDirectory.file("models/speech-fixtures.SHA256SUMS"))
                assetPath.set("fixtures/speech")
            }
            test.sources.resources?.addGeneratedSourceDirectory(fixtures, CopyPinnedAssets::outputDir)
            // The pinned base.en model, as test-APK assets (ORT opens a model from a file, so the test copies them out).
            val model = tasks.register<CopyPinnedModel>("copy${name}WhisperModel") {
                sourceDir.set(rootProject.layout.projectDirectory.dir("../models/whisper-base.en"))
                assetPath.set("whisper-base.en")
            }
            test.sources.assets?.addGeneratedSourceDirectory(model, CopyPinnedModel::outputDir)
        }
    }
}

// Kotlin 2.2 and later reject `android { kotlinOptions { ... } }`, so the JVM
// target lives in the Kotlin extension. This is the minimum change the Kotlin
// 2.4.21 upgrade needs (plan, B1).
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}
