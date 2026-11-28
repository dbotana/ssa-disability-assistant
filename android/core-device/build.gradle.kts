// The :core goldens and unit tests, run on Android.
//
// :core's JVM target runs its tests on the desktop JVM — where
// java.util.regex is OpenJDK's. On a phone it is ICU, whose \s, \w, \d, \b
// and case folding all differ from JS and from the JVM. This module compiles
// core's own test sources and golden resources into an instrumented test APK,
// so the same assertions run under ICU: `./gradlew :core-device:connectedDebugAndroidTest`.
// CI runs it on an emulator, including a 16 KB page-size image.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "org.ssa.assistant.core.device"
    compileSdk = 35

    defaultConfig {
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets {
        getByName("androidTest") {
            java.srcDir("../core/src/commonTest/kotlin")
            java.srcDir("../core/src/jvmTest/kotlin")
            java.srcDir("src/androidTest/kotlin")
            resources.srcDir("../core/src/commonTest/resources")
            manifest.srcFile("src/androidTest/AndroidManifest.xml")
        }
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

// :core's test sources reach the platform through an expect/actual pair
// (golden/TestPlatform.kt, golden/TestPlatform.jvm.kt), which a plain
// Android module cannot compile; this module leaves both out and supplies
// the same functions in src/androidTest/kotlin/.../TestPlatform.android.kt.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    if (name.endsWith("AndroidTestKotlin")) {
        exclude("**/golden/TestPlatform.kt", "**/golden/TestPlatform.jvm.kt")
    }
}

// The turn scenarios and answer fixtures :core's tests read, pinned and copied
// exactly as :core does for its JVM test run (they are not in
// core/src/commonTest/resources, which only holds the goldens).
androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val scenarios = tasks.register<CopyPinnedAssets>("copy${name}TurnScenarios") {
            sourceDir.set(rootProject.layout.projectDirectory.dir("../tools/turn-scenarios"))
            pins.set(rootProject.layout.projectDirectory.file("core/turn-scenarios.SHA256SUMS"))
            assetPath.set("turn-scenarios")
        }
        val fixtures = tasks.register<CopyPinnedAssets>("copy${name}AnswerFixtures") {
            sourceDir.set(rootProject.layout.projectDirectory.dir("../tests/fixtures/answers"))
            pins.set(rootProject.layout.projectDirectory.file("core/answer-fixtures.SHA256SUMS"))
            assetPath.set("fixtures/answers")
        }
        variant.androidTest?.sources?.resources?.let {
            it.addGeneratedSourceDirectory(scenarios, CopyPinnedAssets::outputDir)
            it.addGeneratedSourceDirectory(fixtures, CopyPinnedAssets::outputDir)
        }
    }
}

dependencies {
    androidTestImplementation(project(":core"))
    androidTestImplementation(libs.kotlinx.coroutines.core)
    androidTestImplementation(libs.junit)
    // :core's tests are written against kotlin.test, which maps onto JUnit 4 here.
    androidTestImplementation(kotlin("test-junit"))
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
}

// Kotlin 2.2 and later reject `android { kotlinOptions { ... } }`, so the JVM
// target lives in the Kotlin extension. This is the minimum change the Kotlin
// 2.4.21 upgrade needs (plan, B1).
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}
