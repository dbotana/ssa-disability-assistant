import SsaCore
import SwiftUI
import UIKit

/// The app's entry point. A SwiftUI App so the scene lifecycle (and the
/// privacy cover) is SwiftUI's, with a UIKit delegate only for the one thing
/// SwiftUI cannot do: refusing third-party keyboards.
@main
struct SsaAssistantApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var shell = Shell()

    var body: some Scene {
        WindowGroup {
            ZStack {
                if let controller = shell.composeController {
                    HostView(controller: controller, shell: shell)
                } else {
                    // A missing or unpinned resource stops the app: say so out
                    // loud rather than showing a black screen VoiceOver cannot
                    // see. (Plain English: the catalogue rule is for the shared
                    // Kotlin UI, which never gets this far.)
                    VStack(spacing: 16) {
                        Text("The app's files failed their check.")
                            .font(.title2)
                            .multilineTextAlignment(.center)
                        Text("Nothing was opened, and nothing was sent anywhere. Reinstall the app, or check that every bundled file matches its pin.")
                            .font(.body)
                            .multilineTextAlignment(.center)
                    }
                    .padding(32)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("The app's files failed their check. Reinstall the app.")
                }
                if shell.covered {
                    // The privacy cover: a system switcher snapshot must not
                    // show an answer. It says nothing, so VoiceOver stays
                    // silent while the app is inactive.
                    Color.black.ignoresSafeArea()
                        .accessibilityHidden(true)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
                shell.covered = true
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                shell.covered = false
            }
        }
    }
}

/// Third-party keyboards are refused: a custom keyboard is a separate process
/// that can see what is typed, which would break the promise that nothing
/// leaves the phone.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        shouldAllowExtensionPointIdentifier extensionPointIdentifier: UIApplication.ExtensionPointIdentifier
    ) -> Bool {
        extensionPointIdentifier != .keyboard
    }
}

/// Owns the adapters and the Kotlin shell.
///
/// Nothing here decides anything: the Kotlin `AppController` owns the state
/// machine, and every adapter below only captures, plays, encrypts, reads or
/// writes bytes.
final class Shell: ObservableObject {
    @Published var covered = false
    @Published private(set) var composeController: UIViewController?

    private let app: ShellApp?

    init() {
        guard let services = try? AppServices(resources: Resources()) else {
            // A missing or unpinned resource is fatal at launch: the app must
            // never run with a file it has not checked.
            app = nil
            composeController = nil
            return
        }
        let shellApp = ShellApp(services: services)
        app = shellApp
        composeController = shellApp.viewController
    }

    /// Magic Tap (a two-finger double tap) starts or stops the talk button.
    /// False on Setup, where there is no session: VoiceOver then falls back to
    /// its default action instead of the gesture silently doing nothing.
    @discardableResult
    func magicTap() -> Bool {
        guard let app, app.isStarted() else { return false }
        app.magicTap()
        return true
    }

    /// The escape gesture goes back one question, or closes a read-back.
    @discardableResult
    func escape() -> Bool {
        guard let app, app.isStarted() else { return false }
        app.escape()
        return true
    }
}

/// Hosts the Compose Multiplatform view controller and takes the two
/// accessibility gestures Compose does not see: Magic Tap and escape.
struct HostView: UIViewControllerRepresentable {
    let controller: UIViewController
    let shell: Shell

    func makeUIViewController(context: Context) -> UIViewController {
        let container = GestureHost()
        container.magicTap = { [weak shell] in shell?.magicTap() ?? false }
        container.escape = { [weak shell] in shell?.escape() ?? false }
        container.addChild(controller)
        controller.view.frame = container.view.bounds
        controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.view.addSubview(controller.view)
        controller.didMove(toParent: container)
        return container
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}

/// A container that answers the two VoiceOver gestures. It sits above the
/// Compose controller so VoiceOver sends them here.
final class GestureHost: UIViewController {
    var magicTap: (() -> Bool)?
    var escape: (() -> Bool)?

    override func accessibilityPerformMagicTap() -> Bool {
        magicTap?() ?? false
    }

    override func accessibilityPerformEscape() -> Bool {
        escape?() ?? false
    }
}
