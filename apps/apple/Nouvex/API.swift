// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// The server the app talks to, picked when signing in.
enum Server {
    static var url: URL {
        get { UserDefaults.standard.url(forKey: "server") ?? fallback }
        set { UserDefaults.standard.set(newValue, forKey: "server") }
    }

    #if DEBUG
    private static let fallback = URL(string: "http://localhost:3000")!
    #else
    private static let fallback = URL(string: "https://mail.nouvex.cc")!
    #endif
}

// The API writes dates with milliseconds, meetings the engine found come without.
struct ISODates: DateTranscoder {
    func encode(_ date: Date) throws -> String { date.ISO8601Format() }
    func decode(_ string: String) throws -> Date {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string) { return date }
        return try Date.ISO8601FormatStyle().parse(string)
    }
}

struct SignedOut: Error {}

struct AuthError: LocalizedError {
    var errorDescription: String?
}

enum API {
    // URLSession.shared keeps the session cookie between launches.
    static var client: Client {
        Client(serverURL: Server.url, configuration: .init(dateTranscoder: ISODates()), transport: URLSessionTransport())
    }

    /// Returns true when the account asks for a two-factor code next.
    static func signIn(email: String, password: String) async throws -> Bool {
        try await auth("sign-in/email", ["email": email, "password": password])["twoFactorRedirect"] as? Bool == true
    }

    static func verify(code: String) async throws {
        try await auth("two-factor/verify-totp", ["code": code])
    }

    /// The signed-in user's name and address.
    static func me() async -> (name: String, email: String)? {
        guard let user = try? await auth("get-session", nil)["user"] as? [String: Any] else { return nil }
        return (user["name"] as? String ?? "", user["email"] as? String ?? "")
    }

    static func signOut() async {
        _ = try? await auth("sign-out", [:])
    }

    /// BetterAuth's own endpoints, which aren't part of the OpenAPI document: a GET without fields, a POST with them.
    @discardableResult
    static func auth(_ path: String, _ fields: [String: Any]?) async throws -> [String: Any] {
        let json = try await authJSON(path, fields)
        return json as? [String: Any] ?? [:]
    }

    static func authList(_ path: String) async throws -> [[String: Any]] {
        try await authJSON(path, nil) as? [[String: Any]] ?? []
    }

    private static func authJSON(_ path: String, _ fields: [String: Any]?) async throws -> Any? {
        var req = URLRequest(url: Server.url.appending(path: "api/auth/\(path)"))
        if let fields {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: fields)
        }
        // With a session cookie around, BetterAuth turns away requests without an origin it trusts; the server's own is.
        req.setValue(URL(string: "/", relativeTo: Server.url)!.absoluteString.trimmingCharacters(in: ["/"]), forHTTPHeaderField: "origin")
        // Kept with the session, so Settings › Security can tell this app from a browser.
        req.setValue("Nouvex Mail (\(Device.platform))", forHTTPHeaderField: "user-agent")
        let (body, res) = try await URLSession.shared.data(for: req)
        let json = try? JSONSerialization.jsonObject(with: body)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else {
            throw AuthError(errorDescription: (json as? [String: Any])?["message"] as? String ?? "That didn't work.")
        }
        return json
    }
}
