import AVFoundation
import Foundation
import SsaCore

/// `AVAudioEngine` capture, converted to 16 kHz mono float32 (plan, Phase C3
/// `audioCapture`).
///
/// The samples go into the Kotlin `CaptureBuffer`, which the speech-to-text
/// port reads; this adapter only records, measures and converts. The peak and
/// the speech flag use `core`'s threshold (`TurnController.QUIET_PEAK`, 0.05),
/// kept here as the per-platform number the plan allows.
///
/// The audio tap runs on a real-time thread and `stop()` on the main thread,
/// so the samples and the peak live behind one serial queue: the tap appends,
/// and `stop()` drains it before reading.
///
/// An interruption pauses the engine and is reported as a capture with no
/// samples and a full-scale peak. **Today that still ends in the turn loop's
/// `REASK.nothingHeard`**: `sendAudio` rejects an empty blob before it ever asks
/// the transcriber. C3 wants "an interruption is not 'nothing heard'", which
/// needs a `src/turn.js` path first (TODO.md, and the Progress entry).
final class CaptureAdapter: NSObject, IosAudioCapture {
    private static let speechPeak: Float = 0.05
    private static let sampleRate: Double = 16_000

    private let engine = AVAudioEngine()
    private let sampleQueue = DispatchQueue(label: "org.ssa.assistant.capture")
    private var buffer: CaptureBuffer?
    private var samples: [Float] = []
    private var peak: Float = 0
    private var startedAt: Date?
    private var interrupted = false
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?
    private var observing = false

    func attach(buffer: CaptureBuffer) {
        self.buffer = buffer
    }

    func start() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true)
        } catch {
            return false
        }
        observeInterruptions()

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard let output = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Self.sampleRate,
            channels: 1,
            interleaved: false
        ), let converter = AVAudioConverter(from: inputFormat, to: output) else {
            return false
        }
        self.converter = converter
        self.outputFormat = output
        sampleQueue.sync {
            samples = []
            peak = 0
        }
        interrupted = false
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.consume(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return false
        }
        startedAt = Date()
        return true
    }

    func stop() -> IosCaptureInfo {
        let elapsed = startedAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
        let wasInterrupted = interrupted
        tearDown()

        // Everything the tap queued has landed by the time this returns.
        var captured: [Float] = []
        var level: Float = 0
        sampleQueue.sync {
            captured = samples
            level = peak
            samples = []
        }

        if wasInterrupted {
            // No samples, and a full-scale peak so the capture does not look
            // like room tone. Be clear about the result: with no samples the
            // blob size is 0, so `sendAudio` reasks "I did not hear anything"
            // before the transcriber runs. That is not what C3 asks for; see
            // TODO.md and the Progress entry.
            buffer?.put(samples: floatArray([]), hadSpeech: true, peak: 1.0)
            return IosCaptureInfo(durationMs: Int32(elapsed), hadSpeech: true, peak: 1.0)
        }

        let hadSpeech = level >= Self.speechPeak
        buffer?.put(samples: floatArray(captured), hadSpeech: hadSpeech, peak: Double(level))
        return IosCaptureInfo(durationMs: Int32(elapsed), hadSpeech: hadSpeech, peak: Double(level))
    }

    func cancel() {
        tearDown()
        sampleQueue.sync { samples = [] }
    }

    func isRecording() -> Bool {
        engine.isRunning
    }

    func releaseMic() {
        tearDown()
    }

    // -- conversion -----------------------------------------------------------

    private func consume(_ input: AVAudioPCMBuffer) {
        guard let converter, let output = outputFormat else { return }
        let ratio = output.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return input
        }
        if error != nil { return }
        guard let channel = converted.floatChannelData?[0] else { return }

        var chunk = [Float]()
        chunk.reserveCapacity(Int(converted.frameLength))
        for index in 0..<Int(converted.frameLength) {
            chunk.append(channel[index])
        }
        sampleQueue.async { [weak self] in
            guard let self else { return }
            self.samples.append(contentsOf: chunk)
            for value in chunk where abs(value) > self.peak {
                self.peak = abs(value)
            }
        }
    }

    private func floatArray(_ values: [Float]) -> KotlinFloatArray {
        let array = KotlinFloatArray(size: Int32(values.count))
        for (index, value) in values.enumerated() {
            array.set(index: Int32(index), value: value)
        }
        return array
    }

    // -- session --------------------------------------------------------------

    private func observeInterruptions() {
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let self,
                  let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                // Pause: the capture so far is marked not-silence.
                self.interrupted = true
                self.engine.inputNode.removeTap(onBus: 0)
                self.engine.stop()
            }
        }
    }

    private func tearDown() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        startedAt = nil
    }
}
