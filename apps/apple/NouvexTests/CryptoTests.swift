// SPDX-License-Identifier: AGPL-3.0-only
import CryptoKit
import Foundation
import Testing

/// Sealed by the engine (engine/internal/seal), so this checks the two sides agree.
struct CryptoTests {
    struct Fixture: Decodable {
        let password, email, authKey, publicKey, wrappedPrivate, messageKey, meta, plain: String
    }

    let fixture = try! JSONDecoder().decode(
        Fixture.self,
        from: Data(contentsOf: URL(filePath: #filePath).appending(path: "../../../../packages/sdk/src/crypto.fixture.json").standardized)
    )

    @Test func opensWhatTheEngineSealed() throws {
        let (authKey, encKey) = Crypto.derive(password: fixture.password, email: fixture.email)
        #expect(authKey == fixture.authKey)
        let key = try Crypto.openPrivate(encKey, Data(base64Encoded: fixture.wrappedPrivate)!)
        #expect(key.publicKey.rawRepresentation == Data(base64Encoded: fixture.publicKey))
        let messageKey = try Crypto.openKey(key, Data(base64Encoded: fixture.messageKey)!)
        let meta = try Crypto.decrypt(messageKey, "meta", Data(base64Encoded: fixture.meta)!)
        #expect(String(decoding: meta, as: UTF8.self) == fixture.plain)
        #expect(throws: (any Error).self) { try Crypto.decrypt(messageKey, "body", Data(base64Encoded: fixture.meta)!) }
    }
}
