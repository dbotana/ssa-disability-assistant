import Foundation
import SsaCore
import SsaPdf

/// `PdfFillService` over the Swift package's `PdfWriter`: the pinned pdf-lib
/// and the generated writer bundle, run in a JavaScriptCore `JSContext` on a
/// background queue (plan, Phase C3 `pdfFill`).
///
/// `PdfWriter` checks both scripts against `vendor/SHA256SUMS` before it
/// evaluates them, and refuses a context that exposes a network global, so a
/// fill can never reach the network.
final class PdfFillAdapter: NSObject, PdfFillService {
    private let resources: Resources
    private let queue = DispatchQueue(label: "org.ssa.assistant.pdf-writer", qos: .userInitiated)
    private var writer: PdfWriter?

    init(resources: Resources) {
        self.resources = resources
        super.init()
    }

    func fill(
        template: KotlinByteArray,
        planJson: String,
        drawListJson: String?,
        title: String,
        creator: String,
        done: @escaping (KotlinByteArray?, String?) -> Void
    ) {
        let templateData = template.toData()
        queue.async {
            do {
                let writer = try self.loadWriter()
                let result = try writer.write(
                    template: templateData,
                    planJSON: planJson,
                    drawListJSON: drawListJson,
                    title: title,
                    creator: creator
                )
                let bytes = KotlinByteArray.from(result.bytes)
                DispatchQueue.main.async { done(bytes, nil) }
            } catch {
                DispatchQueue.main.async { done(nil, "\(error)") }
            }
        }
    }

    private func loadWriter() throws -> PdfWriter {
        if let writer { return writer }
        guard let pdfLib = resources.data("vendor/pdf-lib.min.js"),
              let writerScript = resources.data("vendor/ssa-pdf-writer.js"),
              let pinsPath = resources.pathWithoutPins("vendor/SHA256SUMS"),
              let pins = try? String(contentsOfFile: pinsPath, encoding: .utf8) else {
            throw ResourceError.missing("vendor scripts")
        }
        let built = try PdfWriter(pdfLib: pdfLib, writer: writerScript, pins: pins)
        writer = built
        return built
    }
}

// `KotlinByteArray.from(_:)` and `.toData()` come from SsaPdf (`KotlinBytes.swift`):
// one copy, so the two modules cannot disagree.
