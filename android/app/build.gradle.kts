// The app: Compose UI, encrypted session store, export via SAF, and the
// in-memory share provider. See the plan: "Delivery (app)".
//
// Privacy invariants enforced by the manifest below:
//   - no INTERNET, no ACCESS_NETWORK_STATE — removed from the merged manifest
//     with tools:node="remove" and verified by CI on every artifact;
//   - allowBackup="false" + dataExtractionRules excluding everything;
//   - FLAG_SECURE and setRecentsScreenshotEnabled(false) at runtime.
import com.android.build.api.artifact.SingleArtifact

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

/**
 * Fails the build when a merged manifest requests a network permission — the
 * first of the three permission layers (tools/audit-permissions.sh has the
 * other two). A library that adds INTERNET is caught here, before any
 * artifact exists, with the variant named.
 */
abstract class VerifyNoNetworkPermissions : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val mergedManifest: RegularFileProperty

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun verify() {
        val text = mergedManifest.get().asFile.readText()
        val forbidden = Regex("<uses-permission(?:-sdk-23)?[^>]*android:name=\"(android\\.permission\\.(?:INTERNET|ACCESS_NETWORK_STATE))\"")
        val hits = forbidden.findAll(text).map { it.groupValues[1] }.toList()
        if (hits.isNotEmpty()) {
            throw GradleException("${mergedManifest.get().asFile}: the merged manifest requests ${hits.joinToString()}. This app must have no network access.")
        }
        report.get().asFile.writeText("no network permissions\n")
    }
}

android {
    namespace = "org.ssa.assistant.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.ssa.assistant.app"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
    }

    buildTypes {
        debug {
            // Only the debug build includes x86_64 (for the emulator).
            ndk {
                abiFilters += listOf("arm64-v8a", "x86_64")
            }
        }
        release {
            isMinifyEnabled = true
            // R8 strips Log calls; no crash SDK is linked.
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            ndk {
                abiFilters += listOf("arm64-v8a")
            }
        }
    }

    bundle {
        language {
            enableSplit = false
        }
        // Device targeting for llm_pack (>= 6 GB RAM); see device_targeting_config.xml.
        deviceTargetingConfig = file("device_targeting_config.xml")
    }

    // stt_pack only. llm_pack is not bundled yet: delivering it to the
    // >= 6 GB group alone needs device-group targeting, which a plain asset
    // pack cannot do — bundletool 1.17 rejects a "#group_" asset folder
    // ("unsupported key 'group'"). It lands with the AI-pack plugin (M6/M7);
    // see llm_pack/build.gradle.kts and TODO.md.
    assetPacks += listOf(":stt_pack")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":pdf"))
    implementation(project(":speech"))
    implementation(project(":llm"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.compose.ui)
    debugImplementation(libs.androidx.compose.ui.tooling)
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val verify = tasks.register<VerifyNoNetworkPermissions>("verify${name}NoNetworkPermissions") {
            mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            report.set(layout.buildDirectory.file("reports/permissions/${variant.name}.txt"))
        }
        // Every way an artifact gets built runs the check first.
        tasks.matching { it.name == "assemble$name" || it.name == "bundle$name" || it.name == "check" }
            .configureEach { dependsOn(verify) }
    }
}

