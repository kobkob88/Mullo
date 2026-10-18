import AVFoundation
import Foundation

/// Recording with the iPhone locked (S22d). The WebView's microphone stops when Mullo leaves
/// the screen, so inside the iPhone app the web code records through this instead
/// (app/capture/recorder.js, `MulloRecorder` in Bridge.swift). AVAudioRecorder + the
/// `audio` background mode keep going while locked. Same sound as the watch: AAC-LC 16 kHz
/// mono 32 kbps. A call or Siri pauses it; it carries on after if iOS allows,
/// else the web code is told the mic was lost and keeps what was recorded.
///
/// **A recording survives Mullo being killed mid-way (2026-10-17).** The file being written is
/// raw AAC (ADTS, from the `.aac` name): every frame stands alone, so a crash, a swipe-away or a
/// dead battery leaves it readable up to its last few seconds. An `.m4a` is only readable once
/// stop() finishes it (checked on the Mac: killed at 20 s, the .m4a didn't open, the .aac kept
/// ~17 s). Stop repackages it as .m4a (no re-encoding, ~0.1 s for an hour), so the web code gets
/// the same file as before. A file left by a killed Mullo goes to the inbox the watch notes use
/// (`from: "phone"`) the next time Mullo opens, and is saved like any recording. It lives in
/// Application Support (iOS may empty tmp while Mullo is closed, exactly when it must wait), kept
/// out of the iCloud backup, and goes once it is handed over.
@MainActor
final class NativeRecorder: NSObject, AVAudioRecorderDelegate {
    static let shared = NativeRecorder()

    private var recorder: AVAudioRecorder?
    private var current = "" // the id of the file being written
    private var lost = false
    private var pausedByPerson = false
    private var recovering = false
    private var recoverAgain = false
    private var handingOver: Set<String> = [] // stopped, being repackaged for the web code

    private static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = base.appendingPathComponent("recording", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }()

    private static func audioURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).aac") }
    private static func metaURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }

    var isRecording: Bool { recorder != nil }

    /// → nil when recording, or why not ("denied", or the system's message).
    func start(_ done: @escaping (String?) -> Void) {
        AVAudioSession.sharedInstance().requestRecordPermission { ok in
            Task { @MainActor in done(ok ? self.begin() : "denied") }
        }
    }

    private func begin() -> String? {
        stopQuietly()
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let id = UUID().uuidString
            let meta: [String: Any] = ["started_at": Int(Date().timeIntervalSince1970 * 1000)]
            if let data = try? JSONSerialization.data(withJSONObject: meta) {
                try? data.write(to: Self.metaURL(id), options: .atomic)
            }
            let r = try AVAudioRecorder(url: Self.audioURL(id), settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ])
            r.delegate = self
            r.isMeteringEnabled = true
            guard r.record() else { Self.discard(id); return "The microphone didn't start" }
            recorder = r
            current = id
            lost = false
            pausedByPerson = false
            NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)),
                                                   name: AVAudioSession.interruptionNotification, object: session)
            // A recording the web code lost track of (stopped by stopQuietly above) is saved, not dropped.
            Task { await self.recoverLeftovers() }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// For the meter and the "mic lost" check: { level 0..1, state }.
    func poll() -> [String: Any] {
        guard let r = recorder else { return ["level": 0, "state": "stopped"] }
        r.updateMeters()
        let db = r.averagePower(forChannel: 0) // -160...0
        let level = max(0, min(1, (db + 50) / 50))
        let state = lost ? "lost" : (r.isRecording ? "recording" : "paused")
        return ["level": level, "state": state]
    }

    func pause() { pausedByPerson = true; recorder?.pause() }
    func resume() { pausedByPerson = false; if !lost { recorder?.record() } }

    /// → the file as base64 + its real length, then it goes.
    func stop() async -> [String: Any] {
        guard let r = recorder else { return [:] }
        let id = current
        let durationMs = Int(r.currentTime * 1000)
        r.stop()
        finish()
        handingOver.insert(id)
        defer { Self.discard(id); handingOver.remove(id) }
        if let m4a = await Self.repackage(Self.audioURL(id)) {
            defer { try? FileManager.default.removeItem(at: m4a) }
            if let data = try? Data(contentsOf: m4a) {
                return ["audio": data.base64EncodedString(), "duration_ms": durationMs, "mime": "audio/mp4"]
            }
        }
        // Repackaging failed: the raw AAC plays and transcribes too.
        let data = (try? Data(contentsOf: Self.audioURL(id))) ?? Data()
        return ["audio": data.base64EncodedString(), "duration_ms": durationMs, "mime": "audio/aac"]
    }

    /// Recordings a killed Mullo left behind → the inbox (WatchInbox, `from: "phone"`), which the web
    /// code drains into the library. Called at launch and when a recording starts; never touches the
    /// one being written. One run at a time; a call during a run makes it look once more.
    func recoverLeftovers() async {
        if recovering { recoverAgain = true; return }
        recovering = true
        defer { recovering = false }
        repeat {
            recoverAgain = false
            let files = (try? FileManager.default.contentsOfDirectory(at: Self.dir, includingPropertiesForKeys: nil)) ?? []
            for file in files where file.pathExtension == "aac" {
                let id = file.deletingPathExtension().lastPathComponent
                if (id == current && recorder != nil) || handingOver.contains(id) { continue }
                await recover(id)
            }
        } while recoverAgain
    }

    private func recover(_ id: String) async {
        let audio = Self.audioURL(id)
        guard WatchInbox.safeId(id) else { Self.discard(id); return }
        guard let m4a = await Self.repackage(audio) else {
            // Nothing readable (killed in its first moment): nothing to keep. Anything bigger is
            // tried again next time rather than lost.
            let size = (try? audio.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size < 4_096 { Self.discard(id) }
            return
        }
        var meta: [String: Any] = ["from": "phone"]
        if let data = try? Data(contentsOf: Self.metaURL(id)),
           let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let started = saved["started_at"] as? NSNumber {
            meta["started_at"] = started
        }
        if let duration = try? await AVURLAsset(url: m4a).load(.duration), duration.seconds.isFinite {
            meta["duration_ms"] = Int(duration.seconds * 1000)
        }
        if WatchInbox.shared.adopt(id: id, audio: m4a, meta: meta) {
            Self.discard(id)
        } else {
            try? FileManager.default.removeItem(at: m4a)
        }
    }

    /// The raw AAC as an .m4a beside it (same sound, new box), or nil if it couldn't be read.
    /// Also used for the watch's notes (WatchInbox): watchOS can't repackage audio.
    nonisolated static func repackage(_ src: URL) async -> URL? {
        let dst = src.deletingPathExtension().appendingPathExtension("m4a")
        try? FileManager.default.removeItem(at: dst)
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: src), presetName: AVAssetExportPresetPassthrough) else {
            return nil
        }
        if #available(iOS 18, *) {
            do { try await session.export(to: dst, as: .m4a) } catch { return nil }
            return dst
        }
        session.outputURL = dst
        session.outputFileType = .m4a
        await session.export()
        return session.status == .completed ? dst : nil
    }

    private static func discard(_ id: String) {
        try? FileManager.default.removeItem(at: audioURL(id))
        try? FileManager.default.removeItem(at: metaURL(id))
    }

    private func stopQuietly() {
        recorder?.stop()
        finish()
    }

    private func finish() {
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// A call or Siri took the mic. After it, go on if iOS says so; else the mic is lost.
    @objc private nonisolated func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init)
        Task { @MainActor in
            guard let r = self.recorder, type == .ended else { return }
            if options?.contains(.shouldResume) == true, !self.pausedByPerson,
               (try? AVAudioSession.sharedInstance().setActive(true)) != nil, r.record() {
                return
            }
            if !self.pausedByPerson { self.lost = true }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in self.lost = true }
    }
}
