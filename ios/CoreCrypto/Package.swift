// swift-tools-version: 5.9
import PackageDescription

// The iOS implementation of core's `Crypto` and `SessionKey`, in Swift:
// CryptoKit is Swift-only and CommonCrypto's AES-GCM is not public API, so
// Kotlin iosMain cannot supply it (plan, Run 4, step 4).
//
// The binary target is the :core framework, built by Gradle from android/:
//
//   ./gradlew :core:assembleSsaCoreDebugXCFramework
//
// and written to debug/SsaCore.xcframework beside this file, because SwiftPM
// does not accept a local binary target outside the package. Then, from this
// directory:
//
//   xcodebuild test -scheme CoreCrypto \
//     -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
//
// No app and no .xcodeproj: xcodebuild builds the package in DerivedData.
let package = Package(
    name: "CoreCrypto",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "CoreCrypto", targets: ["CoreCrypto"]),
    ],
    targets: [
        .binaryTarget(name: "SsaCore", path: "debug/SsaCore.xcframework"),
        .target(name: "CoreCrypto", dependencies: ["SsaCore"]),
        .testTarget(name: "CoreCryptoTests", dependencies: ["CoreCrypto"]),
    ]
)
