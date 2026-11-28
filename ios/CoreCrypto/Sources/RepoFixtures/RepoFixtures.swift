import Foundation

/// Where the package's tests read the repository's files from: the forms, the
/// vendor scripts and their pins, the goldens and `tools/schema.json`.
///
/// On the simulator and the host the source tree is readable at the path each
/// test file was compiled from, so the tests read the live repository files,
/// and there is still one copy of every golden. A phone cannot see the Mac's
/// disk, so there the tests read the copy that `ios/tools/stage-device-fixtures.sh`
/// put into this target's `repo` resource folder, with the same layout as the
/// repository.
///
/// `SSA_FIXTURES=bundle` in the test process (pass `TEST_RUNNER_SSA_FIXTURES=bundle`
/// to xcodebuild) uses the bundled copy on the simulator too, to try the phone
/// path without a phone.
///
/// Test-only: no product contains this target.
public enum RepoFixtures {

    /// A file every staged copy and every checkout has.
    private static let marker = "tools/schema.json"

    /// The repository root the tests should read from, given the root computed
    /// from the test file's `#filePath`.
    public static func root(sourceRoot: URL) -> URL {
        usesBundle(sourceRoot: sourceRoot) ? bundled : sourceRoot
    }

    /// True when the tests read the staged copy, not the source tree.
    public static func usesBundle(sourceRoot: URL) -> Bool {
        if ProcessInfo.processInfo.environment["SSA_FIXTURES"] == "bundle" { return true }
        return !FileManager.default.fileExists(atPath: sourceRoot.appendingPathComponent(marker).path)
    }

    /// Where a test may write files: the repository's `ios/CoreCrypto/.build/<name>`
    /// when it reads the source tree, otherwise the test process's temporary
    /// directory (an app bundle on a phone is read-only).
    public static func outputDirectory(sourceRoot: URL, name: String) -> URL {
        usesBundle(sourceRoot: sourceRoot)
            ? FileManager.default.temporaryDirectory.appendingPathComponent(name)
            : sourceRoot.appendingPathComponent("ios/CoreCrypto/.build").appendingPathComponent(name)
    }

    /// "iOS Simulator <model> <os>" on the simulator, as the spike records have
    /// always said, and "iOS device <model> <os>" on a phone, for example
    /// "iOS device iPhone15,4 Version 26.6.2 (Build 23G90)".
    public static var deviceLabel: String {
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        if let simulator = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return "iOS Simulator \(simulator) \(os)"
        }
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return "iOS device \(machine) \(os)"
    }

    private static var bundled: URL {
        guard let url = Bundle.module.url(forResource: "repo", withExtension: nil),
              FileManager.default.fileExists(atPath: url.appendingPathComponent(marker).path)
        else {
            let message = "RepoFixtures: the source tree is not readable and no staged copy is in the bundle; "
                + "run ios/tools/stage-device-fixtures.sh from the repository root, then build again"
            FileHandle.standardError.write(Data((message + "\n").utf8))
            return Bundle.module.bundleURL.appendingPathComponent("repo")
        }
        return url
    }
}
