// SPDX-License-Identifier: AGPL-3.0-only
import CryptoKit
import UserNotifications

/// Puts sender and subject into a push for new mail. The push carries them sealed; the key that opens them is in the
/// keychain this extension shares with the app. Without it the push says "New mail" and the account.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler done: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return done(request.content) }
        // The app's bundle id, the service its key is kept under.
        let app = (Bundle.main.bundleIdentifier ?? "").replacingOccurrences(of: ".notify", with: "")
        if let raw = Sealed.load(service: app),
           let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw),
           let notice = Sealed.notice(request.content.userInfo, key: key) {
            if !notice.sender.isEmpty { content.title = notice.sender }
            content.body = notice.subject
        }
        done(content)
    }
}
