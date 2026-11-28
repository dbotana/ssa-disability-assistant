import Foundation
import XCTest
import RepoFixtures
import SsaCore
@testable import SsaPdf
@testable import CoreCrypto

/// Spike 3c, the runtime half of the network audit. A `URLProtocol` trap is
/// registered for the whole process, then the JS writer fills both forms in
/// both versions of a Lingala session and a `SessionStore` round trip runs.
/// The trap must see no request. A second test makes one deliberate
/// `URLSession.shared` request and checks the trap saw it, so the first test
/// cannot pass vacuously.
///
/// This is its own test target, not part of SsaPdfTests: the deliberate request
/// puts `_OBJC_CLASS_$_NSURLSession` into this bundle, which therefore fails
/// ios/tools/audit-binary.sh by design. Our own test code is never allowlisted,
/// so keeping it here lets the CoreCryptoTests and SsaPdfTests bundles pass.
final class NetworkGuardTests: XCTestCase {

    private var sourceRoot: URL {
        URL(fileURLWithPath: #filePath)          // ios/CoreCrypto/Tests/NetworkGuardTests/NetworkGuardTests.swift
            .deletingLastPathComponent()          // NetworkGuardTests
            .deletingLastPathComponent()          // Tests
            .deletingLastPathComponent()          // CoreCrypto
            .deletingLastPathComponent()          // ios
            .deletingLastPathComponent()          // repository root
    }

    /// The source tree on the simulator, the staged copy on a phone (RepoFixtures).
    private var repoRoot: URL { RepoFixtures.root(sourceRoot: sourceRoot) }

    override func setUp() {
        super.setUp()
        RequestTrap.reset()
        XCTAssertTrue(URLProtocol.registerClass(RequestTrap.self))
        // An XCTest bundle has no app main bundle, so point the Kotlin
        // readResource at the repository directories (IosResources.roots),
        // exactly as PdfSpikeTests does.
        IosResources.shared.roots = [
            repoRoot.appendingPathComponent("android/core/src/commonMain/resources").path,
            repoRoot.appendingPathComponent("tools").path,
        ]
    }

    override func tearDown() {
        URLProtocol.unregisterClass(RequestTrap.self)
        super.tearDown()
    }

    func testNoRequestDuringFillAndSessionStore() throws {
        // 1. The writer, its scripts checked against the pins.
        let pdfLib = try Data(contentsOf: repoRoot.appendingPathComponent("vendor/pdf-lib.min.js"))
        let writerScript = try Data(contentsOf: repoRoot.appendingPathComponent("vendor/ssa-pdf-writer.js"))
        let pins = try String(contentsOf: repoRoot.appendingPathComponent("vendor/SHA256SUMS"), encoding: .utf8)
        let writer = try PdfWriter(pdfLib: pdfLib, writer: writerScript, pins: pins)

        // 2-3. Every ln-both version in the golden, A and (if present) B, in
        // memory only: nothing is written to .build/pdf-spike/.
        let templatePaths = [
            "ssa": "forms/ssa-adult-disability-starter-kit-64-110.pdf",
            "ds": "forms/maine-developmental-services-intake-2025-06-18.pdf",
        ]
        let fillplans = try readJSON("android/core/src/commonTest/resources/golden/fillplans.json")
        let versions = try XCTUnwrap(fillplans["versions"] as? [[String: Any]])
        var writes = 0
        for entry in versions where entry["fixture"] as? String == "ln-both" {
            let form = try XCTUnwrap(entry["form"] as? String)
            let templatePath = try XCTUnwrap(templatePaths[form], "unknown form \(form)")
            let template = try Data(contentsOf: repoRoot.appendingPathComponent(templatePath))
            for key in ["a", "b"] {
                guard let record = entry[key] as? [String: Any] else { continue }
                let planJSON = try jsonText(try XCTUnwrap(record["plan"]))
                let pages = record["pages"] as? [Any] ?? []
                let drawListJSON: String? = pages.isEmpty ? nil : try jsonText(["pages": pages])
                let (bytes, missing, _) = try writer.write(
                    template: template, planJSON: planJSON, drawListJSON: drawListJSON,
                    title: "network guard", creator: FormDocuments.shared.CREATOR
                )
                XCTAssertEqual(missing, [], "\(form) \(key): the writer reported missing fields")
                XCTAssertFalse(bytes.isEmpty, "\(form) \(key): the writer returned no bytes")
                writes += 1
            }
        }
        XCTAssertEqual(writes, 4, "expected the four ln-both PDFs")

        // 4. The SessionStore round trip from CoreCryptoTests.testSessionStoreRoundTrip.
        let schemaText = try String(
            contentsOf: repoRoot.appendingPathComponent("tools/schema.json"),
            encoding: .utf8
        )
        let schema = SchemaLoader.shared.load(json: JsonParser.shared.parse(text: schemaText))
        let files = MemoryFiles()
        let now = 1_789_819_200_000.0
        let store = SessionStore(
            schema: schema,
            crypto: CoreCrypto(),
            files: files,
            clock: { KotlinDouble(double: now) }
        )
        store.usePin(pin: "2468")
        let state = try XCTUnwrap(JsonKt.asObject(JsonParser.shared.parse(
            text: #"{"answers":{"first_name":"Ada","ssn":"123-45-6789"}}"#
        )))
        XCTAssertTrue(store.saveState(state: state))

        let reopened = SessionStore(
            schema: schema,
            crypto: CoreCrypto(),
            files: files,
            clock: { KotlinDouble(double: now) }
        )
        let opened = reopened.unlock(pin: "2468")
        let answers = try XCTUnwrap(JsonKt.asObject(try XCTUnwrap(opened.state.get(key: "answers"))))
        XCTAssertEqual(JsonKt.asString(try XCTUnwrap(answers.get(key: "first_name"))), "Ada")

        // 5. Nothing above asked for the network.
        let seen = RequestTrap.snapshot()
        XCTAssertEqual(seen, [], "a request was made: \(seen)")
    }

    func testTrapCatchesADeliberateRequest() {
        let exp = expectation(description: "the deliberate request completes")
        URLSession.shared.dataTask(with: URL(string: "https://example.invalid/network-guard")!) { _, _, error in
            XCTAssertNotNil(error, "the trap fails every request locally")
            exp.fulfill()
        }.resume()
        wait(for: [exp], timeout: 10)

        let seen = RequestTrap.snapshot()
        XCTAssertTrue(seen.contains { $0.host == "example.invalid" },
                      "the trap did not see the deliberate URLSession.shared request: \(seen)")
    }

    private func readJSON(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: repoRoot.appendingPathComponent(path))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func jsonText(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        return String(decoding: data, as: UTF8.self)
    }
}

/// Records the URL of every request the URL loading system offers it, and
/// fails each one locally, so nothing ever reaches the network.
final class RequestTrap: URLProtocol {
    private static let lock = NSLock()
    private static var seen: [URL] = []

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        seen.removeAll()
    }

    static func snapshot() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    override class func canInit(with request: URLRequest) -> Bool {
        if let url = request.url {
            lock.lock()
            seen.append(url)
            lock.unlock()
        }
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }

    override func stopLoading() {}
}

/// `FileStore` over a dictionary, copied from CoreCryptoTests: the XCTest has
/// no app sandbox to write to.
private final class MemoryFiles: NSObject, FileStore {
    private var files: [String: String] = [:]

    func read(name: String) -> String? { files[name] }
    func write(name: String, text: String) { files[name] = text }
    func delete(name: String) { files[name] = nil }
}
