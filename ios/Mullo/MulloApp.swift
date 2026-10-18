import SwiftUI

@main
struct MulloApp: App {
    init() {
        // Early, so a note the watch sent while Mullo was closed is taken in at launch.
        WatchInbox.shared.start()
        // Before launch finishes, so a Done / Snooze tapped with Mullo closed reaches us.
        Reminders.shared.start()
        // App Store transactions (renewals, Ask to Buy) arrive any time; listen from launch.
        Task { @MainActor in Store.shared.start() }
        // A recording Mullo was killed in the middle of goes to the inbox, to be saved (NativeRecorder).
        Task { @MainActor in await NativeRecorder.shared.recoverLeftovers() }
    }

    var body: some Scene {
        WindowGroup {
            MulloWebView()
                .ignoresSafeArea()
                .background(Color(red: 0x10 / 255, green: 0x14 / 255, blue: 0x18 / 255))
                // mullo://open (Back to Mullo, from Safari): being opened is all it does. Nothing in
                // the link is read, so a web page can't hand Mullo anything this way.
                .onOpenURL { _ in }
        }
    }
}
