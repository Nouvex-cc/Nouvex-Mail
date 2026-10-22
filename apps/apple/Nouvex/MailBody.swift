// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI
import WebKit

/// A message's body at its full height, so a conversation scrolls as one page. Remote pictures wait for a click when
/// the reader asked for that, quoted history folds behind "•••", and a mail turned dark can be seen as sent.
struct MailBody: View {
    let message: Message
    @Environment(Mail.self) private var mail
    @Environment(\.colorScheme) private var scheme
    @State private var html: String?
    @State private var rules: WKContentRuleList?
    @State private var failed = false
    @State private var height: CGFloat = 40
    @State private var pictures = false
    @State private var quote = false
    @State private var original = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let html, let rules {
                let page = Frame(html: html)
                let hidden = !pictures && mail.prefs.remoteImages == "ask" && page.remote
                if hidden || scheme == .dark {
                    HStack(spacing: 6) {
                        if hidden { pill("Remote images hidden · Show") { pictures = true } }
                        if scheme == .dark { pill(original ? "Original colors · Show dark" : "Dark colors · Show original") { original.toggle() } }
                    }
                }
                WebView(
                    html: page.render(dark: scheme == .dark && !original, pictures: !hidden, quote: quote),
                    rules: rules, height: $height
                ) { url in
                    // A mailto link is written here, not handed to another mail app.
                    let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
                    let subject = parts?.queryItems?.first { $0.name.lowercased() == "subject" }?.value ?? ""
                    mail.compose = Draft(accountId: message.accountId, to: [parts?.path ?? ""].filter { !$0.isEmpty }, subject: subject)
                }
                .frame(height: height)
                .background(original ? Color.white : .clear, in: .rect(cornerRadius: Radius.md))
                if page.quoted {
                    pill("•••") { withAnimation(.quick) { quote.toggle() } }
                        .help(quote ? "Hide quoted text" : "Show quoted text")
                }
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

    private func pill(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.xs)
            .foregroundStyle(.muted)
            .padding(.horizontal, 10).frame(height: 24)
            .background(.hover, in: .capsule)
            .buttonStyle(.plain)
    }
}

// Mail is the sender's markup: it runs without JavaScript, can't load anything itself, and its remote images come
// through the server's image proxy, so the sender never sees the reader's address.
struct Frame {
    let html: String

    /// It brings its own dark design.
    var ownDark: Bool { html.contains(/(?i)prefers-color-scheme\s*:\s*dark|color-scheme\s*:[^;"'}]*\bdark/) }
    /// It loads pictures or backgrounds from the web.
    var remote: Bool { html.contains(/(?i)(src|background)\s*=\s*["']https?:|url\(\s*['"]?https?:|srcset\s*=/) }
    /// It carries an earlier mail, quoted.
    var quoted: Bool { html.contains(/(?i)class\s*=\s*["'][^"']*gmail_quote|<blockquote/) }

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
    // The same places the web folds: a Gmail quote, a cited blockquote, or one standing on its own.
    private static let folded = ".gmail_quote, blockquote[type='cite' i], body > blockquote { display: none; }"
    // Without the proxy the blocker stops them anyway; hidden, they don't leave broken frames behind.
    private static let unloaded = "img[src^='http' i], img[srcset] { display: none; }"

    func render(dark: Bool, pictures: Bool, quote: Bool) -> String {
        let look = !dark ? Self.light : ownDark ? Self.own : Self.flipped
        return #"<meta name="viewport" content="width=device-width, initial-scale=1">"#
            + "<style>\(look) body { margin: 0; font: 16px/1.6 -apple-system, system-ui; overflow-wrap: anywhere; }"
            + " blockquote { margin: 0 0 0 4px; padding-left: 12px; border-left: 2px solid #e2ded9; color: #6b655f; }"
            + (quote ? "" : Self.folded) + (pictures ? "" : Self.unloaded) + "</style>"
            + (pictures ? Self.proxied(html) : html)
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
