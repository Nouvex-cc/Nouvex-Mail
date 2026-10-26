// SPDX-License-Identifier: AGPL-3.0-only
import CryptoKit
import Foundation
import Security

/// The user's private key on this device, unlocked with the password and kept until signing out. The password itself
/// never goes to the server: it turns into authKey, which the server takes as the password, and encKey (Crypto.swift).
enum Keys {
    /// 600 000 rounds of PBKDF2 take a moment, so not on the main thread.
    static func derive(_ password: String, _ email: String) async -> (authKey: String, encKey: SymmetricKey) {
        await Task.detached { Crypto.derive(password: password, email: email) }.value
    }

    /// Unlocks this device: the server keeps the private key wrapped, only encKey opens it.
    static func open(_ encKey: SymmetricKey) async throws {
        let key = try Crypto.openPrivate(encKey, try await wrapped())
        try save(key.rawRepresentation)
    }

    static func changePassword(email: String, current: String, new: String) async throws {
        async let old = derive(current, email)
        async let fresh = derive(new, email)
        let (from, to) = await (old, fresh)
        let key = try Crypto.openPrivate(from.encKey, try await wrapped())
        let body = Operations.changePassword.Input.Body.jsonPayload(
            currentPassword: from.authKey, newPassword: to.authKey,
            wrappedPrivate: try Crypto.encrypt(to.encKey, Crypto.privateLabel, key.rawRepresentation).base64EncodedString()
        )
        switch try await API.client.changePassword(body: .json(body)) {
        case .noContent: return
        case .badRequest(let refused): throw AuthError(errorDescription: try refused.body.json.message)
        case .undocumented: throw AuthError(errorDescription: "Couldn't change the password.")
        }
    }

    private static func wrapped() async throws -> Data {
        guard case .ok(let ok) = try await API.client.getKeys(), let data = Data(base64Encoded: try ok.body.json.wrappedPrivate) else {
            throw AuthError(errorDescription: "Couldn't load your keys.")
        }
        return data
    }

    static var stored: Curve25519.KeyAgreement.PrivateKey? {
        load().flatMap { try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) }
    }

    #if DEBUG && os(macOS)
    // Development builds on the Mac are signed ad hoc and get no keychain of their own, so they keep the key with
    // their data.
    private static let file = URL.applicationSupportDirectory.appending(path: "\(Bundle.main.bundleIdentifier ?? "Nouvex")/key")

    private static func save(_ raw: Data) throws {
        guard FileManager.default.createFile(atPath: file.path, contents: raw, attributes: [.posixPermissions: 0o600]) else {
            throw AuthError(errorDescription: "Couldn't keep the key on this device.")
        }
    }

    private static func load() -> Data? { try? Data(contentsOf: file) }
    static func forget() { try? FileManager.default.removeItem(at: file) }
    #else
    private static var item: [String: Any] { Sealed.item(service: Bundle.main.bundleIdentifier ?? "Nouvex") }

    private static func save(_ raw: Data) throws {
        forget()
        var add = item
        add[kSecValueData as String] = raw
        // Not in backups and not on other devices: each one unlocks with the password itself.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw AuthError(errorDescription: "Couldn't keep the key on this device (\(status)).") }
    }

    private static func load() -> Data? { Sealed.load(service: Bundle.main.bundleIdentifier ?? "Nouvex") }

    static func forget() { SecItemDelete(item as CFDictionary) }

    #if os(iOS)
    /// A key kept before the notification extension came sits in the app's own keychain group. It moves to the shared
    /// one once, so nobody has to unlock again.
    static func share() {
        guard load() == nil else { return }
        var old = item
        old[kSecAttrAccessGroup as String] = "SQR8LP4972.\(Bundle.main.bundleIdentifier ?? "")"
        var query = old
        query[kSecReturnData as String] = true
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let raw = found as? Data else { return }
        if (try? save(raw)) != nil { SecItemDelete(old as CFDictionary) }
    }
    #endif
    #endif
}
