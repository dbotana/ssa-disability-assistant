// Speech: on-device capture and transcription (whisper.cpp through JNI) and
// offline playback. See the plan: "Speech, UI and privacy".
//
// The C++ side lives in src/main/cpp/: for now a probe library, built with
// -fvisibility=hidden, a version script exporting only the JNI symbols, and
// 16 KB page alignment (NDK r28+), all checked on the built artifacts by
// tools/audit-native.sh. whisper.cpp, and ggml with it, is linked in
// statically when it is vendored (M1b); :llm will be built the same way.
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

        externalNativeBuild {
            cmake {
                cppFlags += listOf("-std=c++17")
                // The C++ runtime linked in, not shipped beside the library as
                // a 9 MB libc++_shared.so, so each native library is
                // self-contained (the plan links ggml the same way).
                arguments += listOf(
                    "-DANDROID_STL=c++_static"
                )
            }
        }
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    api(project(":core"))
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

// The pre-synthesized prompt clips, from the repo's audio/, checked against
// the pins in audio.SHA256SUMS; the clip player finds them by ttshash.
androidComponents {
    onVariants { variant ->
        val copy = tasks.register<CopyPinnedAssets>("copy${variant.name.replaceFirstChar { it.uppercase() }}PinnedAudio") {
            sourceDir.set(rootProject.layout.projectDirectory.dir("../audio"))
            pins.set(layout.projectDirectory.file("audio.SHA256SUMS"))
            assetPath.set("audio")
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyPinnedAssets::outputDir)
    }
}
