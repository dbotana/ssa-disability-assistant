import SsaCore
import SsaPdf
import XCTest
@testable import SsaAssistant

/// The runtime half of the network audit (plan, Phase C5): a `URLProtocol`
/// registered for the whole test sees no request while the app does its work.
/// A deliberate request at the end proves the trap can see traffic at all, so
/// a silent zero is not a broken trap.
final class NetworkTrapTests: XCTestCase {

    private final class Trap: URLProtocol {
        static var seen: [URLRequest] = []

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            Trap.seen.append(request)
            let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
            client?.urlProtocol(self, didFailWithError: error)
        }

        override func stopLoading() {}
    }

    private let templates = [
        "ssa": "forms/ssa-adult-disability-starter-kit-64-110.pdf",
    ]

    override func setUp() {
        super.setUp()
        Trap.seen = []
        URLProtocol.registerClass(Trap.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(Trap.self)
        super.tearDown()
    }

    func testNoRequestDuringTheAppWorkers() async throws {
        // A real export: JavaScriptCore, CGPDF and CoreCrypto, none of which
        // may touch the network.
        let resources = try Resources()
        let path = try XCTUnwrap(resources.pathWithoutPins("schema.json"))
        let text = try String(contentsOfFile: path, encoding: .utf8)
        let schema = SchemaLoader.shared.load(json: JsonParser.shared.parse(text: text))

        let templateFor: (String) -> KotlinByteArray = { formId in
            let name = self.templates[formId]!
            let templatePath = resources.path(name)!
            return KotlinByteArray.from(try! Data(contentsOf: URL(fileURLWithPath: templatePath)))
        }
        let job = ExportJob(
            schema: schema,
            today: CivilDate(year: 2026, month: 11, day: 28),
            i18n: I18n(schema: schema),
            templateFor: templateFor,
            fill: PdfFillAdapter(resources: resources),
            read: CgPdfReadPort()
        )
        _ = try await job.export(
            forms: ["ssa"],
            answers: try XCTUnwrap(JsonKt.asObject(
                JsonParser.shared.parse(text: #"{"forms":"ssa","first_name":"Ada"}"#)
            )),
            overlay: FormVersions.Overlay(inputLangs: [], translations: []),
            lang: "en"
        )

        XCTAssertTrue(Trap.seen.isEmpty, "the app made \(Trap.seen.count) request(s): \(Trap.seen)")

        // The trap must be able to see traffic, or the assertion above proves
        // nothing.
        let expectation = expectation(description: "trap")
        let task = URLSession.shared.dataTask(with: URL(string: "https://example.invalid/")!) { _, _, _ in
            expectation.fulfill()
        }
        task.resume()
        await fulfillment(of: [expectation], timeout: 5)
        XCTAssertEqual(Trap.seen.count, 1)
    }
}
