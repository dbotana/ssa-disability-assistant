// The :core goldens and unit tests, run on Android.
//
// :core is plain JVM, so its tests run on the desktop JVM — where
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
            java.srcDir("../core/src/test/kotlin")
            resources.srcDir("../core/src/test/resources")
            manifest.srcFile("src/androidTest/AndroidManifest.xml")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources {
            excludes += listOf("META-INF/LICENSE*", "META-INF/NOTICE*")
        }
    }
}

dependencies {
    androidTestImplementation(project(":core"))
    androidTestImplementation(libs.kotlinx.coroutines.core)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
}
