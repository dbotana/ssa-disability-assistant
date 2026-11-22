import CommonCrypto
import SsaCore
import CryptoKit
import Foundation

/// The key PBKDF2 derived. Kotlin's `SessionStore` keeps it and hands it back
/// to `encrypt` and `decrypt`; it never sees the key material.
final class GcmSessionKey: NSObject, SessionKey {
    let key: SymmetricKey

    init(_ key: SymmetricKey) {
        self.key = key
    }
}

/// `Crypto` in the iOS shell: CommonCrypto's PBKDF2-HMAC-SHA256, CryptoKit's
/// AES-256-GCM, and Foundation's NFC, which is exactly what store.js asks
/// WebCrypto for. The `store` golden's test vector, made with crypto.subtle
/// in Node, decrypts with this class (Tests/CoreCryptoTests).
public final class CoreCrypto: NSObject, Crypto {

    public override init() {
        super.init()
    }

    public func randomBytes(size: Int32) -> KotlinByteArray {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0 ..< Int(size)).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return KotlinByteArray(Data(bytes))
    }

    public func deriveKey(pin: String, salt: KotlinByteArray, iterations: Int32) -> SessionKey {
        // WebCrypto derives from the UTF-8 bytes of String(pin).normalize('NFC').
        let password = Array(pin.precomposedStringWithCanonicalMapping.utf8)
        let saltBytes = salt.data()
        var derived = [UInt8](repeating: 0, count: 32)
        let status = password.withUnsafeBytes { passwordBuffer in
            saltBytes.withUnsafeBytes { saltBuffer in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    passwordBuffer.bindMemory(to: Int8.self).baseAddress,
                    password.count,
                    saltBuffer.bindMemory(to: UInt8.self).baseAddress,
                    saltBytes.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(iterations),
                    &derived,
                    derived.count
                )
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 failed with status \(status)")
        return GcmSessionKey(SymmetricKey(data: Data(derived)))
    }

    /// The tag is appended to the ciphertext, as WebCrypto returns it.
    public func encrypt(key: SessionKey, iv: KotlinByteArray, plaintext: KotlinByteArray) -> KotlinByteArray {
        let sessionKey = key as! GcmSessionKey
        let sealed = try! AES.GCM.seal(
            plaintext.data(),
            using: sessionKey.key,
            nonce: try! AES.GCM.Nonce(data: iv.data())
        )
        return KotlinByteArray(sealed.ciphertext + sealed.tag)
    }

    /// Nil for the wrong key or changed bytes. Kotlin's `Crypto.decrypt` returns
    /// nil too: a Swift method cannot throw a Kotlin exception across the
    /// Objective-C boundary.
    public func decrypt(key: SessionKey, iv: KotlinByteArray, ciphertext: KotlinByteArray) -> KotlinByteArray? {
        let sessionKey = key as! GcmSessionKey
        let bytes = ciphertext.data()
        guard bytes.count >= 16 else { return nil }
        do {
            let box = try AES.GCM.SealedBox(
                nonce: try AES.GCM.Nonce(data: iv.data()),
                ciphertext: bytes.dropLast(16),
                tag: bytes.suffix(16)
            )
            return KotlinByteArray(try AES.GCM.open(box, using: sessionKey.key))
        } catch {
            return nil
        }
    }
}

// The Kotlin/Native framework has no Data bridge of its own.
extension KotlinByteArray {
    convenience init(_ data: Data) {
        self.init(size: Int32(data.count))
        for (index, byte) in data.enumerated() {
            set(index: Int32(index), value: Int8(bitPattern: byte))
        }
    }

    func data() -> Data {
        var out = Data(capacity: Int(size))
        for index in 0 ..< Int(size) {
            out.append(UInt8(bitPattern: get(index: Int32(index))))
        }
        return out
    }
}
