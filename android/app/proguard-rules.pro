# R8 configuration. Logging is stripped in release so transcripts and answers
# can never reach logcat. No crash SDK is linked.
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
    public static *** wtf(...);
    public static *** println(...);
}

# A stack trace goes to System.err, which Android copies to logcat, and its
# message can carry the value being parsed.
-assumenosideeffects class java.lang.Throwable {
    public void printStackTrace();
}

# System.out and System.err cannot be stripped this way without stripping
# every PrintStream, a file writer included; the app's code does not use them.

# pdfbox-android: keep the loader entry point PdfBox-Android requires.
-keep class com.tom_roush.pdfbox.android.PDFBoxResourceLoader { *; }

# pdfbox-android's JPX (JPEG 2000) filter names gemalto's optional jp2
# decoder/encoder, which the AAR does not ship. Neither template contains a
# JPEG 2000 image, so the filter is never reached; silence R8 on exactly
# those two classes rather than the whole package or PDFBox.
-dontwarn com.gemalto.jp2.JP2Decoder
-dontwarn com.gemalto.jp2.JP2Encoder
