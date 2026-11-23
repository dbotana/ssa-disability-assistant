import Foundation
import SsaCore

// The Kotlin/Native framework has no Data bridge of its own. CoreCrypto keeps
// its own internal copy (an `init(_:)` convenience initializer and a `data()`
// method); SsaPdf needs the same loop but must not clash with those names, so
// it exposes these `from`/`toData` forms instead.
public extension KotlinByteArray {
    static func from(_ data: Data) -> KotlinByteArray {
        let array = KotlinByteArray(size: Int32(data.count))
        for (index, byte) in data.enumerated() {
            array.set(index: Int32(index), value: Int8(bitPattern: byte))
        }
        return array
    }

    func toData() -> Data {
        var out = Data(capacity: Int(size))
        for index in 0 ..< Int(size) {
            out.append(UInt8(bitPattern: get(index: Int32(index))))
        }
        return out
    }
}
