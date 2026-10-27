# The instrumented test calls this entry point, which R8 cannot see as a
# reference. Keeping it keeps the PDF-filling path reachable and executable
# under the same shrinking the release build uses.
-keep class org.ssa.assistant.app.PdfSpikeEntry { public *; }

# The androidTest APK is shrunk under the same build type. Its test-only
# dependencies (error-prone annotations) name a compile-time JDK type that
# does not exist on Android; nothing in the test calls it.
-dontwarn javax.lang.model.element.Modifier

# The test APK carries androidx.test but not the Kotlin stdlib: it resolves
# that from the app APK, as it does in debug. Under R8 the app APK's copy is
# shrunk and inlined, so the runner and the test cannot link against it.
# These are the two classes the run actually needed (LazyKt in the runner,
# StringsKt in the test). Staging only: the shipped release build does not
# see this file and keeps its full shrinking.
-keep class kotlin.LazyKt { *; }
-keep class kotlin.text.StringsKt { *; }
