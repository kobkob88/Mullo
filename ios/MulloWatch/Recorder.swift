import AVFoundation
import WatchKit

/// Record on the watch, stop, hand the note to the iPhone (Sender). AAC at 32 kbps mono,
/// like the Wear OS watch: plenty for speech, small to send.
///
/// **A recording survives the watch app dying mid-way (2026-10-17)**, like the iPhone's
/// NativeRecorder: the file being written is raw AAC (`.aac`, ADTS), readable up to its last
/// few seconds whatever stops it (a flat battery, watchOS ending the app); an .m4a is only
/// readable once stop() finishes it. Its start time is written when it starts, in
/// Documents/recording. Stop moves it to Sender's pending folder; anything left in
/// Documents/recording at the next launch is sent the same way. watchOS can't repackage audio,
/// so the iPhone turns the .aac into .m4a when it arrives (WatchInbox).
@MainActor
final class Recorder: ObservableObject {
    enum State { case idle, recording, refused }

    @Published private(set) var state: State = .idle
    @Published private(set) var startedAt: Date?
    @Published private(set) var message: String?

    private var recorder: AVAudioRecorder?
    private var id = ""
    private var batteryStart: Int?

    func toggle() {
        if state == .recording { stop() } else { start() }
    }

    private func start() {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            Task { @MainActor in
                if granted { self.begin() } else { self.state = .refused }
            }
        }
    }

    private func begin() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
        } catch {
            message = "The microphone is busy"
            return
        }
        let id = UUID().uuidString
        let started = Date()
        let battery = Self.battery()
        var start: [String: Any] = ["started_at": Int(started.timeIntervalSince1970 * 1000)]
        if let battery { start["battery_start"] = battery }
        if let data = try? JSONSerialization.data(withJSONObject: start) {
            try? data.write(to: Self.startURL(id), options: .atomic)
        }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
        ]
        var withoutRate = settings
        withoutRate.removeValue(forKey: AVEncoderBitRateKey)
        // Raw AAC first; some encoders refuse the bit rate (the format's default is fine too). Last
        // resort: an .m4a straight into pending, as before (lost if the app dies, but it records).
        let tries: [(URL, [String: Any])] = [
            (Self.rawURL(id), settings), (Self.rawURL(id), withoutRate), (Sender.m4aURL(id), withoutRate),
        ]
        var rec: AVAudioRecorder?
        for (url, s) in tries {
            try? FileManager.default.removeItem(at: url)
            let r = try? AVAudioRecorder(url: url, settings: s)
            if r?.record() == true { rec = r; break }
        }
        guard let rec else {
            message = "Couldn't start recording"
            try? FileManager.default.removeItem(at: Self.startURL(id))
            try? session.setActive(false)
            return
        }
        recorder = rec
        self.id = id
        batteryStart = battery
        startedAt = started
        message = nil
        state = .recording
        WKInterfaceDevice.current().play(.start)
    }

    private func stop() {
        guard let rec = recorder, let started = startedAt else { return }
        let durationMs = Int(rec.currentTime * 1000) // read before stop() resets it
        rec.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        state = .idle
        startedAt = nil
        WKInterfaceDevice.current().play(.stop)

        var meta: [String: Any] = [
            "id": id,
            "started_at": Int(started.timeIntervalSince1970 * 1000),
            "duration_ms": durationMs,
        ]
        if let start = batteryStart { meta["battery_start"] = start }
        if let end = Self.battery() { meta["battery_end"] = end }
        Sender.shared.send(id: id, meta: meta, raw: Self.rawURL(id))
        try? FileManager.default.removeItem(at: Self.startURL(id))
    }

    // MARK: recordings the app didn't live to stop

    private static let dir: URL = {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("recording", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private static func rawURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).aac") }
    private static func startURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }

    /// At launch (nothing is recording yet): every .aac left in Documents/recording is a note the
    /// app died in the middle of. It goes to the iPhone like any other, with the start time and
    /// battery written when it began; its length is read on the iPhone. A start file with no audio
    /// (the app died before the mic opened, or after Sender took the audio) just goes.
    static func sendLeftovers() {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for file in files {
            let id = file.deletingPathExtension().lastPathComponent
            if file.pathExtension == "json" {
                if !FileManager.default.fileExists(atPath: rawURL(id).path) { try? FileManager.default.removeItem(at: file) }
                continue
            }
            guard file.pathExtension == "aac" else { continue }
            var meta: [String: Any] = ["id": id]
            if let data = try? Data(contentsOf: startURL(id)),
               let start = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                for key in ["started_at", "battery_start"] { if let v = start[key] as? NSNumber { meta[key] = v } }
            }
            if meta["started_at"] == nil,
               let made = (try? file.resourceValues(forKeys: [.creationDateKey]))?.creationDate {
                meta["started_at"] = Int(made.timeIntervalSince1970 * 1000)
            }
            Sender.shared.send(id: id, meta: meta, raw: file)
            try? FileManager.default.removeItem(at: startURL(id))
        }
    }

    /// Battery % when a note starts and when it's sent: kept on the recording so real use can
    /// answer "what does an hour of recording cost?" (app/capture/watch-inbox.js watchBattery).
    private static func battery() -> Int? {
        let device = WKInterfaceDevice.current()
        device.isBatteryMonitoringEnabled = true
        let level = device.batteryLevel
        return level >= 0 ? Int((level * 100).rounded()) : nil
    }
}
