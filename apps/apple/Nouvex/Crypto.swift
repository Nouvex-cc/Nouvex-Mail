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

    /// A new key pair, with the private half wrapped for the server to keep.
    static func newKeys(_ encKey: SymmetricKey) throws -> (key: Curve25519.KeyAgreement.PrivateKey, wrapped: Data) {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return (key, try encrypt(encKey, privateLabel, key.rawRepresentation))
    }

    static func openPrivate(_ encKey: SymmetricKey, _ wrapped: Data) throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: decrypt(encKey, privateLabel, wrapped))
    }

    /// Opens a message's key, sealed by the engine: the encapsulated key, then the sealed message key.
    static func openKey(_ key: Curve25519.KeyAgreement.PrivateKey, _ sealed: Data) throws -> SymmetricKey {
        var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: suite, info: info, encapsulatedKey: sealed.prefix(32))
        return SymmetricKey(data: try recipient.open(sealed.dropFirst(32)))
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
