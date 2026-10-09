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
        // The spike's PDFs and their plans go out through TestStorage, and
        // AGP pulls them into build/outputs/connected_android_test_additional_output/
        // for tools/golden/crosscheck.mjs. Fixture answers only.
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
    }

    packaging {
        resources {
            excludes += listOf("META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
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
    api(libs.pdfbox.android)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.storage)
    androidTestUtil(libs.androidx.test.services)
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

        // The answer fixtures the instrumented fills use, pinned like :core's.
        val fixtures = tasks.register<CopyPinnedAssets>("copy${variant.name.replaceFirstChar { it.uppercase() }}AnswerFixtures") {
            sourceDir.set(rootProject.layout.projectDirectory.dir("../tests/fixtures/answers"))
            pins.set(rootProject.layout.projectDirectory.file("core/answer-fixtures.SHA256SUMS"))
            assetPath.set("fixtures/answers")
        }
        variant.androidTest?.sources?.resources?.addGeneratedSourceDirectory(fixtures, CopyPinnedAssets::outputDir)
    }
}
