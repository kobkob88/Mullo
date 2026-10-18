import Foundation
import StoreKit
import UIKit

/// Mullo Pro through the App Store (S22c): StoreKit 2, behind `MulloStore` in the web code
/// (app/core/native.js, app/domain/store.js). The purchase is made FOR the signed-in Mullo account
/// (appAccountToken = its user id); the web code then hands the transaction id to Mullo's server,
/// which checks it with Apple (worker/src/appstore.mjs). Nothing here unlocks anything by itself.
/// Every answer is a JSON string.
@MainActor
final class Store {
    static let shared = Store()
    static let productId = "app.mullo.pro.monthly"
    private var updates: Task<Void, Never>?

    private static func answer(_ fields: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    /// At launch: renewals, Ask to Buy approvals and purchases finished elsewhere arrive here.
    /// They're finished (Apple stops re-sending them); the web code claims what's paid up from
    /// `current()` at each start.
    func start() {
        updates = Task.detached {
            for await result in Transaction.updates {
                if case .verified(let transaction) = result { await transaction.finish() }
            }
        }
    }

    private func product() async throws -> Product? {
        try await Product.products(for: [Self.productId]).first
    }

    /// → { price, name, description }: the price as the App Store shows it in this country.
    func productInfo() async -> String {
        do {
            guard let product = try await product() else { return Self.answer(["error": "Mullo Pro isn't in the App Store yet."]) }
            return Self.answer(["price": product.displayPrice, "name": product.displayName, "description": product.description])
        } catch {
            return Self.answer(["error": "The App Store didn't answer. Try again."])
        }
    }

    /// The purchase sheet. → { transactionId } | { cancelled } | { pending } | { error }.
    func buy(userId: String) async -> String {
        guard let account = UUID(uuidString: userId) else { return Self.answer(["error": "Sign in first."]) }
        do {
            guard let product = try await product() else { return Self.answer(["error": "Mullo Pro isn't in the App Store yet."]) }
            switch try await product.purchase(options: [.appAccountToken(account)]) {
            case .success(let result):
                guard case .verified(let transaction) = result else { return Self.answer(["error": "The App Store couldn't confirm this purchase."]) }
                await transaction.finish()
                return Self.answer(["transactionId": String(transaction.id)])
            case .userCancelled:
                return Self.answer(["cancelled": true])
            case .pending:
                return Self.answer(["pending": true])
            @unknown default:
                return Self.answer(["error": "The App Store didn't finish the purchase."])
            }
        } catch {
            return Self.answer(["error": "The purchase didn't go through: \(error.localizedDescription)"])
        }
    }

    /// Transactions that are paid up now. → { ids: [...] }.
    func current() async -> String {
        var ids: [String] = []
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result, transaction.productID == Self.productId {
                ids.append(String(transaction.id))
            }
        }
        return Self.answer(["ids": ids])
    }

    /// "Restore Purchases": asks the App Store for this Apple ID's purchases, then as current().
    func restore() async -> String {
        do { try await AppStore.sync() } catch { return Self.answer(["error": "The App Store didn't answer. Try again."]) }
        return await current()
    }

    /// Apple's own Manage Subscriptions sheet.
    func manage() {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        Task { try? await AppStore.showManageSubscriptions(in: scene) }
    }
}
