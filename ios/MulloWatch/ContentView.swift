import SwiftUI

/// One big button: red dot = record, square = stop and send to the iPhone.
struct ContentView: View {
    @EnvironmentObject private var recorder: Recorder
    @ObservedObject private var sender = Sender.shared
    @Environment(\.scenePhase) private var phase

    var body: some View {
        VStack(spacing: 8) {
            if recorder.state == .recording, let started = recorder.startedAt {
                Text(started, style: .timer)
                    .font(.title3.monospacedDigit())
            } else {
                Text("Mullo").font(.headline)
            }
            Button {
                recorder.toggle()
            } label: {
                ZStack {
                    Circle()
                        .fill(recorder.state == .recording ? Color.white : Color(red: 1, green: 0.30, blue: 0.37))
                        .frame(width: 84, height: 84)
                    if recorder.state == .recording {
                        RoundedRectangle(cornerRadius: 6)
                            .fill(Color(red: 1, green: 0.30, blue: 0.37))
                            .frame(width: 30, height: 30)
                    } else {
                        Circle().fill(Color.white).frame(width: 26, height: 26)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(recorder.state == .recording ? "Stop and send" : "Start recording")
            Text(status)
                .font(.footnote)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .onChange(of: phase) { newPhase in
            if newPhase == .active { sender.resendLeftovers() }
        }
    }

    private var status: String {
        if recorder.state == .refused { return "Allow the microphone: Settings, Privacy, Microphone" }
        if let message = recorder.message { return message }
        if recorder.state == .recording { return "Tap to stop and send" }
        if sender.waiting > 0 { return "\(sender.waiting) waiting for iPhone" }
        return "Tap to record"
    }
}
