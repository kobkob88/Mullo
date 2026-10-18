import Foundation
import UserNotifications

/// Task reminders (S47, iPhone side of android/.../Reminders.kt): a task with a day and a time
/// rings then, with Done / 1 hour / Tomorrow. The web code (app/domain/reminders.js) sends the
/// whole list after every change; it's kept here and iOS holds the scheduled notifications
/// (they survive a reboot, and a floating date follows the phone into another time zone).
/// Done / Snooze tapped on a notification is queued as a "tap" for the web code, which writes
/// it through actions.js (activity log, sync). No server ever reads tasks for this.
/// "Hide task text on the lock screen": iOS can't hide one notification only while locked, so
/// the text is left out entirely ("A task is due").
final class Reminders: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Reminders()

    private static let max = 64 // iOS keeps at most 64 pending notifications per app
    private static let category = "mullo.reminder"
    private static let prefix = "mullo-reminder-"
    private static let listKey = "reminders"     // { hideOnLock, items: [{ id, at, text, from }] }
    private static let tapsKey = "reminderTaps"  // [{ key, id, act, date?, time? }]
    private let lock = NSLock()
    private let store = UserDefaults.standard

    /// A tap was queued (Mullo open or not): the web view hands the taps to the page.
    var onTap: (@MainActor () -> Void)?
    /// The notification itself was tapped: open that task (`#/actions/<id>`, like Android).
    /// Kept here until the page has loaded (a tap can launch Mullo).
    var openWaiting: String?
    var onOpen: (@MainActor () -> Void)?

    /// At launch, before any notification can be delivered to us.
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([UNNotificationCategory(
            identifier: Self.category,
            actions: [
                UNNotificationAction(identifier: "done", title: "Done", options: []),
                UNNotificationAction(identifier: "hour", title: "1 hour", options: []),
                UNNotificationAction(identifier: "tomorrow", title: "Tomorrow", options: []),
            ],
            intentIdentifiers: [], options: [])])
    }

    // MARK: from the web code

    /// The whole list, checked and capped, then the notifications follow it.
    func save(_ json: String) {
        guard let raw = Self.object(json) else { return }
        let on = raw["on"] as? Bool ?? true
        lock.lock()
        // A Done / Snooze the web code hasn't written yet wins over the list it sent: its
        // task row still has the old time, and the snoozed reminder must not be lost.
        var pending: [String: [String: Any]] = [:]
        for tap in taps() { if let id = tap["id"] as? String { pending[id] = tap } }
        var clean: [[String: Any]] = []
        for item in ((raw["items"] as? [[String: Any]]) ?? []).prefix(Self.max) {
            guard let id = item["id"] as? String, Self.validId(id) else { continue }
            let tap = pending[id]
            if tap?["act"] as? String == "done" { continue }
            let at = (tap?["date"] as? String).map { "\($0)T\(tap?["time"] as? String ?? "")" } ?? (item["at"] as? String ?? "")
            guard Self.components(at) != nil else { continue }
            var out: [String: Any] = ["id": id, "at": at, "text": String((item["text"] as? String ?? "").prefix(300))]
            if let from = item["from"] as? String { out["from"] = String(from.prefix(200)) }
            clean.append(out)
        }
        // A snoozed task the web code left out (its old time has passed) stays, at its new time.
        let sent = Set(clean.compactMap { $0["id"] as? String })
        if on {
            for var item in items() {
                guard let id = item["id"] as? String, !sent.contains(id), let tap = pending[id],
                      let date = tap["date"] as? String, let time = tap["time"] as? String else { continue }
                item["at"] = "\(date)T\(time)"
                clean.append(item)
            }
        }
        let hide = raw["hideOnLock"] as? Bool ?? false
        writeList(["hideOnLock": hide, "items": clean])
        lock.unlock()
        if !clean.isEmpty { askOnce() }
        scheduleAll()
    }

    /// The waiting taps, for the web code (applyReminderTaps).
    func tapsJSON() -> String {
        lock.lock(); defer { lock.unlock() }
        return Self.json(taps()) ?? "[]"
    }

    /// The web code wrote these: they go. Taps that came in meanwhile stay.
    func tapsDone(_ json: String) {
        guard let data = json.data(using: .utf8), let keys = try? JSONSerialization.jsonObject(with: data) as? [String] else { return }
        let done = Set(keys)
        lock.lock()
        store.set(Self.json(taps().filter { !done.contains($0["key"] as? String ?? "") }), forKey: Self.tapsKey)
        lock.unlock()
    }

    // MARK: notifications

    private func askOnce() {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            guard s.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
                if ok { self.scheduleAll() }
            }
        }
    }

    /// Every notification again from the kept list; ones for tasks no longer in it go.
    private func scheduleAll() {
        lock.lock()
        let list = Self.object(store.string(forKey: Self.listKey) ?? "") ?? [:]
        lock.unlock()
        let hide = list["hideOnLock"] as? Bool ?? false
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { requests in
            let ours = requests.map(\.identifier).filter { $0.hasPrefix(Self.prefix) }
            center.removePendingNotificationRequests(withIdentifiers: ours)
            for item in (list["items"] as? [[String: Any]]) ?? [] {
                guard let id = item["id"] as? String, let at = item["at"] as? String, let when = Self.components(at) else { continue }
                let content = UNMutableNotificationContent()
                let text = (item["text"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "A task is due"
                content.title = hide ? "A task is due" : text
                if !hide, let from = item["from"] as? String, !from.isEmpty { content.body = "from \(from)" }
                content.sound = .default
                content.categoryIdentifier = Self.category
                content.threadIdentifier = "reminders"
                content.userInfo = ["id": id, "at": at]
                let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: false)
                center.add(UNNotificationRequest(identifier: Self.prefix + id, content: content, trigger: trigger))
            }
        }
    }

    /// Shown even while Mullo is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    /// Done / 1 hour / Tomorrow (or a plain tap, which just opens Mullo).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        if let id = info["id"] as? String, Self.validId(id) {
            if ["done", "hour", "tomorrow"].contains(action) {
                tapped(action, id: id)
            } else if action == UNNotificationDefaultActionIdentifier {
                Task { @MainActor in
                    self.openWaiting = id
                    self.onOpen?()
                }
            }
        }
        done()
    }

    private func tapped(_ action: String, id: String) {
        var tap: [String: Any] = ["key": "\(Int(Date().timeIntervalSince1970 * 1000))-\(id)", "id": id,
                                  "act": action == "done" ? "done" : "snooze"]
        lock.lock()
        var list = Self.object(store.string(forKey: Self.listKey) ?? "") ?? [:]
        var kept: [[String: Any]] = []
        for var item in (list["items"] as? [[String: Any]]) ?? [] {
            guard item["id"] as? String == id else { kept.append(item); continue }
            if action == "done" { continue }
            // Snooze: an hour from now, or tomorrow at the reminder's own time.
            let cal = Calendar.current
            let was = Self.components(item["at"] as? String ?? "")
            var next: Date
            if action == "hour" {
                next = Date().addingTimeInterval(3600)
            } else {
                let tomorrow = cal.date(byAdding: .day, value: 1, to: Date()) ?? Date()
                next = cal.date(bySettingHour: was?.hour ?? 9, minute: was?.minute ?? 0, second: 0, of: tomorrow) ?? tomorrow
            }
            let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: next)
            let date = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
            let time = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
            item["at"] = "\(date)T\(time)"
            tap["date"] = date
            tap["time"] = time
            kept.append(item)
        }
        list["items"] = kept
        writeList(list)
        var all = taps()
        if all.count < 200 { all.append(tap) }
        store.set(Self.json(all), forKey: Self.tapsKey)
        lock.unlock()
        scheduleAll()
        Task { @MainActor in self.onTap?() }
    }

    // MARK: storage + parsing

    private func items() -> [[String: Any]] {
        (Self.object(store.string(forKey: Self.listKey) ?? "")?["items"] as? [[String: Any]]) ?? []
    }

    private func taps() -> [[String: Any]] {
        guard let data = store.string(forKey: Self.tapsKey)?.data(using: .utf8) else { return [] }
        return (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
    }

    private func writeList(_ list: [String: Any]) { store.set(Self.json(list), forKey: Self.listKey) }

    private static func validId(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil
    }

    /// "YYYY-MM-DDTHH:MM", local and floating (no time zone): rings at that clock time wherever the phone is.
    private static func components(_ at: String) -> DateComponents? {
        let p = at.split(whereSeparator: { $0 == "-" || $0 == "T" || $0 == ":" }).compactMap { Int($0) }
        guard at.count == 16, p.count == 5, (1...12).contains(p[1]), (1...31).contains(p[2]),
              (0...23).contains(p[3]), (0...59).contains(p[4]) else { return nil }
        return DateComponents(year: p[0], month: p[1], day: p[2], hour: p[3], minute: p[4])
    }

    private static func object(_ json: String) -> [String: Any]? {
        guard let data = json.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
