import SwiftUI
import UIKit
import WebKit

/// Stage 1 (roadmap S22) loads the live web app; the same address as Mullo in Safari,
/// so sign-in, AI and sync work exactly as there (same site as the API, no CORS change).
let mulloAppURL = URL(string: "https://mullo.lizai.io/app/")!
let mulloHost = "mullo.lizai.io"

struct MulloWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // the library (IndexedDB) and sign-in persist
        // Only mullo.lizai.io (WKAppBoundDomains) loads here; that turns on its service worker (S22a).
        config.limitsNavigationsToAppBoundDomains = true
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let content = config.userContentController
        content.addUserScript(WKUserScript(source: Bridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(context.coordinator, name: "mulloNative")
        content.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "mulloWatch")
        content.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "mulloRecorder")
        content.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "mulloSignIn")
        content.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "mulloStore")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = false
        web.scrollView.contentInsetAdjustmentBehavior = .never // the page pads for the notch itself
        web.isOpaque = false
        web.backgroundColor = .black
        if #available(iOS 16.4, *) { web.isInspectable = true } // Mac Safari → Develop, for testing
        context.coordinator.web = web
        WatchInbox.shared.onNewNote = { [weak web] in
            web?.evaluateJavaScript("window.dispatchEvent(new Event('mullo-watch'))", completionHandler: nil)
        }
        let coordinator = context.coordinator
        Reminders.shared.onTap = { [weak coordinator] in coordinator?.handTaps() }
        Reminders.shared.onOpen = { [weak coordinator] in coordinator?.openWaitingTask() }
        web.load(URLRequest(url: mulloAppURL))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate,
                             WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
        weak var web: WKWebView?
        private var downloads: [ObjectIdentifier: URL] = [:]
        private var lastOutside: (url: URL, at: Date)?

        private func isMullo(_ url: URL) -> Bool {
            url.scheme == "https" && url.host == mulloHost && url.path.hasPrefix("/app")
        }

        /// Messages only count from Mullo's own page, never from anything else loaded.
        private func fromMullo(_ message: WKScriptMessage) -> Bool {
            let origin = message.frameInfo.securityOrigin
            return message.frameInfo.isMainFrame && origin.protocol == "https" && origin.host == mulloHost
        }

        // MARK: messages from the web app

        /// MulloNative: keep the screen on while a recording runs (the WebView's microphone
        /// stops when Mullo leaves the screen; recording with the phone locked is a later stage).
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard fromMullo(message), let body = message.body as? [String: Any] else { return }
            switch body["op"] as? String {
            case "recording":
                // The native recorder goes on with the phone locked: the screen may sleep then.
                UIApplication.shared.isIdleTimerDisabled = (body["on"] as? Bool) == true && !NativeRecorder.shared.isRecording
            case "reminders":
                if let json = body["json"] as? String { Reminders.shared.save(json) }
            case "tapsDone":
                if let json = body["json"] as? String { Reminders.shared.tapsDone(json) }
            default:
                break
            }
        }

        // MARK: task reminders

        /// The waiting Done / Snooze taps into the page, then "mullo-reminder" so it writes them.
        func handTaps() {
            let taps = Reminders.shared.tapsJSON()
            web?.evaluateJavaScript("window.__mulloReminderTaps = \(taps); window.dispatchEvent(new Event('mullo-reminder'))",
                                    completionHandler: nil)
        }

        /// A tapped notification opens its task first (the id is checked in Reminders.swift).
        /// Before the page is there it waits for didFinish.
        func openWaitingTask() {
            guard let web, !web.isLoading, web.url.map(isMullo) == true,
                  let id = Reminders.shared.openWaiting else { return }
            Reminders.shared.openWaiting = nil
            web.evaluateJavaScript("location.hash = '#/actions/\(id)'", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard webView.url.map(isMullo) == true else { return }
            handTaps()
            openWaitingTask()
        }

        /// MulloWatch: the watch inbox.
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            guard fromMullo(message), let body = message.body as? [String: Any], let op = body["op"] as? String else {
                replyHandler(nil, "refused")
                return
            }
            if message.name == "mulloStore" {
                let store = Store.shared
                switch op {
                case "product": Task { replyHandler(await store.productInfo(), nil) }
                case "buy": Task { replyHandler(await store.buy(userId: body["userId"] as? String ?? ""), nil) }
                case "current": Task { replyHandler(await store.current(), nil) }
                case "restore": Task { replyHandler(await store.restore(), nil) }
                case "manage": store.manage(); replyHandler(true, nil)
                default: replyHandler(nil, "unknown")
                }
                return
            }
            if message.name == "mulloSignIn" {
                let nonce = body["nonce"] as? String ?? ""
                let reply = { (json: String) in replyHandler(json, nil) }
                switch op {
                case "google": SignIn.shared.google(nonceHash: nonce, done: reply)
                case "apple": SignIn.shared.apple(nonceHash: nonce, done: reply)
                case "apple-code": SignIn.shared.appleCode(done: reply)
                default: replyHandler(nil, "unknown")
                }
                return
            }
            if message.name == "mulloRecorder" {
                let rec = NativeRecorder.shared
                switch op {
                case "start": rec.start { error in replyHandler(error == nil ? true : nil, error) }
                case "poll": replyHandler(rec.poll(), nil)
                case "pause": rec.pause(); replyHandler(true, nil)
                case "resume": rec.resume(); replyHandler(true, nil)
                case "stop": Task { @MainActor in replyHandler(await rec.stop(), nil) }
                default: replyHandler(nil, "unknown")
                }
                return
            }
            let inbox = WatchInbox.shared
            let id = body["id"] as? String ?? ""
            switch op {
            case "list":
                replyHandler(inbox.listJSON(), nil)
            case "done":
                inbox.done(id)
                replyHandler(true, nil)
            case "audio":
                DispatchQueue.global(qos: .userInitiated).async {
                    let b64 = inbox.audioBase64(id)
                    DispatchQueue.main.async { replyHandler(b64, nil) }
                }
            default:
                replyHandler(nil, "unknown")
            }
        }

        // MARK: microphone

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            // iOS still asks once (NSMicrophoneUsageDescription); this stops WebKit asking again each launch.
            decisionHandler(origin.host == mulloHost && type == .microphone ? .grant : .deny)
        }

        // MARK: navigation

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if isMullo(url) || ["about", "blob", "data"].contains(url.scheme ?? "") {
                decisionHandler(.allow)
                return
            }
            // Docs, Stripe, WhatsApp, mail: outside Mullo, so there's always a way back.
            openOutside(url)
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
        }

        /// window.open / target=_blank.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { openOutside(url) }
            return nil
        }

        private func openOutside(_ url: URL) {
            guard ["https", "http", "mailto", "tel", "sms"].contains(url.scheme?.lowercased() ?? "") else { return }
            // Settings falls back to location.assign when window.open gives nothing: open once.
            if let last = lastOutside, last.url == url, Date().timeIntervalSince(last.at) < 2 { return }
            lastOutside = (url, Date())
            UIApplication.shared.open(url)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // Only a real network failure. A link sent outside or a download also ends here
            // (cancelled / "interrupted by policy change") and must leave Mullo on screen.
            let e = error as NSError
            guard e.domain == NSURLErrorDomain, e.code != NSURLErrorCancelled else { return }
            let html = """
            <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
            <body style="background:#101418;color:#eef2f6;font:17px -apple-system,system-ui;padding:80px 24px;text-align:center">
            <p>Mullo can't reach its server right now.</p>
            <p><a style="color:#ff4d5e" href="\(mulloAppURL.absoluteString)">Try again</a></p></body>
            """
            webView.loadHTMLString(html, baseURL: nil)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: mulloAppURL))
        }

        // MARK: downloads (a task's .ics, exports) → the share sheet

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                      completionHandler: @escaping (URL?) -> Void) {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(suggestedFilename.isEmpty ? "mullo-file" : suggestedFilename)
            downloads[ObjectIdentifier(download)] = url
            completionHandler(url)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)), let web else { return }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = web
            web.window?.rootViewController?.present(sheet, animated: true)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloads.removeValue(forKey: ObjectIdentifier(download))
        }
    }
}
