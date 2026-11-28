import CoreCrypto
import SsaCore
import SsaPdf
import XCTest
@testable import SsaAssistant

/// Phase C5, unit tests over the real adapters: no fakes for the writer, the
/// reader, the crypto or the session file.
final class ExportAndSessionTests: XCTestCase {

    /// The two templates, by the names `tools/schema.json`'s `formSpecs`
    /// carry (the app looks them up the same way in `AppServices.swift`).
    private let templates = [
        "ssa": "forms/ssa-adult-disability-starter-kit-64-110.pdf",
        "ds": "forms/maine-developmental-services-intake-2025-06-18.pdf",
    ]

    private var resources: Resources!

    override func setUpWithError() throws {
        resources = try Resources()
    }

    private func schema() throws -> Schema {
        let path = try XCTUnwrap(resources.pathWithoutPins("schema.json"))
        let text = try String(contentsOfFile: path, encoding: .utf8)
        return SchemaLoader.shared.load(json: JsonParser.shared.parse(text: text))
    }

    private func answers(_ json: String) throws -> JsonObj {
        try XCTUnwrap(JsonKt.asObject(JsonParser.shared.parse(text: json)))
    }

    private func template(_ formId: String) throws -> KotlinByteArray {
        let name = try XCTUnwrap(templates[formId])
        let path = try XCTUnwrap(resources.path(name))
        return KotlinByteArray.from(try Data(contentsOf: URL(fileURLWithPath: path)))
    }

    /// A short English interview that names both forms and answers enough for
    /// both PDFs.
    private var sampleAnswers: String {
        """
        {"forms":"both","first_name":"Ada","last_name":"Lovelace",
         "date_of_birth":"1979-03-03","ssn":"555123456",
         "street":"1 Analytical Way","city":"Portland","state":"ME","zip":"04101"}
        """
    }

    /// ExportJob on both forms, with the real JavaScriptCore writer and the
    /// real CGPDF reader. The six known pdf-lib convention problems are
    /// allowed; anything else fails the test.
    func testExportJobFillsAndSelfChecksBothForms() async throws {
        let schema = try schema()
        let resources = self.resources!
        let fill = PdfFillAdapter(resources: resources)
        let job = ExportJob(
            schema: schema,
            today: CivilDate(year: 2026, month: 11, day: 28),
            i18n: I18n(schema: schema),
            templateFor: { formId in try! self.template(formId) },
            fill: fill,
            read: CgPdfReadPort()
        )
        let outcome = try await job.export(
            forms: ["ssa", "ds"],
            answers: try answers(sampleAnswers),
            overlay: FormVersions.Overlay(inputLangs: [], translations: []),
            lang: "en"
        )
        XCTAssertTrue(outcome.failed.isEmpty, "export failures: \(outcome.failed.map { "\($0.formId): \($0.check)" })")
        XCTAssertEqual(outcome.ready.count, 2)
        for file in outcome.ready {
            XCTAssertGreaterThan(Int(file.bytes.size), 1000, "\(file.fileName) is suspiciously small")
            XCTAssertTrue(file.fileName.hasSuffix(".pdf"))
            for problem in file.selfCheck.problems {
                XCTAssertTrue(
                    ExportJob.companion.KNOWN_CONVENTION_CHECKS.contains(problem.check),
                    "unexpected self-check problem: \(problem.field ?? "document"): \(problem.check)"
                )
            }
        }
    }

    /// A SessionStore round trip in the app's real FileStore, with CoreCrypto.
    /// A wrong PIN is not asserted here: `unlock` does not declare `@Throws`,
    /// so a Kotlin exception would end the test process. `SessionGateTest`
    /// covers that branch on the Kotlin side.
    func testSessionStoreRoundTripInTheAppFileStore() throws {
        let schema = try schema()
        let files = try FilesAdapter()
        files.delete(name: StoreFormat.shared.STATE_FILE)

        let store = SessionStore(
            schema: schema,
            crypto: CoreCrypto(),
            files: files,
            clock: { KotlinDouble(double: 1_800_000_000.0) }
        )
        store.usePin(pin: "2468")
        XCTAssertTrue(store.saveState(state: try answers(#"{"answers":{"first_name":"Ada"}}"#)))
        XCTAssertNotNil(files.read(name: StoreFormat.shared.STATE_FILE))
        XCTAssertFalse(
            files.read(name: StoreFormat.shared.STATE_FILE)?.contains("Ada") ?? true,
            "answers are inside the ciphertext"
        )

        let again = SessionStore(
            schema: schema,
            crypto: CoreCrypto(),
            files: files,
            clock: { KotlinDouble(double: 1_800_000_000.0) }
        )
        XCTAssertNotNil(again.savedSessionInfo(now: 1_800_000_000.0))
        let opened = again.unlock(pin: "2468")
        let stored = try XCTUnwrap(JsonKt.asObject(try XCTUnwrap(opened.state.get(key: "answers"))))
        XCTAssertEqual(JsonKt.asString(try XCTUnwrap(stored.get(key: "first_name"))), "Ada")
        files.delete(name: StoreFormat.shared.STATE_FILE)
    }
}
