// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI
import WebKit

/// A message's body at its full height, so a conversation scrolls as one page.
struct MailBody: View {
    let message: Message
    @Environment(Mail.self) private var mail
    @Environment(\.colorScheme) private var scheme
    @State private var html: String?
    @State private var rules: WKContentRuleList?
    @State private var failed = false
    @State private var height: CGFloat = 40

    var body: some View {
        Group {
            if let html, let rules {
                WebView(html: Frame.page(html, dark: scheme == .dark), rules: rules, height: $height) { url in
                    // A mailto link is written here, not handed to another mail app.
                    let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
                    let subject = parts?.queryItems?.first { $0.name.lowercased() == "subject" }?.value ?? ""
                    mail.compose = Draft(accountId: message.accountId, to: [parts?.path ?? ""].filter { !$0.isEmpty }, subject: subject)
                }
                .frame(height: height)
            } else if failed {
                Text("This message couldn't be loaded. It shows once the server is reachable again.").font(.md).foregroundStyle(.muted)
            } else {
                Color.clear.frame(height: height)
            }
        }
        .task {
            rules = await Frame.rules()
            guard rules != nil else { return failed = true }
            html = await Html.load(message)
            failed = html == nil
        }
    }
}

// Mail is the sender's markup: it runs without JavaScript, can't load anything itself, and its remote images come
// through the server's image proxy, so the sender never sees the reader's address.
enum Frame {
    @MainActor private static var compiled: WKContentRuleList?

    @MainActor static func rules() async -> WKContentRuleList? {
        if let compiled { return compiled }
        // Content blocker patterns can't do alternation, so one rule per scheme.
        let block = "[" + ["https?:", "wss?:", "ftp:", "file:"].map {
            #"{"trigger":{"url-filter":"^\#($0)"},"action":{"type":"block"}}"#
        }.joined(separator: ",") + "]"
        compiled = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "mail", encodedContentRuleList: block)
        return compiled
    }

    // In dark mode, a mail with its own dark design uses it; any other is turned dark the way Apple Mail does it.
    private static let flip = "invert(1) hue-rotate(180deg)"
    // paper and ink from the tokens (Assets.xcassets/Tokens).
    // The frame is see-through, so a mail without its own background sits right on the paper.
    private static let light = ":root { color-scheme: light; } html { color: #181513; }"
    private static let own = ":root { color-scheme: dark; } html { color: #edebe8; }"
    private static let flipped = """
        :root { color-scheme: light; }
        body { color: #181513; filter: \(flip) contrast(0.82); }
        img, picture, video, canvas, svg, [style*="background-image"], [background] { filter: \(flip); }
        """

    static func page(_ html: String, dark: Bool) -> String {
        let look = !dark ? light : html.contains(/(?i)prefers-color-scheme\s*:\s*dark|color-scheme\s*:[^;"'}]*\bdark/) ? own : flipped
        return #"<meta name="viewport" content="width=device-width, initial-scale=1">"#
            + "<style>\(look) body { margin: 0; font: 16px/1.6 -apple-system, system-ui; overflow-wrap: anywhere; }</style>"
            + proxied(html)
    }

    static func proxied(_ html: String) -> String {
        html.replacing(/(?i)(src|background)(\s*=\s*)(["'])(https?:\/\/[^"']+)\3/) { m in
            "\(m.1)\(m.2)\(m.3)\(image(m.4))\(m.3)"
        }
        .replacing(/(?i)url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/) { m in
            "url(\(m.1)\(image(m.2))\(m.1))"
        }
    }

    private static func image(_ url: Substring) -> String {
        let raw = url.replacingOccurrences(of: "&amp;", with: "&")
        return "nouvex-image://proxy?url=" + (raw.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")
    }
}

@MainActor final class ImageProxy: NSObject, WKURLSchemeHandler {
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url,
              let remote = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "url" })?.value,
              var proxy = URLComponents(url: Server.url.appending(path: "image"), resolvingAgainstBaseURL: false)
        else { return task.didFailWithError(URLError(.badURL)) }
        proxy.queryItems = [URLQueryItem(name: "url", value: remote)]
        Task {
            let res = try? await URLSession.shared.data(from: proxy.url!)
            guard stopped.remove(ObjectIdentifier(task)) == nil else { return }
            guard let (data, response) = res, (response as? HTTPURLResponse)?.statusCode == 200 else {
                return task.didFailWithError(URLError(.resourceUnavailable))
            }
            task.didReceive(URLResponse(url: url, mimeType: response.mimeType, expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data)
            task.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }
}

#if os(macOS)
typealias ViewRepresentable = NSViewRepresentable
#else
typealias ViewRepresentable = UIViewRepresentable
#endif

#if os(macOS)
// Scrolling belongs to the conversation around it, not to each message.
final class MailWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
}
#else
typealias MailWebView = WKWebView
#endif

struct WebView: ViewRepresentable {
    let html: String
    let rules: WKContentRuleList
    @Binding var height: CGFloat
    let write: (URL) -> Void

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var html = ""
        var height: Binding<CGFloat>
        let write: (URL) -> Void

        init(height: Binding<CGFloat>, write: @escaping (URL) -> Void) {
            self.height = height
            self.write = write
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if let value = message.body as? Double, value > 0 { height.wrappedValue = value }
        }

        // Links open in the browser; the mail itself never navigates.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard action.navigationType == .other, action.request.url?.absoluteString == "about:blank" else {
                if action.navigationType == .linkActivated, let url = action.request.url, url.scheme == "mailto" {
                    await MainActor.run { write(url) }
                } else if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https"].contains(url.scheme) {
                    #if os(macOS)
                    NSWorkspace.shared.open(url)
                    #else
                    await UIApplication.shared.open(url)
                    #endif
                }
                return .cancel
            }
            return .allow
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(height: $height, write: write) }

    // Runs apart from the mail's own scripts, which stay off: it shrinks a mail wider than the screen to fit, the way
    // Apple Mail does, and reports how tall it is.
    private static let measure = WKUserScript(
        source: """
            new ResizeObserver(() => {
                const body = document.body
                body.style.zoom = 1
                const wide = document.documentElement.scrollWidth
                if (wide > innerWidth) body.style.zoom = innerWidth / wide
                webkit.messageHandlers.height.postMessage(document.documentElement.scrollHeight)
            }).observe(document.body)
            """,
        injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient
    )

    private func make(_ context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.setURLSchemeHandler(ImageProxy(), forURLScheme: "nouvex-image")
        config.userContentController.add(rules)
        config.userContentController.addUserScript(Self.measure)
        config.userContentController.add(context.coordinator, contentWorld: .defaultClient, name: "height")
        let view = MailWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        // A preview would load the link outside the blocker and the proxy.
        view.allowsLinkPreview = false
        #if os(macOS)
        view.setValue(false, forKey: "drawsBackground")
        #else
        view.isOpaque = false
        view.backgroundColor = .clear
        #endif
        #if os(iOS)
        view.scrollView.isScrollEnabled = false
        #endif
        return view
    }

    private func update(_ view: WKWebView, _ context: Context) {
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
