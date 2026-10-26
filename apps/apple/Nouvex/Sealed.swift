// SPDX-License-Identifier: AGPL-3.0-only
import CryptoKit
import Foundation
import Security

/// What the app shares with its notification extension: the private key in the keychain, and opening the sealed
/// sender and subject a push carries (apps/api/src/push.ts).
enum Sealed {
    #if os(iOS)
    /// A keychain group of the app and the extension; the service, the app's bundle id, keeps the dev build's key apart.
    static let group = "SQR8LP4972.cc.nouvex.Nouvex.shared"
    #endif

    static func item(service: String) -> [String: Any] {
        var item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "private key",
            kSecUseDataProtectionKeychain as String: true,
        ]
        #if os(iOS)
        item[kSecAttrAccessGroup as String] = group
        #endif
        return item
    }

    static func load(service: String) -> Data? {
        var query = item(service: service)
        query[kSecReturnData as String] = true
        var found: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess ? found as? Data : nil
    }

    /// A push's sender and subject, or nil if they don't open: an old key, or a push without them.
    static func notice(_ push: [AnyHashable: Any], key: Curve25519.KeyAgreement.PrivateKey) -> (sender: String, subject: String)? {
        struct Meta: Decodable { let fromName, fromAddr, subject: String? }
        guard let m = push["m"] as? [String: Any],
              let wrapped = (m["key"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let sealed = (m["sealed"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let plain = try? Crypto.decrypt(Crypto.openKey(key, wrapped), "meta", sealed),
              let meta = try? JSONDecoder().decode(Meta.self, from: plain)
        else { return nil }
        let name = meta.fromName ?? ""
        return (name.isEmpty ? meta.fromAddr ?? "" : name, meta.subject ?? "")
    }
}
