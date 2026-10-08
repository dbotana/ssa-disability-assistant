// The optional LLM answer parser (llama.cpp through JNI, isolated process).
//
// The LLM is optional by design: it is enabled only when the device has
// >= 6 GB RAM, is not a low-RAM device, has arm64 dotprod, and passes a
// first-run benchmark; otherwise the app runs deterministic-only. The LLM is
// used ONLY to parse what the user said into a value for the current question
// — control flow, commands, validation, read-backs and PDF filling stay
// deterministic. See the plan: "The LLM: only a parser, boxed in by
// deterministic code".
//
// In the MVP skeleton this module carries only the AnswerParser interface and
// the eligibility gate; the native side lands in milestone M6.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "org.ssa.assistant.llm"
    compileSdk = 35

    defaultConfig {
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
