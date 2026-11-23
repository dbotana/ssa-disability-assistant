import CoreGraphics
import Foundation
import SsaCore

/// The CGPDF implementation of core's `PdfReadPort`, so the core
/// `PdfSelfCheck` can re-read a filled PDF on iOS without a third-party PDF
/// library. CGPDF exposes the AcroForm dictionaries directly; the field walk,
/// value tagging and stream decoding below mirror `PdfBoxPdfReadPort.kt`.
public final class CgPdfReadPort: NSObject, PdfReadPort {

    public override init() {
        super.init()
    }

    public func reader(bytes: KotlinByteArray) -> PdfReader {
        let data = bytes.toData()
        let provider = CGDataProvider(data: data as CFData)
        let doc = provider.flatMap { CGPDFDocument($0) }
        return CgPdfReader(doc: doc)
    }
}

/// A reader over one CGPDF document. If the document failed to open, every
/// accessor answers as an empty PDF and the self-check reports the problems.
public final class CgPdfReader: NSObject, PdfReader {

    private let doc: CGPDFDocument?
    private let acroForm: CGPDFDictionaryRef?
    private var fields: [String: PdfFieldView] = [:]

    /// What CGPDF could not expose (for example a JPEG-encoded appearance
    /// stream). Each entry names the field (or "document"), the method and the
    /// data format. The spike test publishes this list.
    public private(set) var limitations: [String] = []

    init(doc: CGPDFDocument?) {
        self.doc = doc
        if let doc {
            let catalog = doc.catalog
            var acro: CGPDFDictionaryRef?
            if let catalog, CGPDFDictionaryGetDictionary(catalog, "AcroForm", &acro) {
                self.acroForm = acro
            } else {
                self.acroForm = nil
            }
        } else {
            self.acroForm = nil
        }
        super.init()
        if let acroForm {
            self.fields = buildFields(acroForm)
        }
    }

    public func close() {}

    public func hasAcroForm() -> Bool {
        acroForm != nil
    }

    public func pageCount() -> Int32 {
        guard let doc else { return 0 }
        return Int32(doc.numberOfPages)
    }

    public func pageSize(index: Int32) -> KotlinPair<KotlinDouble, KotlinDouble> {
        guard let doc, let page = doc.page(at: Int(index) + 1) else {
            return KotlinPair(first: KotlinDouble(double: 0), second: KotlinDouble(double: 0))
        }
        let rect = page.getBoxRect(.mediaBox)
        return KotlinPair(first: KotlinDouble(double: Double(rect.width)), second: KotlinDouble(double: Double(rect.height)))
    }

    public func needAppearances() -> Bool {
        guard let acroForm else { return false }
        var value: CGPDFBoolean = 0
        guard CGPDFDictionaryGetBoolean(acroForm, "NeedAppearances", &value) else { return false }
        return value != 0
    }

    public func hasXfa() -> Bool {
        guard let acroForm else { return false }
        var obj: CGPDFObjectRef?
        return CGPDFDictionaryGetObject(acroForm, "XFA", &obj)
    }

    public func sigFlags() -> KotlinInt? {
        guard let acroForm else { return nil }
        var value: CGPDFInteger = 0
        guard CGPDFDictionaryGetInteger(acroForm, "SigFlags", &value) else { return nil }
        return KotlinInt(int: Int32(value))
    }

    public func hasWinAnsiHelvWaInDefaultResources() -> Bool {
        guard let acroForm else { return false }
        var dr: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(acroForm, "DR", &dr), let dr else { return false }
        return Self.fontHelvWa(dr)
    }

    public func terminalFieldNames() -> Set<String> {
        Set(fields.keys)
    }

    public func field(name: String) -> PdfFieldView? {
        fields[name]
    }

    public func pageContent(index: Int32) -> KotlinByteArray {
        guard let doc, let page = doc.page(at: Int(index) + 1), let pageDict = page.dictionary else {
            return KotlinByteArray(size: 0)
        }
        var data = Data()
        var stream: CGPDFStreamRef?
        if CGPDFDictionaryGetStream(pageDict, "Contents", &stream), let stream {
            appendStreamData(stream, field: nil, method: "pageContent", to: &data)
        } else {
            var array: CGPDFArrayRef?
            if CGPDFDictionaryGetArray(pageDict, "Contents", &array), let array {
                let count = CGPDFArrayGetCount(array)
                for i in 0 ..< count {
                    var s: CGPDFStreamRef?
                    if CGPDFArrayGetStream(array, i, &s), let s {
                        if !data.isEmpty { data.append(0x0a) }
                        appendStreamData(s, field: nil, method: "pageContent", to: &data)
                    }
                }
            }
        }
        return KotlinByteArray.from(data)
    }

    // -- field walk -----------------------------------------------------------

    private struct Inherited {
        var ft: String?
        var ff: Int64?
    }

    private func buildFields(_ acroForm: CGPDFDictionaryRef) -> [String: PdfFieldView] {
        var array: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(acroForm, "Fields", &array), let array else { return [:] }
        var out: [String: PdfFieldView] = [:]
        let count = CGPDFArrayGetCount(array)
        for i in 0 ..< count {
            var fieldDict: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(array, i, &fieldDict), let fieldDict else { continue }
            walk(fieldDict, nameParts: [], inherited: Inherited(), into: &out)
        }
        return out
    }

    private func walk(_ dict: CGPDFDictionaryRef, nameParts: [String], inherited: Inherited, into out: inout [String: PdfFieldView]) {
        let ownT = Self.pdfString(dict, "T")
        var parts = nameParts
        if let ownT { parts.append(ownT) }

        let ft = Self.pdfName(dict, "FT") ?? inherited.ft
        let ff = Self.pdfInteger(dict, "Ff") ?? inherited.ff

        if Self.isTerminal(dict) {
            if let ownT {
                out[parts.joined(separator: ".")] = makeFieldView(dict, name: parts.joined(separator: "."), ft: ft, ff: ff)
            }
            return
        }

        guard let kids = Self.pdfArray(dict, "Kids") else { return }
        let count = CGPDFArrayGetCount(kids)
        for i in 0 ..< count {
            var kid: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(kids, i, &kid), let kid else { continue }
            walk(kid, nameParts: parts, inherited: Inherited(ft: ft, ff: ff), into: &out)
        }
    }

    private static func isTerminal(_ dict: CGPDFDictionaryRef) -> Bool {
        guard let kids = pdfArray(dict, "Kids") else { return true }
        let count = CGPDFArrayGetCount(kids)
        for i in 0 ..< count {
            var kid: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(kids, i, &kid), let kid else { continue }
            if pdfHasKey(kid, "T") { return false }
        }
        return true
    }

    private func makeFieldView(_ dict: CGPDFDictionaryRef, name: String, ft: String?, ff: Int64?) -> PdfFieldView {
        let type = Self.fieldType(ft: ft, ff: ff)
        let value = fieldValue(dict, type: type)
        let readOnly = (ff ?? 0) & 1 != 0
        let da = Self.pdfString(dict, "DA")
        let widgets = widgetViews(dict, fieldName: name)
        let raw = tagValue(dict)
        return PdfFieldView(type: type, value: value, readOnly: readOnly, da: da, widgets: widgets, rawValue: raw)
    }

    private static func fieldType(ft: String?, ff: Int64?) -> String {
        switch ft {
        case "Tx": return "text"
        case "Btn":
            let bits = ff ?? 0
            if bits & (Int64(1) << 15) != 0 { return "radio" }
            if bits & (Int64(1) << 16) != 0 { return "other" }
            return "checkbox"
        case "Sig": return "signature"
        default: return "other"
        }
    }

    private func fieldValue(_ dict: CGPDFDictionaryRef, type: String) -> String? {
        switch type {
        case "text": return Self.pdfString(dict, "V")
        case "checkbox": return Self.pdfName(dict, "V")
        case "radio": return Self.pdfName(dict, "V") ?? "Off"
        case "signature": return Self.pdfHasKey(dict, "V") ? "signed" : nil
        default: return nil
        }
    }

    private func widgetViews(_ dict: CGPDFDictionaryRef, fieldName: String) -> [PdfWidgetView] {
        guard let kids = Self.pdfArray(dict, "Kids") else {
            return [makeWidgetView(dict, isField: true, fieldName: fieldName)]
        }
        var out: [PdfWidgetView] = []
        let count = CGPDFArrayGetCount(kids)
        for i in 0 ..< count {
            var kid: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(kids, i, &kid), let kid else { continue }
            if Self.pdfHasKey(kid, "T") { continue }
            out.append(makeWidgetView(kid, isField: false, fieldName: fieldName))
        }
        return out
    }

    private func makeWidgetView(_ w: CGPDFDictionaryRef, isField: Bool, fieldName: String) -> PdfWidgetView {
        let da = isField ? nil : Self.pdfString(w, "DA")
        let appearanceState = Self.pdfName(w, "AS")
        let ap = Self.pdfDict(w, "AP")
        let n = ap.flatMap { appearanceN($0) }
        let normalAppearance = n.map { appearanceView($0, fieldName: fieldName) }
        let normalAppearanceBytes = n.map { appearanceBytes($0, fieldName: fieldName) } ?? []
        return PdfWidgetView(da: da, appearanceState: appearanceState, normalAppearance: normalAppearance, normalAppearanceBytes: normalAppearanceBytes)
    }

    private enum AppearanceN {
        case stream(CGPDFStreamRef)
        case dict(CGPDFDictionaryRef)
    }

    private func appearanceN(_ ap: CGPDFDictionaryRef) -> AppearanceN? {
        var stream: CGPDFStreamRef?
        if CGPDFDictionaryGetStream(ap, "N", &stream), let stream { return .stream(stream) }
        var dict: CGPDFDictionaryRef?
        if CGPDFDictionaryGetDictionary(ap, "N", &dict), let dict { return .dict(dict) }
        return nil
    }

    private func appearanceView(_ n: AppearanceN, fieldName: String) -> PdfAppearanceView {
        switch n {
        case .stream(let stream):
            let data = streamData(stream, field: fieldName, method: "appearance")
            let drawn = ContentStreamTokenizer.shared.drawn(bytes: KotlinByteArray.from(data))
            let bbox = bboxValue(stream)
            let hasHelvWa = streamResources(stream).map { Self.fontHelvWa($0) } ?? false
            return PdfAppearanceView(isStream: true, bbox: bbox, hasWinAnsiHelvWa: hasHelvWa, drawn: drawn, onStates: [])
        case .dict(let dict):
            let onStates = Self.dictKeys(dict).filter { $0 != "Off" }
            return PdfAppearanceView(isStream: false, bbox: nil, hasWinAnsiHelvWa: false,
                                     drawn: DrawnContent(strings: [], fonts: []), onStates: onStates)
        }
    }

    private func appearanceBytes(_ n: AppearanceN, fieldName: String) -> [KotlinPair<NSString, NSArray>] {
        switch n {
        case .stream(let stream):
            let bytes = streamData(stream, field: fieldName, method: "appearanceBytes").map { KotlinByte(char: Int8(bitPattern: $0)) }
            return [KotlinPair(first: "" as NSString, second: NSArray(array: bytes))]
        case .dict(let dict):
            let collector = Collector<KotlinPair<NSString, NSArray>>()
            CGPDFDictionaryApplyBlock(dict, { key, obj, _ in
                if CGPDFObjectGetType(obj) == .stream {
                    var stream: CGPDFStreamRef?
                    if CGPDFObjectGetValue(obj, .stream, &stream), let stream {
                        let name = String(cString: key)
                        let bytes = self.streamData(stream, field: fieldName, method: "appearanceBytes").map { KotlinByte(char: Int8(bitPattern: $0)) }
                        collector.items.append(KotlinPair(first: name as NSString, second: NSArray(array: bytes)))
                    }
                }
                return true
            }, nil)
            return collector.items.sorted { ($0.first as String? ?? "") < ($1.first as String? ?? "") }
        }
    }

    // -- stream and value helpers --------------------------------------------

    private func appendStreamData(_ stream: CGPDFStreamRef, field: String?, method: String, to data: inout Data) {
        data.append(streamData(stream, field: field, method: method))
    }

    private func streamData(_ stream: CGPDFStreamRef, field: String?, method: String) -> Data {
        var format: CGPDFDataFormat = .raw
        let data = (CGPDFStreamCopyData(stream, &format) as Data?) ?? Data()
        if format != .raw {
            limitations.append("field=\(field ?? "document") method=\(method) format=\(format.rawValue)")
        }
        return data
    }

    private func bboxValue(_ stream: CGPDFStreamRef) -> KotlinPair<KotlinDouble, KotlinDouble>? {
        guard let dict = streamDictionary(stream),
              let arr = Self.pdfArray(dict, "BBox"), CGPDFArrayGetCount(arr) == 4 else { return nil }
        var a: CGPDFReal = 0
        var b: CGPDFReal = 0
        var c: CGPDFReal = 0
        var d: CGPDFReal = 0
        guard CGPDFArrayGetNumber(arr, 0, &a), CGPDFArrayGetNumber(arr, 1, &b),
              CGPDFArrayGetNumber(arr, 2, &c), CGPDFArrayGetNumber(arr, 3, &d) else { return nil }
        let width = abs(c - a)
        let height = abs(d - b)
        return KotlinPair(first: KotlinDouble(double: Double(width)), second: KotlinDouble(double: Double(height)))
    }

    private func streamDictionary(_ stream: CGPDFStreamRef) -> CGPDFDictionaryRef? {
        CGPDFStreamGetDictionary(stream)
    }

    private func streamResources(_ stream: CGPDFStreamRef) -> CGPDFDictionaryRef? {
        guard let dict = streamDictionary(stream) else { return nil }
        return Self.pdfDict(dict, "Resources")
    }

    private static func fontHelvWa(_ resources: CGPDFDictionaryRef) -> Bool {
        guard let font = pdfDict(resources, "Font") else { return false }
        guard let helvWa = pdfDict(font, "HelvWA") else { return false }
        var baseFont: UnsafePointer<CChar>?
        guard CGPDFDictionaryGetName(helvWa, "BaseFont", &baseFont), let baseFont, String(cString: baseFont) == "Helvetica" else { return false }
        var encoding: UnsafePointer<CChar>?
        guard CGPDFDictionaryGetName(helvWa, "Encoding", &encoding), let encoding, String(cString: encoding) == "WinAnsiEncoding" else { return false }
        return true
    }

    private func tagValue(_ dict: CGPDFDictionaryRef) -> String? {
        var obj: CGPDFObjectRef?
        guard CGPDFDictionaryGetObject(dict, "V", &obj), let obj else { return nil }
        return Self.tagObject(obj)
    }

    private static func tagObject(_ obj: CGPDFObjectRef) -> String {
        switch CGPDFObjectGetType(obj) {
        case .string:
            var s: CGPDFStringRef?
            if CGPDFObjectGetValue(obj, .string, &s), let s {
                return "s:" + (CGPDFStringCopyTextString(s) as String? ?? "")
            }
            return "d"
        case .name:
            var n: UnsafePointer<CChar>?
            if CGPDFObjectGetValue(obj, .name, &n), let n {
                return "n:" + String(cString: n)
            }
            return "d"
        case .integer:
            var i: CGPDFInteger = 0
            _ = CGPDFObjectGetValue(obj, .integer, &i)
            return "i:" + String(i)
        case .real:
            var r: CGPDFReal = 0
            _ = CGPDFObjectGetValue(obj, .real, &r)
            return "r:" + String(Double(r))
        case .boolean:
            var b: CGPDFBoolean = 0
            _ = CGPDFObjectGetValue(obj, .boolean, &b)
            return b != 0 ? "b:true" : "b:false"
        case .array:
            var arr: CGPDFArrayRef?
            guard CGPDFObjectGetValue(obj, .array, &arr), let arr else { return "d" }
            let count = CGPDFArrayGetCount(arr)
            var parts: [String] = []
            for i in 0 ..< count {
                var elem: CGPDFObjectRef?
                guard CGPDFArrayGetObject(arr, i, &elem), let elem else { continue }
                parts.append(tagObject(elem))
            }
            return "a:[" + parts.joined(separator: ",") + "]"
        case .dictionary, .stream, .null:
            return "d"
        @unknown default:
            return "d"
        }
    }

    // -- primitive CGPDF accessors -------------------------------------------

    private static func pdfString(_ dict: CGPDFDictionaryRef, _ key: String) -> String? {
        var ref: CGPDFStringRef?
        return key.withCString { ckey in
            guard CGPDFDictionaryGetString(dict, ckey, &ref), let ref else { return nil }
            return CGPDFStringCopyTextString(ref) as String?
        }
    }

    private static func pdfName(_ dict: CGPDFDictionaryRef, _ key: String) -> String? {
        var ref: UnsafePointer<CChar>?
        return key.withCString { ckey in
            guard CGPDFDictionaryGetName(dict, ckey, &ref), let ref else { return nil }
            return String(cString: ref)
        }
    }

    private static func pdfInteger(_ dict: CGPDFDictionaryRef, _ key: String) -> Int64? {
        var value: CGPDFInteger = 0
        return key.withCString { ckey in
            guard CGPDFDictionaryGetInteger(dict, ckey, &value) else { return nil }
            return Int64(value)
        }
    }

    private static func pdfDict(_ dict: CGPDFDictionaryRef, _ key: String) -> CGPDFDictionaryRef? {
        var value: CGPDFDictionaryRef?
        return key.withCString { ckey in
            guard CGPDFDictionaryGetDictionary(dict, ckey, &value) else { return nil }
            return value
        }
    }

    private static func pdfArray(_ dict: CGPDFDictionaryRef, _ key: String) -> CGPDFArrayRef? {
        var value: CGPDFArrayRef?
        return key.withCString { ckey in
            guard CGPDFDictionaryGetArray(dict, ckey, &value) else { return nil }
            return value
        }
    }

    private static func pdfHasKey(_ dict: CGPDFDictionaryRef, _ key: String) -> Bool {
        var obj: CGPDFObjectRef?
        return key.withCString { ckey in
            CGPDFDictionaryGetObject(dict, ckey, &obj)
        }
    }

    private static func dictKeys(_ dict: CGPDFDictionaryRef) -> [String] {
        let collector = Collector<String>()
        CGPDFDictionaryApplyBlock(dict, { key, _, _ in
            collector.items.append(String(cString: key))
            return true
        }, nil)
        return collector.items
    }
}

private final class Collector<T> {
    var items: [T] = []
}
