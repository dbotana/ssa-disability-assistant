import Foundation
import RepoFixtures
import SsaCore
import XCTest
@testable import SsaPdf

/// Spike 3a: fill both forms in both versions of a Lingala session with the
/// JS writer running in JavaScriptCore, then re-read each PDF with a CGPDF
/// `PdfReadPort` through the core `PdfSelfCheck`, and publish the PDFs for
/// `tools/golden/crosscheck.mjs`.
final class PdfSpikeTests: XCTestCase {

    private var sourceRoot: URL {
        URL(fileURLWithPath: #filePath)          // ios/CoreCrypto/Tests/SsaPdfTests/PdfSpikeTests.swift
            .deletingLastPathComponent()          // SsaPdfTests
            .deletingLastPathComponent()          // Tests
            .deletingLastPathComponent()          // CoreCrypto
            .deletingLastPathComponent()          // ios
            .deletingLastPathComponent()          // repository root
    }

    /// The source tree on the simulator, the staged copy on a phone (RepoFixtures).
    private var repoRoot: URL { RepoFixtures.root(sourceRoot: sourceRoot) }

    /// The checks the JS writer is known to fail because pdf-lib does not
    /// follow the Android AcroFormWriter /HelvWA convention. A problem with a
    /// check outside this set is a real defect or a CGPDF limitation and must
    /// fail the run.
    private let knownConventionChecks: Set<String> = [
        "/DR has no WinAnsi /HelvWA",
        "DA is not /HelvWA at the planned size",
        "widget DA is not /HelvWA at the planned size",
        "appearance has no WinAnsi /HelvWA",
        "appearance font is not /HelvWA at the planned size",
        "appearance changed though the plan left it alone",
    ]

    override func setUp() {
        super.setUp()
        // An XCTest bundle has no app main bundle, so point the Kotlin
        // readResource at the repository directories (IosResources.roots).
        IosResources.shared.roots = [
            repoRoot.appendingPathComponent("android/core/src/commonMain/resources").path,
            repoRoot.appendingPathComponent("tools").path,
        ]
    }

    func testLingalaSessionFourPdfs() throws {
        let schemaText = try String(
            contentsOf: repoRoot.appendingPathComponent("tools/schema.json"),
            encoding: .utf8
        )
        let schema = SchemaLoader.shared.load(json: JsonParser.shared.parse(text: schemaText))

        let fillplans = try readJSON("android/core/src/commonTest/resources/golden/fillplans.json")
        let versions = try XCTUnwrap(fillplans["versions"] as? [[String: Any]])

        let templates: [String: Data] = [
            "ssa": try Data(contentsOf: repoRoot.appendingPathComponent("forms/ssa-adult-disability-starter-kit-64-110.pdf")),
            "ds": try Data(contentsOf: repoRoot.appendingPathComponent("forms/maine-developmental-services-intake-2025-06-18.pdf")),
        ]

        // The writer: a cold JSContext, its scripts hash-checked against the pins.
        let pdfLib = try Data(contentsOf: repoRoot.appendingPathComponent("vendor/pdf-lib.min.js"))
        let writerScript = try Data(contentsOf: repoRoot.appendingPathComponent("vendor/ssa-pdf-writer.js"))
        let pins = try String(contentsOf: repoRoot.appendingPathComponent("vendor/SHA256SUMS"), encoding: .utf8)
        let writer = try PdfWriter(pdfLib: pdfLib, writer: writerScript, pins: pins)
        let contextLoadMs = writer.loadMs

        struct Case {
            let name: String
            let form: String
            let record: [String: Any]   // the golden a/b record
            let version: FormVersions.Version
        }

        var cases: [Case] = []
        for entry in versions {
            guard entry["fixture"] as? String == "ln-both" else { continue }
            let form = try XCTUnwrap(entry["form"] as? String)
            let answersJson = try XCTUnwrap(JsonParser.shared.parse(text: try jsonText(entry["answers"]!)) as? JsonObj)
            let overlayJson = JsonParser.shared.parse(text: try jsonText(entry["overlay"]!))
            let overlay = FormVersions.OverlayCompanion.shared.fromJson(j: overlayJson)
            let i18n = I18n(schema: schema)
            let today = CivilDate(year: 2026, month: 9, day: 19)
            let vs = FormVersions.shared.plan(
                schema: schema, formId: form, answers: answersJson, overlay: overlay,
                today: today, lang: "en", i18n: i18n
            )

            // The Kotlin plan's addendum and the golden draw list must agree on
            // the number of pages before the JS writer draws the golden pages.
            let aRecord = try XCTUnwrap(entry["a"] as? [String: Any])
            XCTAssertEqual(vs.a.document.addendum.count, (aRecord["pages"] as? [Any])?.count ?? -1,
                           "\(form): the Kotlin plan's A addendum pages disagree with the golden draw list")
            cases.append(Case(name: "ln-both-a", form: form, record: aRecord, version: vs.a))
            if let bRecord = entry["b"] as? [String: Any], let bVersion = vs.b {
                XCTAssertEqual(bVersion.document.addendum.count, (bRecord["pages"] as? [Any])?.count ?? -1,
                               "\(form): the Kotlin plan's B addendum pages disagree with the golden draw list")
                cases.append(Case(name: "ln-both-b", form: form, record: bRecord, version: bVersion))
            }
        }
        XCTAssertEqual(cases.count, 4, "expected the four ln-both PDFs")

        // The template fields whose widgets had no /AP /N: pdf-lib's
        // updateFieldAppearances generates one for them, which is the only
        // legitimate source of the "appearance changed" convention problem.
        let templateFieldsWithoutAppearance: [String: Set<String>] = try Dictionary(uniqueKeysWithValues:
            templates.map { form, data in
                (form, self.templateFieldsWithoutAppearance(data))
            })

        // ios/CoreCrypto/.build/pdf-spike on the simulator; the test's temporary
        // directory on a phone, where summary.json also comes back as an attachment.
        let outputDir = RepoFixtures.outputDirectory(sourceRoot: sourceRoot, name: "pdf-spike")
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let clock = ContinuousClock()
        var totals: [(name: String, total: Double, js: Double, check: Double, bytes: Int, ratio: Double, ok: Bool, problems: Int)] = []

        for c in cases {
            let planJSON = try jsonText(c.record["plan"]!)
            let pages = c.record["pages"] as? [Any] ?? []
            let drawListJSON: String? = pages.isEmpty ? nil : try jsonText(["pages": pages])
            let title = c.version.document.spec.title
            let creator = FormDocuments.shared.CREATOR
            let addendumPages = pages.count

            let templateURL = repoRoot.appendingPathComponent(
                c.form == "ssa"
                    ? "forms/ssa-adult-disability-starter-kit-64-110.pdf"
                    : "forms/maine-developmental-services-intake-2025-06-18.pdf"
            )

            var start = clock.now
            let templateBytes = try Data(contentsOf: templateURL)
            let readMs = Self.milliseconds(start, clock.now)

            start = clock.now
            let (bytes, missing, writeMs) = try writer.write(
                template: templateBytes, planJSON: planJSON, drawListJSON: drawListJSON,
                title: title, creator: creator
            )
            let jsMs = Self.milliseconds(start, clock.now)
            XCTAssertEqual(missing, [], "the writer reported missing fields")

            start = clock.now
            let outputBytes = KotlinByteArray.from(bytes)
            let templateKb = KotlinByteArray.from(templateBytes)
            let transferMs = Self.milliseconds(start, clock.now)

            start = clock.now
            let result = PdfSelfCheck.shared.check(
                bytes: outputBytes, template: templateKb, fd: c.version.document, port: CgPdfReadPort()
            )
            let checkMs = Self.milliseconds(start, clock.now)
            let totalMs = readMs + jsMs + transferMs + checkMs

            // Publish the PDF and its record for crosscheck.mjs.
            let base = outputDir.appendingPathComponent("\(c.name)-\(c.form)")
            try bytes.write(to: base.appendingPathExtension("pdf"))

            let outputReader = CgPdfReadPort().reader(bytes: KotlinByteArray.from(bytes)) as! CgPdfReader
            let limitations = Array(Set(outputReader.limitations)).sorted()

            var record: [String: Any] = [
                "case": c.name,
                "form": c.form,
                "today": "2026-09-19",
                "answers": c.record["answers"]!,
                "plan": c.record["plan"]!,
                "addendumPages": addendumPages,
                "templateBytes": templateBytes.count,
                "bytes": bytes.count,
                "timings": [
                    "contextLoadMs": contextLoadMs,
                    "readMs": readMs,
                    "jsMs": jsMs,
                    "writeMs": writeMs,
                    "transferMs": transferMs,
                    "checkMs": checkMs,
                    "totalMs": totalMs,
                ],
                "device": RepoFixtures.deviceLabel,
                "selfCheck": [
                    "ok": result.ok,
                    "problems": result.problems.map { ["field": $0.field as Any, "check": $0.check] },
                ],
                "limitations": limitations,
            ]
            let recordData = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
            try recordData.write(to: base.appendingPathExtension("json"))

            let ratio = Double(bytes.count) / Double(templateBytes.count)
            let ok = result.ok
            totals.append((name: "\(c.name)-\(c.form)", total: totalMs, js: jsMs, check: checkMs,
                           bytes: bytes.count, ratio: ratio, ok: ok, problems: result.problems.count))
            print("spike3a \(c.name)-\(c.form) total=\(String(format: "%.0f", totalMs)) js=\(String(format: "%.0f", jsMs)) check=\(String(format: "%.0f", checkMs)) bytes=\(bytes.count) ratio=\(String(format: "%.2f", ratio)) selfcheck=\(ok ? "ok" : "\(result.problems.count) problems")")

            assertSelfCheck(result, template: templateBytes, form: c.form,
                            templateFieldsWithoutAppearance: templateFieldsWithoutAppearance[c.form] ?? [])
        }

        // Warm pass: the same four writes in the same context, write time only.
        var warmWriteMs: [String: Double] = [:]
        for c in cases {
            let planJSON = try jsonText(c.record["plan"]!)
            let pages = c.record["pages"] as? [Any] ?? []
            let drawListJSON: String? = pages.isEmpty ? nil : try jsonText(["pages": pages])
            let title = c.version.document.spec.title
            let creator = FormDocuments.shared.CREATOR
            let templateBytes = try Data(contentsOf: repoRoot.appendingPathComponent(
                c.form == "ssa"
                    ? "forms/ssa-adult-disability-starter-kit-64-110.pdf"
                    : "forms/maine-developmental-services-intake-2025-06-18.pdf"
            ))
            let start = clock.now
            _ = try writer.write(template: templateBytes, planJSON: planJSON, drawListJSON: drawListJSON,
                                 title: title, creator: creator)
            warmWriteMs["\(c.name)-\(c.form)"] = Self.milliseconds(start, clock.now)
        }

        let sessionTotal = totals.reduce(0.0) { $0 + $1.total }
        var summary: [String: Any] = [
            "loadMs": contextLoadMs,
            "totals": totals.map { t in
                ["case": t.name, "totalMs": t.total, "jsMs": t.js, "checkMs": t.check,
                 "bytes": t.bytes, "ratio": t.ratio, "ok": t.ok, "problems": t.problems]
            },
            "sessionTotalMs": sessionTotal,
            "warmWriteMs": warmWriteMs,
            "device": RepoFixtures.deviceLabel,
        ]
        let summaryData = try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
        try summaryData.write(to: outputDir.appendingPathComponent("summary.json"))
        print("spike3a summary \(RepoFixtures.deviceLabel) load=\(String(format: "%.0f", contextLoadMs)) session=\(String(format: "%.0f", sessionTotal)) fixtures=\(RepoFixtures.usesBundle(sourceRoot: sourceRoot) ? "bundle" : "source tree") out=\(outputDir.path)")

        // The timings in the .xcresult, so a phone run's numbers reach the Mac.
        let attachment = XCTAttachment(data: summaryData, uniformTypeIdentifier: "public.json")
        attachment.name = "spike3a-summary.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testNetworkGlobalsAreRefused() {
        let prelude = "globalThis.fetch = function(){};"
        let pdfLib = Data()
        let writer = Data()
        XCTAssertThrowsError(try PdfWriter(pdfLib: pdfLib, writer: writer, prelude: prelude)) { error in
            guard case PdfWriterError.networkGlobal = error else {
                return XCTFail("expected .networkGlobal, got \(error)")
            }
        }
    }

    func testTamperedScriptIsRefused() throws {
        let pdfLib = try Data(contentsOf: repoRoot.appendingPathComponent("vendor/pdf-lib.min.js"))
        var writer = try Data(contentsOf: repoRoot.appendingPathComponent("vendor/ssa-pdf-writer.js"))
        writer[0] ^= 0xff
        let pins = try String(contentsOf: repoRoot.appendingPathComponent("vendor/SHA256SUMS"), encoding: .utf8)
        XCTAssertThrowsError(try PdfWriter(pdfLib: pdfLib, writer: writer, pins: pins)) { error in
            guard case PdfWriterError.pinMismatch(let name) = error else {
                return XCTFail("expected .pinMismatch, got \(error)")
            }
            XCTAssertEqual(name, "ssa-pdf-writer.js")
        }
    }

    // -- helpers --------------------------------------------------------------

    private func assertSelfCheck(
        _ result: PdfSelfCheck.Result,
        template: Data,
        form: String,
        templateFieldsWithoutAppearance: Set<String>
    ) {
        var counts: [String: Int] = [:]
        for problem in result.problems {
            counts[problem.check, default: 0] += 1
        }
        for (check, count) in counts.sorted(by: { $0.key < $1.key }) {
            print("spike3a selfcheck \(form): \(count)x \(check)")
        }

        let nonStrict = XCTExpectedFailure.Options()
        nonStrict.isStrict = false
        XCTExpectFailure(
            "spike 3a: pdf-lib output does not follow the AcroFormWriter /HelvWA convention; see ios/SPIKES.md",
            options: nonStrict
        ) {
            XCTAssertTrue(result.ok, result.description())
        }

        for problem in result.problems {
            XCTAssertTrue(
                knownConventionChecks.contains(problem.check),
                "unexpected self-check problem: \(problem.field ?? "document"): \(problem.check)"
            )
            if problem.check == "appearance changed though the plan left it alone" {
                let field = problem.field ?? ""
                XCTAssertTrue(
                    templateFieldsWithoutAppearance.contains(field),
                    "appearance changed on a field that had a template appearance: \(field)"
                )
            }
        }
    }

    private func templateFieldsWithoutAppearance(_ template: Data) -> Set<String> {
        let reader = CgPdfReadPort().reader(bytes: KotlinByteArray.from(template))
        var out = Set<String>()
        for name in reader.terminalFieldNames() {
            guard let field = reader.field(name: name) else { continue }
            if field.widgets.allSatisfy({ $0.normalAppearanceBytes.isEmpty }) {
                out.insert(name)
            }
        }
        return out
    }

    private func readJSON(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: repoRoot.appendingPathComponent(path))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func jsonText(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        return String(decoding: data, as: UTF8.self)
    }

    private static func milliseconds(_ start: ContinuousClock.Instant, _ end: ContinuousClock.Instant) -> Double {
        let components = start.duration(to: end).components
        return Double(components.seconds) * 1000.0 + Double(components.attoseconds) / 1e15
    }
}
