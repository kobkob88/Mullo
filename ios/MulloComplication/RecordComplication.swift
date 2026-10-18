import SwiftUI
import WidgetKit

/// "Mullo record" on any watch face, like the Galaxy Watch's RecordComplicationService (owner,
/// 2026-10-10: start recording on tap). A complication can't record by itself: a tap opens the
/// watch app with mullo://record, and the app toggles the recorder (MulloWatchApp onOpenURL).
/// It always shows the mic: saying "Stop" while recording would need an App Group shared with
/// the app; the app's own screen shows the timer meanwhile.
@main
struct RecordComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.mullo.record", provider: Provider()) { _ in
            RecordView()
        }
        .configurationDisplayName("Record")
        .description("Tap to start a voice note. Tap again to stop and send it.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline, .accessoryRectangular])
    }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> SimpleEntry { SimpleEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (SimpleEntry) -> Void) { completion(SimpleEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SimpleEntry>) -> Void) {
        completion(Timeline(entries: [SimpleEntry(date: Date())], policy: .never))
    }
}

struct SimpleEntry: TimelineEntry {
    let date: Date
}

struct RecordView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .widgetURL(URL(string: "mullo://record"))
            .accessibilityLabel("Mullo, start recording")
            .modifier(ClearBackground())
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryCorner:
            Image(systemName: "mic.fill")
                .font(.title2)
                .widgetLabel("Mullo")
        case .accessoryInline:
            Label("Mullo", systemImage: "mic.fill")
        case .accessoryRectangular:
            HStack(spacing: 8) {
                Image(systemName: "mic.circle.fill").font(.title)
                VStack(alignment: .leading) {
                    Text("Mullo").font(.headline)
                    Text("Tap to record").font(.caption)
                }
                Spacer(minLength: 0)
            }
        default:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "mic.fill").font(.title2)
            }
        }
    }
}

/// watchOS 10 and later want a container background, or the face shows a "please adopt" hint.
private struct ClearBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(watchOS 10.0, *) {
            content.containerBackground(.clear, for: .widget)
        } else {
            content
        }
    }
}
