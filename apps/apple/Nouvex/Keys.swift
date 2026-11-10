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

    /// Where hosted accounts' keys are kept, as the server gives them: wrapped to the user, so they open only with the
    /// user's own key, and mail opens without a connection too.
    static let grantsKey = "accountKeys"

    /// Keeps each hosted account's key versions, newest first.
    static func remember(_ grants: [String: [Data]]) {
        UserDefaults.standard.set(grants.mapValues { $0.map { $0.base64EncodedString() } }, forKey: grantsKey)
    }

    /// Opens a message's key: with its hosted account's keys, the version it was sealed to among them, or else with the
    /// user's own key.
    static func messageKey(accountId: String, key: Data) throws -> SymmetricKey {
        guard let mine = stored else { throw AuthError(errorDescription: "This device is locked.") }
        let wrapped = (UserDefaults.standard.dictionary(forKey: grantsKey)?[accountId] as? [String] ?? []).compactMap { Data(base64Encoded: $0) }
        let own = wrapped.compactMap { try? Crypto.openAccount(mine, $0) }
        // A wrong version fails cleanly, so the next one is tried.
        for k in own.dropLast() { if let opened = try? Crypto.openKey(k, key) { return opened } }
        return try Crypto.openKey(own.last ?? mine, key)
    }

    /// Makes a mailbox Nouvex hosts: its key pair is made here, its private half wrapped for this user only.
    static func createMailbox(email: String, displayName: String) async throws -> String {
        guard let mine = stored else { throw AuthError(errorDescription: "This device is locked.") }
        let made = try Crypto.newAccountKey(owner: mine.publicKey)
        let body = Operations.createHostedAccount.Input.Body.jsonPayload(
            email: email, displayName: displayName, publicKey: made.publicKey.base64EncodedString(), wrappedKey: made.wrapped.base64EncodedString()
        )
        switch try await API.client.createHostedAccount(body: .json(body)) {
        case .created(let created): return try created.body.json.id
        case .unprocessableContent(let refused): throw AuthError(errorDescription: try refused.body.json.error)
        case .undocumented: throw AuthError(errorDescription: "Couldn't create the mailbox.")
        }
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
    private static var service: String { Bundle.main.bundleIdentifier ?? "Nouvex" }
    private static var item: [String: Any] { Sealed.item(service: service) }
    // The same without the shared group: where keys were kept before, and where a build without the group's
    // entitlement keeps them.
    private static var own: [String: Any] {
        var own = item
        own.removeValue(forKey: kSecAttrAccessGroup as String)
        return own
    }

    private static func save(_ raw: Data) throws {
        forget()
        var add = item
        add[kSecValueData as String] = raw
        // Not in backups and not on other devices: each one unlocks with the password itself.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecMissingEntitlement {
            add.removeValue(forKey: kSecAttrAccessGroup as String)
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw AuthError(errorDescription: "Couldn't keep the key on this device (\(status)).") }
    }

    private static func load() -> Data? {
        if let shared = Sealed.load(service: service) { return shared }
        var query = own
        query[kSecReturnData as String] = true
        var found: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess ? found as? Data : nil
    }

    static func forget() {
        SecItemDelete(item as CFDictionary)
        SecItemDelete(own as CFDictionary)
    }

    #if os(iOS)
    /// A key kept before the notification extension came sits in the app's own keychain group. It moves to the shared
    /// one once, so nobody has to unlock again.
    static func share() {
        guard Sealed.load(service: service) == nil, let raw = load() else { return }
        try? save(raw)
    }
    #endif
    #endif
}
