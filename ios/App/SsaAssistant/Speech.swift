import AVFoundation
import SsaCore
import UIKit

/// `AVSpeechSynthesizer` with an on-device en-US voice (plan, Phase C3
/// `speech`).
///
/// It waits for VoiceOver only when an announcement this app posted is still
/// in flight ([beginAnnouncement]/[endAnnouncement], driven by
/// `AppServices.announce`). An announcement outlives a short utterance, so the
/// completion is held until `announcementDidFinish` arrives or a short grace
/// period passes; with nothing in flight it finishes at once.
///
/// Every utterance carries a [generation]. The delegate, the announcement
/// observer and the grace timer belong to the generation that scheduled them,
/// and [finish] ignores a callback from an older one: a stale timer must never
/// resume the *next* prompt's `speak` while it is still playing.
final class SpeechAdapter: NSObject, IosSpeech, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var completion: (() -> Void)?
    private var current: AVSpeechUtterance?
    private var generation = 0
    private var waitingForAnnouncement = false

    /// The wait for the utterance's own VoiceOver announcement, if any.
    private var announcementObserver: NSObjectProtocol?
    /// One shot, installed when this app posts an announcement.
    private var pendingObserver: NSObjectProtocol?
    private var announcementInFlight = false

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    deinit {
        for observer in [announcementObserver, pendingObserver].compactMap({ $0 }) {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func speak(text: String, interrupt: Bool, lang: String, done: @escaping () -> Void) {
        if interrupt {
            synthesizer.stopSpeaking(at: .immediate)
        }
        // A `speak` that arrives without `interrupt` must not leave the
        // previous caller suspended forever: it is answered first, as the new
        // utterance supersedes it.
        finish(ifGeneration: generation)

        generation += 1
        completion = done
        let utterance = AVSpeechUtterance(string: text)
        // An on-device voice: no personal-voice or network voice is used.
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        current = utterance
        synthesizer.speak(utterance)
    }

    func cancel() {
        generation += 1
        synthesizer.stopSpeaking(at: .immediate)
        finish(ifGeneration: generation)
    }

    func isSpeaking() -> Bool {
        synthesizer.isSpeaking || waitingForAnnouncement
    }

    // -- VoiceOver announcements ----------------------------------------------

    /// An announcement was just posted; a finishing utterance must wait for it.
    func beginAnnouncement() {
        endAnnouncement()
        announcementInFlight = true
        pendingObserver = NotificationCenter.default.addObserver(
            forName: UIAccessibility.announcementDidFinishNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.endAnnouncement()
        }
    }

    /// The announcement finished (or was superseded), so nothing is left to
    /// wait for.
    func endAnnouncement() {
        announcementInFlight = false
        if let pendingObserver {
            NotificationCenter.default.removeObserver(pendingObserver)
            self.pendingObserver = nil
        }
    }

    // -- AVSpeechSynthesizerDelegate ------------------------------------------

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard utterance === current else { return }
        waitForVoiceOverThenFinish(generation: generation)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // A stop that races this utterance's start must not complete a newer
        // one: only the current utterance's cancellation counts.
        guard utterance === current else { return }
        finish(ifGeneration: generation)
    }

    private func waitForVoiceOverThenFinish(generation mine: Int) {
        guard UIAccessibility.isVoiceOverRunning, announcementInFlight else {
            finish(ifGeneration: mine)
            return
        }
        waitingForAnnouncement = true
        announcementObserver = NotificationCenter.default.addObserver(
            forName: UIAccessibility.announcementDidFinishNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.endAnnouncement()
            self?.finish(ifGeneration: mine)
        }
        // An announcement that never reports back must not wedge the
        // conversation.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.finish(ifGeneration: mine)
        }
    }

    /// Complete the utterance [mine] started, or do nothing when a later one
    /// has taken over.
    private func finish(ifGeneration mine: Int) {
        guard mine == generation else { return }
        waitingForAnnouncement = false
        current = nil
        if let announcementObserver {
            NotificationCenter.default.removeObserver(announcementObserver)
            self.announcementObserver = nil
        }
        if let completion {
            self.completion = nil
            completion()
        }
    }
}
