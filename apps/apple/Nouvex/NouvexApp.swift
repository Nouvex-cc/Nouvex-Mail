// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI

@main
struct NouvexApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var apiUp: Bool?

    var body: some View {
        VStack {
            Text("Nouvex Mail").font(.largeTitle)
            Text(apiUp == true ? "API up" : "API down").foregroundStyle(.secondary)
        }
        .padding()
        .task { apiUp = try? await API.health() }
    }
}
