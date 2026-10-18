import SwiftUI

@main
struct MulloWatchApp: App {
    @StateObject private var recorder = Recorder()

    init() {
        // A note the app died in the middle of goes first, so this start sends it (Recorder).
        Recorder.sendLeftovers()
        Sender.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(recorder)
                // The watch-face complication (MulloComplication): a tap starts recording,
                // a tap while recording stops and sends, like the Galaxy Watch's.
                .onOpenURL { url in
                    if url.scheme == "mullo", url.host == "record" { recorder.toggle() }
                }
        }
    }
}
