// The shared Compose Multiplatform UI: Setup, Interview, Review and Export,
// drawn only from `core`'s UiState and driven only through AppController's
// commands. The iOS app (ios/App) is the first consumer; Android keeps its own
// screens until a later run (plan, Phase B2).
//
// This module also builds the one Kotlin framework the iOS app links, so the
// app carries one Kotlin runtime rather than two (:core's and this module's).
// `assembleSsaCoreDebugXCFramework` exports `:core` and `:models`, and writes
// the debug XCFramework to ios/CoreCrypto/, where the Swift package's binary
// target already reads it. `:core` no longer builds a framework of its own.
//
// ONNX Runtime: `:models` links ORT's C API through its cinterop shim, but a
// Kotlin framework carries no third-party static library, so this framework
// (and the app) must link ORT's xcframework explicitly. The path and flags
// below are `:models`' own (android/models/build.gradle.kts), applied here
// because that project's linker options do not reach this one's binaries.
plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.library)
    alias(libs.plugins.compose.multiplatform)
    alias(libs.plugins.kotlin.compose)
}

val iosFramework = org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFrameworkConfig(project, "SsaCore")

val ortXcframework = rootProject.layout.projectDirectory.dir("models/build/onnxruntime-ios/onnxruntime.xcframework")
val ortSlices = mapOf("iosArm64" to "ios-arm64", "iosSimulatorArm64" to "ios-arm64_x86_64-simulator")

kotlin {
    jvmToolchain(21)

    androidTarget {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    listOf(iosArm64(), iosSimulatorArm64()).forEach { target ->
        val slice = ortXcframework.dir(ortSlices.getValue(target.name)).asFile.absolutePath
        target.binaries.framework {
            baseName = "SsaCore"
            isStatic = true
            export(project(":core"))
            export(project(":models"))
            iosFramework.add(this)
            // The same flags :models' own binaries use: ORT's static library,
            // libc++, and the frameworks ORT's CoreML provider references.
            linkerOpts(
                "-F$slice", "-framework", "onnxruntime", "-lc++",
                "-framework", "Foundation", "-weak_framework", "CoreML",
            )
        }
    }

    sourceSets {
        commonMain.dependencies {
            // api, not implementation: `export` above needs the dependencies
            // visible in the framework's Objective-C header.
            api(project(":core"))
            api(project(":models"))
            implementation(libs.kotlinx.coroutines.core)
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material)
            implementation(compose.ui)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}

android {
    namespace = "org.ssa.assistant.ui"
    compileSdk = 35

    defaultConfig {
        minSdk = 29
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += listOf("META-INF/LICENSE*", "META-INF/NOTICE*")
        }
    }
}

// The debug XCFramework goes beside the Swift package, as :core's used to.
tasks.withType<org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFrameworkTask>().configureEach {
    if (buildType == org.jetbrains.kotlin.gradle.plugin.mpp.NativeBuildType.DEBUG) {
        outputDir = file("${rootProject.projectDir}/../ios/CoreCrypto")
    }
}

// The ORT slice must be unpacked before any framework link reads it.
tasks.matching { it.name.startsWith("link") || it.name.startsWith("assembleSsaCore") }.configureEach {
    dependsOn(":unpackOnnxRuntimeIos")
}
