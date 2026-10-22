// SPDX-License-Identifier: AGPL-3.0-only
import AuthenticationServices

/// Passkeys through BetterAuth's passkey plugin: it hands out WebAuthn options with base64url fields, the system asks
/// for Touch ID or Face ID, and the answer goes back in the shape @simplewebauthn expects.
@MainActor final class Passkeys: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    /// The only domain this app is associated with (Nouvex.entitlements); a server elsewhere needs its own build.
    static let domain = "mail.nouvex.cc"

    static func available(on server: URL?) -> Bool { server?.host() == domain }

    static func signIn() async throws {
        let options = try await API.auth("passkey/generate-authenticate-options", nil)
        guard let challenge = (options["challenge"] as? String).flatMap(Data.init(base64URL:)) else { throw unexpected }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options["rpId"] as? String ?? domain)
        guard let c = try await Passkeys().perform(provider.createCredentialAssertionRequest(challenge: challenge))
            as? ASAuthorizationPlatformPublicKeyCredentialAssertion
        else { throw unexpected }
        try await API.auth("passkey/verify-authentication", ["response": answer(c.credentialID, [
            "clientDataJSON": c.rawClientDataJSON.base64URL,
            "authenticatorData": c.rawAuthenticatorData.base64URL,
            "signature": c.signature.base64URL,
            "userHandle": c.userID.base64URL,
        ])])
    }

    static func add(name: String) async throws {
        let options = try await API.auth("passkey/generate-register-options", nil)
        let rp = options["rp"] as? [String: Any]
        let user = options["user"] as? [String: Any]
        guard let challenge = (options["challenge"] as? String).flatMap(Data.init(base64URL:)),
              let id = (user?["id"] as? String).flatMap(Data.init(base64URL:))
        else { throw unexpected }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp?["id"] as? String ?? domain)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: user?["name"] as? String ?? "", userID: id)
        guard let c = try await Passkeys().perform(request) as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
              let attestation = c.rawAttestationObject
        else { throw unexpected }
        try await API.auth("passkey/verify-registration", ["name": name, "response": answer(c.credentialID, [
            "clientDataJSON": c.rawClientDataJSON.base64URL,
            "attestationObject": attestation.base64URL,
            "transports": ["internal", "hybrid"],
        ])])
    }

    /// Cancelling the system sheet isn't worth a message.
    static func cancelled(_ error: Error) -> Bool { (error as? ASAuthorizationError)?.code == .canceled }

    private static let unexpected = AuthError(errorDescription: "The server sent something unexpected.")

    private static func answer(_ id: Data, _ response: [String: Any]) -> [String: Any] {
        [
            "id": id.base64URL, "rawId": id.base64URL, "type": "public-key", "authenticatorAttachment": "platform",
            "clientExtensionResults": [String: Any](), "response": response,
        ]
    }

    private var done: CheckedContinuation<ASAuthorizationCredential, Error>?

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorizationCredential {
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        // The controller holds its delegate weakly; this call keeps self alive until the answer is in.
        return try await withCheckedThrowingContinuation { done in
            self.done = done
            controller.performRequests()
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        done?.resume(returning: authorization.credential)
        done = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        done?.resume(throwing: error)
        done = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        #else
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.compactMap(\.keyWindow).first ?? ASPresentationAnchor(windowScene: scenes[0])
        #endif
    }
}
