// SPDX-License-Identifier: AGPL-3.0-only
import OpenAPIRuntime
import SwiftUI
import WebKit

/// A rich mail's designed version (docs/rich-mail.md) over the whole reading area. The mail runs no script; the
/// components come to life through packages/rich/runtime.js in a content world of its own, which asks the app for
/// forms and actions.
struct RichMail: View {
    let message: Message
    @Environment(Mail.self) private var mail
    @Environment(\.colorScheme) private var scheme
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #endif
    @State private var html: String?
    @State private var rules: WKContentRuleList?
    @State private var failed = false
    @State private var pictures = false
    @State private var asking: Asking?

    struct Asking: Identifiable {
        let id: Int
        let action: URL
        let fields: [String: Any]
        let answer: (Bool) -> Void
    }

    var body: some View {
        Group {
            if let html, let rules {
                let page = Frame(html: html)
                let shown = pictures || mail.prefs.remoteImages != "ask"
                RichWebView(
                    html: #"<meta name="viewport" content="width=device-width, initial-scale=1">"# + (shown ? Frame.proxied(html) : html),
                    dark: scheme == .dark, rules: rules, write: write, ask: ask, act: act
                )
                .overlay(alignment: .top) {
                    if !shown && page.remote {
                        Button("Remote images hidden · Show") { pictures = true }
                            .font(.xs).foregroundStyle(.muted)
                            .padding(.horizontal, 10).frame(height: 24)
                            .background(.hover, in: .capsule)
                            .buttonStyle(.plain).padding(8)
                    }
                }
            } else if failed {
                Text("This message couldn't be loaded. It shows once the server is reachable again.").font(.md).foregroundStyle(.muted).padding()
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            rules = await Frame.rules()
            html = await Html.rich(message)
            failed = html == nil
        }
        .confirmationDialog(
            "Send your answer?",
            isPresented: Binding(get: { asking != nil }, set: { if !$0 { settle(false) } }),
            presenting: asking
        ) { _ in
            Button("Send") { settle(true) }
            Button("Cancel", role: .cancel) { settle(false) }
        } message: { a in
            Text("It goes to \(a.action.host() ?? ""), sent from Nouvex, so they don't see your address.")
        }
    }

    private func write(_ url: URL) {
        mail.write(Draft.mailto(url, accountId: message.accountId))
    }

    private func ask(_ a: Asking) { asking = a }

    private func settle(_ send: Bool) {
        guard let a = asking else { return }
        asking = nil
        guard send else { return a.answer(false) }
        let fields = a.fields.compactMapValues { value -> Operations.submitRichForm.Input.Body.jsonPayload.fieldsPayload.additionalPropertiesPayload? in
            if let s = value as? String { return .init(value1: s) }
            if let list = value as? [String] { return .init(value2: list) }
            return nil
        }
        Task {
            let body = Operations.submitRichForm.Input.Body.jsonPayload(action: a.action.absoluteString, fields: .init(additionalProperties: fields))
            let res = try? await API.client.submitRichForm(body: .json(body))
            if case .noContent = res { a.answer(true) } else { a.answer(false) }
        }
    }

    // Only mail Nouvex put into the inbox itself may open places in the app.
    private func act(_ href: String) {
        guard message.seeded, href == "nouvex:settings/order" else { return }
        mail.settings = .order
        #if os(macOS)
        openSettings()
        #else
        mail.settingsOpen = true
        #endif
    }
}

struct RichWebView: ViewRepresentable {
    let html: String
    /// A mail's dark CSS (prefers-color-scheme) follows the view's appearance.
    let dark: Bool
    let rules: WKContentRuleList
    let write: (URL) -> Void
    let ask: (RichMail.Asking) -> Void
    let act: (String) -> Void

    private static let world = WKContentWorld.world(name: "rich")
    private static let runtime = WKUserScript(
        source: (try? String(contentsOf: Bundle.main.url(forResource: "RichRuntime", withExtension: "js")!, encoding: .utf8)) ?? "",
        injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world
    )

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var html = ""
        var parent: RichWebView
        weak var view: WKWebView?

        init(_ parent: RichWebView) { self.parent = parent }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            await follow(action, write: parent.write)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let m = message.body as? [String: Any], let id = m["id"] as? Int else { return }
            switch m["type"] as? String {
            case "action": if let href = m["href"] as? String { parent.act(href) }
            case "form":
                guard let action = (m["action"] as? String).flatMap(URL.init(string:)), action.scheme == "https" else { return answer(id, false) }
                parent.ask(.init(id: id, action: action, fields: m["fields"] as? [String: Any] ?? [:]) { [weak self] ok in self?.answer(id, ok) })
            default: break
            }
        }

        private func answer(_ id: Int, _ ok: Bool) {
            Task { @MainActor in _ = try? await view?.evaluateJavaScript("nxAnswer(\(id), \(ok))", contentWorld: RichWebView.world) }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    private func make(_ context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        // The mail's own scripts stay off; the runtime runs in its own world, which this doesn't touch.
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.setURLSchemeHandler(ImageProxy(), forURLScheme: "nouvex-image")
        config.userContentController.add(rules)
        config.userContentController.addUserScript(Self.runtime)
        config.userContentController.add(context.coordinator, contentWorld: Self.world, name: "rich")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.allowsLinkPreview = false
        context.coordinator.view = view
        #if os(macOS)
        view.setValue(false, forKey: "drawsBackground")
        #else
        view.isOpaque = false
        view.backgroundColor = .clear
        #endif
        return view
    }

    private func update(_ view: WKWebView, _ context: Context) {
        context.coordinator.parent = self
        #if os(macOS)
        view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        #else
        view.overrideUserInterfaceStyle = dark ? .dark : .light
        #endif
        guard context.coordinator.html != html else { return }
        context.coordinator.html = html
        view.loadHTMLString(html, baseURL: nil)
    }

    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { make(context) }
    func updateNSView(_ view: WKWebView, context: Context) { update(view, context) }
    #else
    func makeUIView(context: Context) -> WKWebView { make(context) }
    func updateUIView(_ view: WKWebView, context: Context) { update(view, context) }
    #endif
}
