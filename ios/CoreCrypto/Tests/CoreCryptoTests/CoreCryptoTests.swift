import XCTest
import SsaCore
@testable import CoreCrypto

/// The `store` golden's WebCrypto vector, decrypted with the iOS `Crypto`,
/// and an envelope round-tripped through Kotlin's `SessionStore` with this
/// `Crypto` in place. The same vector runs on the JVM (JvmCryptoVectorTest):
/// a session file written by the web app opens on iOS, and one written on
/// iOS opens on the web.
final class CoreCryptoTests: XCTestCase {

    // The golden and the schema are read from the repository, not copied into
    // this package: there is one `store.json`, produced by the JS reference,
    // and a second copy would drift.
    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)          // ios/CoreCrypto/Tests/CoreCryptoTests/CoreCryptoTests.swift
            .deletingLastPathComponent()          // CoreCryptoTests
            .deletingLastPathComponent()          // Tests
            .deletingLastPathComponent()          // CoreCrypto
            .deletingLastPathComponent()          // ios
            .deletingLastPathComponent()          // repository root
    }

    private func readJSON(_ path: String) throws -> [String: Any] {
        let url = repoRoot.appendingPathComponent(path)
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func bytes(_ base64: String) -> KotlinByteArray {
        KotlinByteArray(Data(base64Encoded: base64)!)
    }

    private func data(_ array: KotlinByteArray) -> Data {
        array.data()
    }

    func testWebCryptoVectorDecrypts() throws {
        let golden = try readJSON("android/core/src/commonTest/resources/golden/store.json")
        let vector = try XCTUnwrap(golden["vector"] as? [String: Any])
        let envelope = try XCTUnwrap(vector["envelope"] as? [String: Any])
        let crypto = CoreCrypto()

        let pin = try XCTUnwrap(vector["pin"] as? String)          // NFD, as typed
        let pinNfc = try XCTUnwrap(vector["pinNfc"] as? String)
        let iterations = try XCTUnwrap(vector["iterations"] as? Int)
        let salt = bytes(try XCTUnwrap(vector["salt"] as? String))
        let iv = bytes(try XCTUnwrap(vector["iv"] as? String))

        // PBKDF2-HMAC-SHA256 over the NFC form, which is what store.js asks
        // WebCrypto for. The vector's `key` is the raw 32 bytes.
        let key = crypto.deriveKey(pin: pin, salt: salt, iterations: Int32(iterations))
        let derived = try XCTUnwrap(key as? GcmSessionKey)
        let derivedBytes = derived.key.withUnsafeBytes { Data($0) }
        XCTAssertEqual(derivedBytes, data(bytes(try XCTUnwrap(vector["key"] as? String))),
                       "PBKDF2 of the NFC form must match the vector's key")
        XCTAssertEqual(derivedBytes, derivedBytesOf(crypto, pinNfc, salt, Int32(iterations)),
                       "NFD and NFC spellings of the same PIN must derive the same key")

        let plain = try XCTUnwrap(crypto.decrypt(
            key: key,
            iv: iv,
            ciphertext: bytes(try XCTUnwrap(envelope["data"] as? String))
        ))
        XCTAssertEqual(String(decoding: data(plain), as: UTF8.self),
                       try XCTUnwrap(vector["plaintext"] as? String))

        XCTAssertNil(crypto.decrypt(
            key: crypto.deriveKey(pin: try XCTUnwrap(vector["wrongPin"] as? String), salt: salt, iterations: Int32(iterations)),
            iv: iv,
            ciphertext: bytes(try XCTUnwrap(envelope["data"] as? String))
        ), "a wrong PIN must not open the envelope")

        XCTAssertNil(crypto.decrypt(
            key: key,
            iv: iv,
            ciphertext: bytes(try XCTUnwrap(vector["tamperedData"] as? String))
        ), "changed bytes must not open the envelope")
    }

    private func derivedBytesOf(_ crypto: CoreCrypto, _ pin: String, _ salt: KotlinByteArray, _ iterations: Int32) -> Data {
        let key = crypto.deriveKey(pin: pin, salt: salt, iterations: iterations) as! GcmSessionKey
        return key.key.withUnsafeBytes { Data($0) }
    }

    /// A save with this `Crypto` writes an envelope that Kotlin's own
    /// `SessionStore.unlock` reads back, and the sensitive field stays out of
    /// the file.
    func testSessionStoreRoundTrip() throws {
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

        let saved = try XCTUnwrap(files.read(name: StoreFormat.shared.STATE_FILE))
        XCTAssertTrue(saved.contains(#""v":3"#))
        XCTAssertTrue(saved.contains("PBKDF2-SHA256"))
        XCTAssertFalse(saved.contains("Ada"), "answers are inside the ciphertext")
        XCTAssertFalse(saved.contains("123-45-6789"), "a Social Security number is never written, encrypted or not")

        // A fresh store, as after an app restart: the same file, the same PIN.
        let reopened = SessionStore(
            schema: schema,
            crypto: CoreCrypto(),
            files: files,
            clock: { KotlinDouble(double: now) }
        )
        let opened = reopened.unlock(pin: "2468")
        let answers = try XCTUnwrap(JsonKt.asObject(try XCTUnwrap(opened.state.get(key: "answers"))))
        XCTAssertEqual(JsonKt.asString(try XCTUnwrap(answers.get(key: "first_name"))), "Ada")
        XCTAssertTrue(opened.withheld.contains { JsonKt.asString($0.get(key: "id")!) == "ssn" },
                      "the withheld list names the Social Security number")
    }

    func testRandomBytes() {
        let crypto = CoreCrypto()
        let a = data(crypto.randomBytes(size: 32))
        let b = data(crypto.randomBytes(size: 32))
        XCTAssertEqual(a.count, 32)
        XCTAssertEqual(b.count, 32)
        XCTAssertNotEqual(a, b)
    }
}

/// `FileStore` over a dictionary: the XCTest has no app sandbox to write to.
private final class MemoryFiles: NSObject, FileStore {
    private var files: [String: String] = [:]

    func read(name: String) -> String? { files[name] }
    func write(name: String, text: String) { files[name] = text }
    func delete(name: String) { files[name] = nil }
}
