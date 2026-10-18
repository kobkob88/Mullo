import Foundation
import WatchConnectivity

/// Hands finished notes to the iPhone. WatchConnectivity queues each file until the
/// iPhone takes it, even with Mullo closed there. A note stays on the watch until its
/// transfer finished; anything left over (the watch app was closed mid-transfer) goes
/// again on the next start. The iPhone keys notes by id, so a resend is never a duplicate.
final class Sender: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = Sender()

    /// Notes recorded but not yet taken by the iPhone.
    @Published private(set) var waiting = 0

    static let dir: URL = {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("pending", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// A note's audio: raw AAC (Recorder, since 2026-10-17; the iPhone repackages it), or an .m4a
    /// (older notes, and Recorder's last resort).
    static func aacURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).aac") }
    static func m4aURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).m4a") }
    static func audioURL(_ id: String) -> URL? {
        [aacURL(id), m4aURL(id)].first { FileManager.default.fileExists(atPath: $0.path) }
    }
    private static func metaURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        refreshCount()
    }

    /// A finished note: its details are written first (so a resend has them), then the raw audio
    /// (if any; an .m4a is already here) moves in beside them, then it's sent. Dying in between
    /// leaves the audio in Recorder's folder, which sends it again at the next launch.
    func send(id: String, meta: [String: Any], raw: URL? = nil) {
        if let data = try? JSONSerialization.data(withJSONObject: meta) {
            try? data.write(to: Self.metaURL(id), options: .atomic)
        }
        if let raw, FileManager.default.fileExists(atPath: raw.path) {
            try? FileManager.default.removeItem(at: Self.aacURL(id))
            try? FileManager.default.moveItem(at: raw, to: Self.aacURL(id))
        }
        transfer(id: id, meta: meta)
        refreshCount()
    }

    private func transfer(id: String, meta: [String: Any]) {
        guard WCSession.default.activationState == .activated, let audio = Self.audioURL(id) else { return } // sent once activated
        var meta = meta
        if audio.pathExtension == "aac" { meta["format"] = "aac" } // the iPhone repackages it
        WCSession.default.transferFile(audio, metadata: meta)
    }

    /// Everything finished but not in flight goes (again).
    func resendLeftovers() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        let inFlight = Set(WCSession.default.outstandingFileTransfers.map { $0.file.fileURL.lastPathComponent })
        let files = (try? FileManager.default.contentsOfDirectory(at: Self.dir, includingPropertiesForKeys: nil)) ?? []
        for meta in files where meta.pathExtension == "json" {
            let id = meta.deletingPathExtension().lastPathComponent
            guard !inFlight.contains("\(id).m4a"), !inFlight.contains("\(id).aac"),
                  Self.audioURL(id) != nil,
                  let data = try? Data(contentsOf: meta),
                  let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            transfer(id: id, meta: dict)
        }
        refreshCount()
    }

    private func refreshCount() {
        let files = (try? FileManager.default.contentsOfDirectory(at: Self.dir, includingPropertiesForKeys: nil)) ?? []
        let count = files.filter { $0.pathExtension == "json" }.count
        DispatchQueue.main.async { self.waiting = count }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated { resendLeftovers() }
    }

    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        // A failed transfer stays here and goes again on the next start.
        guard error == nil, let id = fileTransfer.file.metadata?["id"] as? String else { return }
        try? FileManager.default.removeItem(at: Self.aacURL(id))
        try? FileManager.default.removeItem(at: Self.m4aURL(id))
        try? FileManager.default.removeItem(at: Self.metaURL(id))
        refreshCount()
    }
}
