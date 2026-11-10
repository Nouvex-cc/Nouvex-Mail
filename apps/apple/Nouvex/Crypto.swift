// SPDX-License-Identifier: AGPL-3.0-only
import CommonCrypto
import CryptoKit
import Foundation

/// The client half of mail encrypted for its owner, the same format as engine/internal/seal and
/// packages/sdk/src/crypto.ts. The password stays on the device: it turns into authKey, the only thing the server
/// sees, and encKey, which wraps the private key. Each message has its own key, sealed to the public key with HPKE.
enum Crypto {
    static let privateLabel = "nouvex private key"
    private static let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_256)
    private static let info = Data("nouvex message key".utf8)
    /// What a hosted account's private key is wrapped under for each member (account_member).
    private static let accountInfo = Data("nouvex account key".utf8)

    /// authKey goes to the server as the password, encKey stays here.
    static func derive(password: String, email: String) -> (authKey: String, encKey: SymmetricKey) {
        let salt = Data("nouvex/\(email.lowercased())".utf8)
        var master = [UInt8](repeating: 0, count: 32)
        let pw = Array(password.utf8)
        _ = salt.withUnsafeBytes { s in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2), password, pw.count, s.bindMemory(to: UInt8.self).baseAddress, salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 600_000, &master, master.count
            )
        }
        let part = { (label: String) in
            HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: master), info: Data(label.utf8), outputByteCount: 32)
        }
        let auth = part("nouvex auth").withUnsafeBytes { Data($0) }
        return (auth.base64URL, part("nouvex enc"))
    }

    /// AES-256-GCM with the nonce in front; the label is the associated data, as in the engine.
    static func encrypt(_ key: SymmetricKey, _ label: String, _ plain: Data) throws -> Data {
        try AES.GCM.seal(plain, using: key, authenticating: Data(label.utf8)).combined!
    }

    static func decrypt(_ key: SymmetricKey, _ label: String, _ sealed: Data) throws -> Data {
        try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: Data(label.utf8))
    }

    static func openPrivate(_ encKey: SymmetricKey, _ wrapped: Data) throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: decrypt(encKey, privateLabel, wrapped))
    }

    /// Opens a message's key, sealed by the engine: the encapsulated key, then the sealed message key.
    static func openKey(_ key: Curve25519.KeyAgreement.PrivateKey, _ sealed: Data) throws -> SymmetricKey {
        SymmetricKey(data: try open(key, sealed, info: info))
    }

    /// A hosted account's private key, from what was wrapped for this user.
    static func openAccount(_ mine: Curve25519.KeyAgreement.PrivateKey, _ wrapped: Data) throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: open(mine, wrapped, info: accountInfo))
    }

    /// A new key pair for a hosted account: its mail is sealed to publicKey, and wrapped is the private half sealed to
    /// the owner, the same as packages/sdk newAccountKey.
    static func newAccountKey(owner: Curve25519.KeyAgreement.PublicKey) throws -> (publicKey: Data, wrapped: Data) {
        let pair = Curve25519.KeyAgreement.PrivateKey()
        var sender = try HPKE.Sender(recipientKey: owner, ciphersuite: suite, info: accountInfo)
        let sealed = try sender.seal(pair.rawRepresentation)
        return (pair.publicKey.rawRepresentation, sender.encapsulatedKey + sealed)
    }

    private static func open(_ key: Curve25519.KeyAgreement.PrivateKey, _ sealed: Data, info: Data) throws -> Data {
        var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: suite, info: info, encapsulatedKey: sealed.prefix(32))
        return try recipient.open(sealed.dropFirst(32))
    }
}

extension Data {
    init?(base64URL: String) {
        var s = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        self.init(base64Encoded: s)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .trimmingCharacters(in: ["="])
    }
}
