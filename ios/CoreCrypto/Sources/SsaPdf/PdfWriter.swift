import CryptoKit
import Foundation
import JavaScriptCore

/// Errors from loading the pinned scripts or from a fill that could not be
/// completed. Each is thrown, never silently ignored, so a failed fill falls
/// through to the worksheet rather than handing out a broken or unverified PDF.
public enum PdfWriterError: Error {
    case pinMismatch(String)
    case networkGlobal(String)
    case script(String)
    case didNotSettle
    case badResult(String)
}

/// The iOS PDF writer: the vendored pdf-lib and the generated writer bundle,
/// run in a `JSContext`. The scripts' SHA-256 pins are checked before either
/// is evaluated, and the context must not expose any network global.
public final class PdfWriter {

    public let loadMs: Double
    private let context: JSContext

    private final class ExceptionBox {
        var message: String?
    }

    /// Load and verify the two pinned scripts.
    public init(pdfLib: Data, writer: Data, pins: String) throws {
        let pinMap = Self.parsePins(pins)
        try Self.requirePin(pinMap, name: "pdf-lib.min.js", data: pdfLib)
        try Self.requirePin(pinMap, name: "ssa-pdf-writer.js", data: writer)

        let box = ExceptionBox()
        let context = JSContext()!
        context.exceptionHandler = { _, exception in
            box.message = exception?.toString()
        }
        self.context = context

        let clock = ContinuousClock()
        let started = clock.now
        try Self.setup(context: context, box: box, pdfLib: pdfLib, writer: writer, prelude: nil)
        self.loadMs = Self.milliseconds(from: started, to: clock.now)
    }

    /// Test-only: skip the pin check and evaluate `prelude` before pdf-lib.
    internal init(pdfLib: Data, writer: Data, prelude: String) throws {
        let box = ExceptionBox()
        let context = JSContext()!
        context.exceptionHandler = { _, exception in
            box.message = exception?.toString()
        }
        self.context = context

        let clock = ContinuousClock()
        let started = clock.now
        try Self.setup(context: context, box: box, pdfLib: pdfLib, writer: writer, prelude: prelude)
        self.loadMs = Self.milliseconds(from: started, to: clock.now)
    }

    /// Fill a template. Bytes go in and come out as typed arrays; the plan and
    /// draw list are JSON, exactly what the generated `fillForHost` expects.
    public func write(template: Data, planJSON: String, drawListJSON: String?, title: String, creator: String)
        throws -> (bytes: Data, missing: [String], writeMs: Double) {

        let ctxRef = context.jsGlobalContextRef

        // -- bytes in, as a typed array -------------------------------------
        var exc: JSValueRef?
        guard let arr = JSObjectMakeTypedArray(ctxRef, kJSTypedArrayTypeUint8Array, template.count, &exc) else {
            throw PdfWriterError.badResult(describe(exc))
        }
        guard let ptr = JSObjectGetTypedArrayBytesPtr(ctxRef, arr, &exc) else {
            throw PdfWriterError.badResult(describe(exc))
        }
        template.copyBytes(to: ptr.assumingMemoryBound(to: UInt8.self), count: template.count)
        let input = JSValue(jsValueRef: arr, in: context)!

        guard let writer = context.objectForKeyedSubscript("SsaPdfWriter"),
              let promise = writer.invokeMethod("fillForHost", withArguments: [
                  input, planJSON, drawListJSON ?? NSNull(), title, creator, true
              ]) else {
            throw PdfWriterError.badResult("SsaPdfWriter.fillForHost is missing")
        }

        var resultValue: JSValue?
        var errorString: String?
        let onFulfilled: @convention(block) (JSValue) -> Void = { resultValue = $0 }
        let onRejected: @convention(block) (JSValue) -> Void = { errorString = $0.toString() }
        promise.invokeMethod("then", withArguments: [onFulfilled, onRejected])

        // The setTimeout shim keeps pdf-lib's async work on JavaScriptCore's
        // microtask queue, which is drained when the outermost call returns;
        // drain once more defensively if the promise still had not settled.
        if resultValue == nil && errorString == nil {
            _ = context.evaluateScript("void 0")
        }
        if let errorString { throw PdfWriterError.script(errorString) }
        guard let result = resultValue else { throw PdfWriterError.didNotSettle }

        // -- bytes out, from the typed array ---------------------------------
        guard let bytesValue = result.objectForKeyedSubscript("bytes") else {
            throw PdfWriterError.badResult("no bytes in the writer result")
        }
        let bytesRef = bytesValue.jsValueRef
        guard JSValueGetTypedArrayType(ctxRef, bytesRef, &exc) == kJSTypedArrayTypeUint8Array,
              JSObjectGetTypedArrayByteOffset(ctxRef, bytesRef, &exc) == 0,
              let outPtr = JSObjectGetTypedArrayBytesPtr(ctxRef, bytesRef, &exc) else {
            throw PdfWriterError.badResult(describe(exc))
        }
        let outLength = JSObjectGetTypedArrayByteLength(ctxRef, bytesRef, &exc)
        let bytes = Data(bytes: outPtr, count: outLength)

        let missing = (result.objectForKeyedSubscript("missing")?.toArray() ?? []).map { item -> String in
            if let string = item as? String { return string }
            if let value = item as? JSValue { return value.toString() ?? "" }
            return String(describing: item)
        }
        let writeMs = result.objectForKeyedSubscript("writeMs")?.toNumber()?.doubleValue ?? 0

        return (bytes, missing, writeMs)
    }

    // -- setup and helpers ----------------------------------------------------

    private static func setup(context: JSContext, box: ExceptionBox, pdfLib: Data, writer: Data, prelude: String?) throws {
        guard let pdfLibText = String(data: pdfLib, encoding: .utf8),
              let writerText = String(data: writer, encoding: .utf8) else {
            throw PdfWriterError.script("the pinned scripts are not UTF-8")
        }

        func eval(_ script: String) throws {
            box.message = nil
            context.evaluateScript(script)
            if let message = box.message { throw PdfWriterError.script(message) }
        }
        func assertNoNetworkGlobals() throws {
            let joined = context.evaluateScript("[typeof fetch, typeof XMLHttpRequest, typeof WebSocket].join()")?.toString()
            guard joined == "undefined,undefined,undefined" else {
                throw PdfWriterError.networkGlobal(joined ?? "unknown")
            }
        }

        if let prelude { try eval(prelude) }
        try assertNoNetworkGlobals()
        try eval(pdfLibText)
        try eval(writerText)
        try assertNoNetworkGlobals()
    }

    private func describe(_ ref: JSValueRef?) -> String {
        guard let ref, let value = JSValue(jsValueRef: ref, in: context) else { return "unknown" }
        return value.toString() ?? "unknown"
    }

    private static func parsePins(_ pins: String) -> [String: String] {
        var map: [String: String] = [:]
        for line in pins.split(separator: "\n") {
            let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init).filter { !$0.isEmpty }
            guard parts.count >= 2 else { continue }
            map[parts[1]] = parts[0]
        }
        return map
    }

    private static func requirePin(_ map: [String: String], name: String, data: Data) throws {
        guard let want = map[name] else { throw PdfWriterError.pinMismatch(name) }
        let digest = SHA256.hash(data: data)
        let got = digest.map { String(format: "%02x", $0) }.joined()
        guard got == want else { throw PdfWriterError.pinMismatch(name) }
    }

    private static func milliseconds(from start: ContinuousClock.Instant, to end: ContinuousClock.Instant) -> Double {
        let components = start.duration(to: end).components
        return Double(components.seconds) * 1000.0 + Double(components.attoseconds) / 1e15
    }
}
