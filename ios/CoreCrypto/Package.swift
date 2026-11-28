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
// The binary target is the single Kotlin framework the iOS app links, built by
// Gradle from android/ by `:ui`, which exports `:core` and `:models` so the
// app carries one Kotlin runtime (plan, Phase B3):
//
//   ./gradlew :ui:assembleSsaCoreDebugXCFramework
//
// and written to debug/SsaCore.xcframework beside this file, because SwiftPM
// does not accept a local binary target outside the package. Then, from this
// directory:
//
//   xcodebuild test -scheme CoreCrypto-Package \
//     -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
//
// That is still the test command. SwiftPM makes one scheme per library product
// (`CoreCrypto`, `SsaPdf` and, since Run 7, `NetCanary`) plus
// `CoreCrypto-Package`, and only the package scheme has a test action, so
// `-scheme CoreCrypto` (Run 5's command), `-scheme SsaPdf` and
// `-scheme NetCanary` cannot run the tests.
//
// No app and no .xcodeproj: xcodebuild builds the package in DerivedData.
//
// Spike 3c (Run 7), the binary network audit, ios/tools/audit-binary.sh:
// - `NetCanary` exists only to make the audit fail: it calls
//   URLSession.shared.dataTask(with:), so its NetCanary.o must fail, naming
//   NSURLSession. Nothing depends on it, and it must stay out of every product
//   the app links.
// - `NetworkGuardTests` holds the URLProtocol runtime test: no request during
//   the JS writer fill of both forms and a SessionStore round trip, plus one
//   deliberate URLSession request that proves the trap sees traffic. Because
//   of that deliberate request its bundle fails the audit by design, so it is
//   a separate target and the CoreCryptoTests and SsaPdfTests bundles stay
//   clean.
//
// To audit, build into the repository, then run each audit from the repository
// root (P = ios/CoreCrypto/.build/xcode/Build/Products/Debug-iphonesimulator):
//
//   xcodebuild build-for-testing -scheme CoreCrypto-Package \
//     -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
//     -derivedDataPath <repo>/ios/CoreCrypto/.build/xcode
//   ios/tools/audit-binary.sh ios/CoreCrypto/debug/SsaCore.xcframework       # exit 0
//   ios/tools/audit-binary.sh P/CoreCrypto.o P/SsaPdf.o                       # exit 0
//   ios/tools/audit-binary.sh P/CoreCryptoTests.xctest P/SsaPdfTests.xctest   # exit 0
//   ios/tools/audit-binary.sh P/NetCanary.o                                   # exit 1
//   ios/tools/audit-binary.sh P/NetworkGuardTests.xctest                      # exit 1
//
// `node tests/ios-audit.js` runs the clean set and the canary when the
// products are built.
//
// On a phone. The tests read the repository's files from the source tree on
// the simulator and the host. A phone cannot see the Mac's disk, so stage a
// copy into the test bundles first (`RepoFixtures`, test-only, in no product).
// The phone needs Developer Mode on and an Apple ID signed in to Xcode
// (Settings > Accounts). From the repository root:
//
//   ios/tools/stage-device-fixtures.sh
//
// then, from this directory, with the phone's UDID and the team id:
//
//   xcodebuild test -scheme CoreCrypto-Package \
//     -destination 'platform=iOS,id=<UDID>' \
//     -allowProvisioningUpdates DEVELOPMENT_TEAM=<team id>
//
// `TEST_RUNNER_SSA_FIXTURES=bundle` before a simulator run makes it read the
// staged copy, to try the phone path without a phone.
let package = Package(
    name: "CoreCrypto",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "CoreCrypto", targets: ["CoreCrypto"]),
        .library(name: "SsaPdf", targets: ["SsaPdf"]),
        .library(name: "NetCanary", targets: ["NetCanary"]),
        // What ios/App links: both targets in one product. When the app and
        // its unit-test bundle both depend on package products, Xcode makes
        // each product a dynamic framework, and with `CoreCrypto` and `SsaPdf`
        // separate each carried its own copy of the static SsaCore, so the app
        // had two Kotlin runtimes and crashed passing an object between them.
        // One product means one copy, one runtime (plan, B3).
        .library(name: "SsaKit", targets: ["CoreCrypto", "SsaPdf"]),
    ],
    targets: [
        .binaryTarget(name: "SsaCore", path: "debug/SsaCore.xcframework"),
        // SsaCore exports :models, whose cinterop calls ORT's C API, and a
        // static Kotlin framework carries no third-party library. The same
        // Gradle task copies the pinned ORT xcframework here; the link flags
        // are :models' own (android/models/build.gradle.kts): libc++ and CoreML.
        .binaryTarget(name: "onnxruntime", path: "debug/onnxruntime.xcframework"),
        .target(
            name: "CoreCrypto",
            dependencies: ["SsaCore", "onnxruntime"],
            linkerSettings: [.linkedLibrary("c++"), .linkedFramework("CoreML")]
        ),
        .target(name: "RepoFixtures", resources: [.copy("repo")]),
        .testTarget(name: "CoreCryptoTests", dependencies: ["CoreCrypto", "RepoFixtures"]),
        .target(
            name: "SsaPdf",
            dependencies: ["SsaCore", "onnxruntime"],
            linkerSettings: [.linkedLibrary("c++"), .linkedFramework("CoreML")]
        ),
        .testTarget(name: "SsaPdfTests", dependencies: ["SsaPdf", "SsaCore", "RepoFixtures"]),
        .target(name: "NetCanary"),
        .testTarget(name: "NetworkGuardTests", dependencies: ["SsaPdf", "CoreCrypto", "SsaCore", "RepoFixtures"]),
    ]
)
