import CryptoKit
import CoreCrypto
import Foundation
import SsaCore
import SsaPdf
import UIKit

/// Everything the shared Kotlin UI asks the phone to do, and nothing else.
///
/// Each member is an adapter from plan Phase C3: the real `CoreCrypto`, the
/// JS PDF writer and the CGPDF reader from the Swift package, speech, audio
/// capture, the session file, the share sheet and VoiceOver announcements.
final class AppServices: NSObject, IosServices {

    let crypto: Crypto
    let pdfFill: PdfFillService
    let pdfRead: PdfReadPort
    let speech: IosSpeech
    let audio: IosAudioCapture
    let files: FileStore

    private let resources: Resources
    private let share: ShareAdapter
    private let speechAdapter: SpeechAdapter

    init() throws {
        let resources = try Resources()
        self.resources = resources
        let share = ShareAdapter(resources: resources)
        self.share = share
        let speechAdapter = SpeechAdapter()
        self.speechAdapter = speechAdapter
        crypto = CoreCrypto()
        pdfFill = PdfFillAdapter(resources: resources)
        pdfRead = CgPdfReadPort()
        speech = speechAdapter
        audio = CaptureAdapter()
        files = try FilesAdapter()
    }

    func announce(text: String) {
        // Tell the speech adapter an announcement is in flight, so a finished
        // utterance waits for it instead of talking over it (plan, C3). The
        // adapter clears the flag on `announcementDidFinishNotification`.
        speechAdapter.beginAnnouncement()
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    func share(bytes: KotlinByteArray, fileName: String) {
        share.present(bytes: bytes.toData(), fileName: fileName)
    }

    func resourcePath(name: String) -> String? {
        resources.path(name)
    }
}

// -- pinned resources -------------------------------------------------------------

enum ResourceError: Error, CustomStringConvertible {
    case missing(String)
    case pinMismatch(String)

    var description: String {
        switch self {
        case .missing(let name): return "bundled resource is missing: \(name)"
        case .pinMismatch(let name): return "bundled resource does not match its pin: \(name)"
        }
    }
}

/// The app's resource folder, and the pins every file in it is checked
/// against before first use (plan, Phase C4). A file is never trusted because
/// it is in the bundle: the repository's own SHA256SUMS files travel with it.
final class Resources {
    let root: URL
    private var verified: Set<String> = []

    init() throws {
        guard let base = Bundle.main.resourceURL?.appendingPathComponent("SsaResources") else {
            throw ResourceError.missing("SsaResources")
        }
        guard FileManager.default.fileExists(atPath: base.appendingPathComponent("schema.json").path) else {
            throw ResourceError.missing("SsaResources/schema.json")
        }
        root = base
    }

    /// The absolute path of `name` (a path under SsaResources), after its pin
    /// group has been checked.
    func path(_ name: String) -> String? {
        let group = Self.group(for: name)
        do {
            try verify(group)
        } catch {
            return nil
        }
        let url = root.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url.path
    }

    /// The bytes of `name`, after its pin group has been checked.
    func data(_ name: String) -> Data? {
        guard let path = path(name) else { return nil }
        return try? Data(contentsOf: URL(fileURLWithPath: path))
    }

    func pathWithoutPins(_ name: String) -> String? {
        let url = root.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? url.path : nil
    }

    private static func group(for name: String) -> String {
        for prefix in ["vendor/", "forms/", "models/"] where name.hasPrefix(prefix) {
            return prefix
        }
        return ""
    }

    private func verify(_ group: String) throws {
        if verified.contains(group) { return }
        let pinsName: String
        let prefix: String
        switch group {
        case "vendor/": pinsName = "vendor/SHA256SUMS"; prefix = "vendor/"
        case "forms/": pinsName = "forms/SHA256SUMS"; prefix = "forms/"
        case "models/": pinsName = "models/whisper-base.en/SHA256SUMS"; prefix = "models/whisper-base.en/"
        default: pinsName = "SsaResources.SHA256SUMS"; prefix = ""
        }
        guard let pinsPath = pathWithoutPins(pinsName),
              let pinsText = try? String(contentsOfFile: pinsPath, encoding: .utf8) else {
            throw ResourceError.missing(pinsName)
        }
        for line in pinsText.split(separator: "\n") {
            let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            guard parts.count >= 2 else { continue }
            let want = parts[0].lowercased()
            let name = prefix + parts[1]
            guard let path = pathWithoutPins(name) else { throw ResourceError.missing(name) }
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
                throw ResourceError.missing(name)
            }
            let got = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard got == want else { throw ResourceError.pinMismatch(name) }
        }
        verified.insert(group)
    }
}

// -- the session file -------------------------------------------------------------

/// `FileStore` in Application Support, excluded from backup and written with
/// complete file protection: the encrypted session never sits in an iCloud
/// backup, and is unreadable while the phone is locked.
final class FilesAdapter: NSObject, FileStore {
    private let directory: URL

    init() throws {
        let manager = FileManager.default
        var url = try manager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        url.setResourceValues(values)
        directory = url
    }

    func read(name: String) -> String? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(name: String, text: String) {
        let url = directory.appendingPathComponent(name)
        try? Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtection])
    }

    func delete(name: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
}

// -- the share sheet --------------------------------------------------------------

/// Writes a finished PDF to a temporary file with complete protection, shows
/// the share sheet (or the document picker for Save), and deletes the file
/// when the sheet closes (plan, Phase C3 `share`).
final class ShareAdapter: NSObject, UIDocumentPickerDelegate {
    private let resources: Resources
    private var temporaryFile: URL?

    init(resources: Resources) {
        self.resources = resources
        super.init()
    }

    func present(bytes: Data, fileName: String) {
        guard let presenter = Self.topViewController() else { return }
        let directory = FileManager.default.temporaryDirectory
        let url = directory.appendingPathComponent(fileName)
        do {
            try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            return
        }
        temporaryFile = url
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { [weak self] _, _, _, _ in
            self?.cleanUp()
        }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        }
        presenter.present(sheet, animated: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        cleanUp()
    }

    private func cleanUp() {
        if let url = temporaryFile {
            try? FileManager.default.removeItem(at: url)
        }
        temporaryFile = nil
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var controller = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let presented = controller?.presentedViewController {
            controller = presented
        }
        return controller
    }
}
