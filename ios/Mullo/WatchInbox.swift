import AVFoundation
import Foundation
import WatchConnectivity

/// Notes recorded on the Apple Watch, kept here until the web app has saved them.
/// Same contract as Android's watch inbox (app/capture/watch-inbox.js): list → entries,
/// the audio per id, done(id) once saved. The web app asks through Bridge.swift.
/// Sendable: its only state is files on disk (FileManager is thread-safe); audio is read off the main thread.
final class WatchInbox: NSObject, WCSessionDelegate, @unchecked Sendable {
    static let shared = WatchInbox()

    /// Called on the main thread when a note lands; the web view fires `mullo-watch`.
    var onNewNote: (() -> Void)?

    private let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("watch-inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    func start() {
        // A raw watch note whose repackaging was cut short (Mullo killed) gets it now.
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.lastPathComponent.hasSuffix(".raw.json") {
            let id = String(file.lastPathComponent.dropLast(".raw.json".count))
            if Self.safeId(id) { Task { await self.finishRaw(id) } }
        }
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Ids come from the watch (a UUID); anything else never becomes a path.
    static func safeId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    private func audioURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).m4a") }
    private func metaURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }
    // A raw AAC note from the watch until it is repackaged. "<id>.raw.json" never lists:
    // "<id>.raw" isn't a safe id.
    private func rawURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).aac") }
    private func rawMetaURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).raw.json") }

    /// JSON array of {id, started_at, duration_ms, battery_start, battery_end}, oldest first.
    func listJSON() -> String {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        var entries: [[String: Any]] = []
        for meta in files where meta.pathExtension == "json" {
            let id = meta.deletingPathExtension().lastPathComponent
            guard Self.safeId(id),
                  FileManager.default.fileExists(atPath: audioURL(id).path),
                  let data = try? Data(contentsOf: meta),
                  var entry = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            entry["id"] = id
            entries.append(entry)
        }
        entries.sort { (($0["started_at"] as? NSNumber)?.doubleValue ?? 0) < (($1["started_at"] as? NSNumber)?.doubleValue ?? 0) }
        guard let data = try? JSONSerialization.data(withJSONObject: entries) else { return "[]" }
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    /// The note's audio as base64 (the WebView can't be served files on Mullo's address).
    func audioBase64(_ id: String) -> String? {
        guard Self.safeId(id), let data = try? Data(contentsOf: audioURL(id)) else { return nil }
        return data.base64EncodedString()
    }

    /// A recording made on this iPhone that a killed Mullo never handed over (NativeRecorder):
    /// it waits here like a watch note, marked `from: "phone"`. The .m4a is moved in.
    /// → false if it couldn't be kept (the caller keeps its own copy then).
    @discardableResult
    func adopt(id: String, audio: URL, meta: [String: Any]) -> Bool {
        guard Self.safeId(id) else { return false }
        try? FileManager.default.removeItem(at: audioURL(id))
        do { try FileManager.default.moveItem(at: audio, to: audioURL(id)) } catch { return false }
        guard let data = try? JSONSerialization.data(withJSONObject: meta),
              (try? data.write(to: metaURL(id), options: .atomic)) != nil else {
            try? FileManager.default.removeItem(at: audioURL(id))
            return false
        }
        DispatchQueue.main.async { self.onNewNote?() }
        return true
    }

    /// The web app saved it: the copy here goes.
    func done(_ id: String) {
        guard Self.safeId(id) else { return }
        try? FileManager.default.removeItem(at: audioURL(id))
        try? FileManager.default.removeItem(at: metaURL(id))
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // The system deletes the file when this returns: move it now.
        let meta = file.metadata ?? [:]
        guard let id = meta["id"] as? String, Self.safeId(id) else { return }
        var entry: [String: Any] = [:]
        for key in ["started_at", "duration_ms", "battery_start", "battery_end"] {
            if let value = meta[key] as? NSNumber { entry[key] = value }
        }
        if (meta["format"] as? String) == "aac" {
            // Raw AAC (the watch's Recorder): kept with its details, repackaged as .m4a, then listed.
            try? FileManager.default.removeItem(at: rawURL(id))
            do { try FileManager.default.moveItem(at: file.fileURL, to: rawURL(id)) } catch { return }
            guard let data = try? JSONSerialization.data(withJSONObject: entry),
                  (try? data.write(to: rawMetaURL(id), options: .atomic)) != nil else { return }
            Task { await self.finishRaw(id) }
            return
        }
        try? FileManager.default.removeItem(at: audioURL(id))
        do { try FileManager.default.moveItem(at: file.fileURL, to: audioURL(id)) } catch { return }
        // Written after the audio: list only shows a note once both are here.
        if let data = try? JSONSerialization.data(withJSONObject: entry) {
            try? data.write(to: metaURL(id), options: .atomic)
        }
        DispatchQueue.main.async { self.onNewNote?() }
    }

    /// A raw watch note → "<id>.m4a" + "<id>.json", listed like any other. A note the watch app died
    /// in the middle of comes without a length: it's read from the file. Unreadable and tiny (the
    /// app died as the mic opened) = nothing to keep; bigger is tried again at the next start.
    private func finishRaw(_ id: String) async {
        let raw = rawURL(id)
        guard FileManager.default.fileExists(atPath: raw.path),
              let data = try? Data(contentsOf: rawMetaURL(id)),
              var entry = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        guard let m4a = await NativeRecorder.repackage(raw) else {
            let size = (try? raw.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size < 4_096 {
                try? FileManager.default.removeItem(at: raw)
                try? FileManager.default.removeItem(at: rawMetaURL(id))
            }
            return
        }
        if entry["duration_ms"] == nil,
           let duration = try? await AVURLAsset(url: m4a).load(.duration), duration.seconds.isFinite {
            entry["duration_ms"] = Int(duration.seconds * 1000)
        }
        // m4a is already audioURL(id) (repackage writes beside the .aac).
        guard let json = try? JSONSerialization.data(withJSONObject: entry),
              (try? json.write(to: metaURL(id), options: .atomic)) != nil else { return }
        try? FileManager.default.removeItem(at: raw)
        try? FileManager.default.removeItem(at: rawMetaURL(id))
        DispatchQueue.main.async { self.onNewNote?() }
    }
}
