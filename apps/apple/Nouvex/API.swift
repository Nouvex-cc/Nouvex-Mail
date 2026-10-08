// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import OpenAPIURLSession

enum API {
    static let client = Client(serverURL: URL(string: "http://localhost:3000")!, transport: URLSessionTransport())

    static func health() async throws -> Bool {
        try await client.getHealth().ok.body.json.ok
    }
}
