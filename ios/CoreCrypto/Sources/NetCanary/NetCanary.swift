import Foundation

/// Spike 3c canary. It uses the network on purpose so that
/// ios/tools/audit-binary.sh must fail on its build product, naming
/// NSURLSession. No other target depends on it, and the app must never link it.
public enum NetCanary {
    public static func ping() {
        let url = URL(string: "https://example.invalid/canary")!
        URLSession.shared.dataTask(with: url) { _, _, _ in }.resume()
    }
}