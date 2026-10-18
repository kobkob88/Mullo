import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// "Continue with Google" / "Continue with Apple" on the iPhone (S22b). Both end in an ID token
/// the web code trades for a Mullo session (`signInWithIdToken`, app/core/account.js), like
/// Android's GoogleSignIn.kt. The web code makes a one-time value and passes in its SHA-256
/// (`nonceHash`); the provider puts that in the token and Supabase checks it against the raw
/// value, so a token can't be replayed. Nothing here is kept: no token is stored natively.
///
/// Google refuses an app's web view, so it opens in Apple's sign-in sheet
/// (ASWebAuthenticationSession, Safari's cookies) with the iPhone OAuth client and PKCE; no
/// Google SDK (the app has no dependencies). Apple uses its own native sheet.
@MainActor
final class SignIn: NSObject {
    static let shared = SignIn()

    /// Mullo's iPhone OAuth client in its own Google Cloud project (public, like the Web client id
    /// in GoogleSignIn.kt). Its id is in Supabase's Google "Client IDs", or Supabase refuses the token.
    private static let googleClient = "YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com"
    private static let googleScheme = "com.googleusercontent.apps.YOUR-GOOGLE-CLIENT-ID"
    private static var googleRedirect: String { "\(googleScheme):/oauth2redirect" }

    private var session: ASWebAuthenticationSession?
    private var appleDone: ((String) -> Void)?
    private var appleWantsCode = false

    private static func answer(_ fields: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }
    private static func failed(_ message: String, cancelled: Bool = false) -> String {
        answer(["error": message, "cancelled": cancelled])
    }
    private static func validNonce(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { "0123456789abcdef".contains($0) }
    }
    private static func random() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URL
    }

    // MARK: Google

    /// → `{ idToken }` or `{ error, cancelled }`, as a JSON string (the `mullo-google` answer).
    func google(nonceHash: String, done: @escaping (String) -> Void) {
        guard Self.validNonce(nonceHash) else { return done(Self.failed("Bad sign-in request.")) }
        let verifier = Self.random()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = Self.random()
        var auth = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        auth.queryItems = [
            .init(name: "client_id", value: Self.googleClient),
            .init(name: "redirect_uri", value: Self.googleRedirect),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: "openid email profile"),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "nonce", value: nonceHash),
            .init(name: "state", value: state),
            .init(name: "prompt", value: "select_account"),
        ]
        let session = ASWebAuthenticationSession(url: auth.url!, callbackURLScheme: Self.googleScheme) { [weak self] url, error in
            Task { @MainActor in
                self?.session = nil
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    return done(Self.failed("Cancelled", cancelled: true))
                }
                let items = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
                let value = { (name: String) in items.first { $0.name == name }?.value }
                guard value("state") == state, let code = value("code") else {
                    return done(Self.failed(value("error") == "access_denied" ? "Cancelled" : "Google sign-in didn't work.",
                                            cancelled: value("error") == "access_denied"))
                }
                done(await Self.googleToken(code: code, verifier: verifier))
            }
        }
        session.presentationContextProvider = self
        self.session = session
        if !session.start() { self.session = nil; done(Self.failed("Google sign-in didn't open.")) }
    }

    /// The code → Google's ID token (an installed app: PKCE, no client secret).
    private static func googleToken(code: String, verifier: String) async -> String {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            .init(name: "code", value: code), .init(name: "client_id", value: googleClient),
            .init(name: "code_verifier", value: verifier), .init(name: "redirect_uri", value: googleRedirect),
            .init(name: "grant_type", value: "authorization_code"),
        ]
        req.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let token = body?["id_token"] as? String { return answer(["idToken": token]) }
            return failed("Google sign-in didn't work.")
        } catch {
            return failed("No connection. Try again when you have signal.")
        }
    }

    // MARK: Apple

    /// → `{ idToken }` or `{ error, cancelled }`, as a JSON string.
    func apple(nonceHash: String, done: @escaping (String) -> Void) {
        guard Self.validNonce(nonceHash) else { return done(Self.failed("Bad sign-in request.")) }
        askApple(wantsCode: false, nonceHash: nonceHash, done: done)
    }

    /// At "Delete account": Apple confirms and gives a fresh one-time code (no token), which Mullo's
    /// server trades and revokes (worker/src/apple.mjs). → `{ code }` or `{ error, cancelled }`.
    func appleCode(done: @escaping (String) -> Void) {
        askApple(wantsCode: true, nonceHash: nil, done: done)
    }

    private func askApple(wantsCode: Bool, nonceHash: String?, done: @escaping (String) -> Void) {
        appleDone?(Self.failed("Cancelled", cancelled: true))
        appleDone = done
        appleWantsCode = wantsCode
        let request = ASAuthorizationAppleIDProvider().createRequest()
        if !wantsCode { request.requestedScopes = [.email, .fullName] }
        request.nonce = nonceHash
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    private func finishApple(_ json: String) {
        let done = appleDone
        appleDone = nil
        done?(json)
    }
}

extension SignIn: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        let credential = authorization.credential as? ASAuthorizationAppleIDCredential
        let token = credential?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
        let code = credential?.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        Task { @MainActor in
            if appleWantsCode {
                finishApple(code.map { Self.answer(["code": $0]) } ?? Self.failed("Apple didn't answer."))
            } else {
                finishApple(token.map { Self.answer(["idToken": $0]) } ?? Self.failed("Apple sign-in didn't work."))
            }
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        Task { @MainActor in
            finishApple(Self.failed(cancelled ? "Cancelled" : "Apple sign-in didn't work.", cancelled: cancelled))
        }
    }
}

extension SignIn: ASWebAuthenticationPresentationContextProviding, ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { Self.window() }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { Self.window() }
    }

    private static func window() -> UIWindow {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first.map { UIWindow(windowScene: $0) } ?? UIWindow()
    }
}

private extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
