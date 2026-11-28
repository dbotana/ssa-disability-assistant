pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ssa-disability-assistant"

include(":core")
include(":models")
include(":core-device")
include(":pdf")
include(":speech")
include(":llm")
include(":app")
include(":ui")
include(":stt_pack")
include(":llm_pack")
include(":canary")
