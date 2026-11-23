// swift-tools-version: 5.9
import PackageDescription

// The iOS implementation of core's `Crypto` and `SessionKey` in Swift:
// CryptoKit is Swift-only and CommonCrypto's AES-GCM is not public API, so
// Kotlin iosMain cannot supply it (plan, Run 4, step 4).
//
// `SsaPdf` (Run 6, spike 3a) runs the JS PDF writer — vendor/pdf-lib.min.js
// and the generated vendor/ssa-pdf-writer.js — in a JavaScriptCore JSContext,
// and re-reads the result with a CGPDF PdfReadPort over the core PdfSelfCheck.
//
// The binary target is the :core framework, built by Gradle from android/:
//
//   ./gradlew :core:assembleSsaCoreDebugXCFramework
//
// and written to debug/SsaCore.xcframework beside this file, because SwiftPM
// does not accept a local binary target outside the package. Then, from this
// directory:
//
//   xcodebuild test -scheme CoreCrypto-Package \
//     -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
//
// With two library products SwiftPM makes one scheme per product plus
// `CoreCrypto-Package`, and only the package scheme has a test action, so
// `-scheme CoreCrypto` (Run 5's command) and `-scheme SsaPdf` cannot run the
// tests.
//
// No app and no .xcodeproj: xcodebuild builds the package in DerivedData.
let package = Package(
    name: "CoreCrypto",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "CoreCrypto", targets: ["CoreCrypto"]),
        .library(name: "SsaPdf", targets: ["SsaPdf"]),
    ],
    targets: [
        .binaryTarget(name: "SsaCore", path: "debug/SsaCore.xcframework"),
        .target(name: "CoreCrypto", dependencies: ["SsaCore"]),
        .testTarget(name: "CoreCryptoTests", dependencies: ["CoreCrypto"]),
        .target(name: "SsaPdf", dependencies: ["SsaCore"]),
        .testTarget(name: "SsaPdfTests", dependencies: ["SsaPdf", "SsaCore"]),
    ]
)
