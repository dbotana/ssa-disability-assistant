// PDF filling on Android. PdfBox-Android (Apache-2.0) is used only as the PDF
// object model: load, set /V, /DA, /AP and /AS, add pages, save. Its own
// appearance generator is never used — TextFitter in :core does all measuring,
// and AcroFormWriter draws each /AP /N stream itself. See the plan:
// "PDF filling on Android".
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "org.ssa.assistant.pdf"
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
    api(libs.pdfbox.android)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

// The blank official templates, from the repo's forms/, checked against the
// pins in forms.SHA256SUMS (TemplateLoader re-checks the hash at load time).
androidComponents {
    onVariants { variant ->
        val copy = tasks.register<CopyPinnedAssets>("copy${variant.name.replaceFirstChar { it.uppercase() }}PinnedForms") {
            sourceDir.set(rootProject.layout.projectDirectory.dir("../forms"))
            pins.set(layout.projectDirectory.file("forms.SHA256SUMS"))
            assetPath.set("forms")
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyPinnedAssets::outputDir)
    }
}
