// The permission-audit canary: a deliberately bad app that requests INTERNET
// and nothing else. CI builds its APK and AAB and requires
// tools/audit-permissions.sh to FAIL on each, which proves the audit can see a
// forbidden permission in the same artifact formats the real app ships as. A
// raw-XML canary alone could not: it exercised none of the APK and AAB paths.
// Never released, and nothing depends on it.
plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "org.ssa.assistant.canary"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.ssa.assistant.canary"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "canary"
    }
}
