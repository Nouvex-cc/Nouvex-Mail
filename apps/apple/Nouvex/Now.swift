// SPDX-License-Identifier: AGPL-3.0-only
import GRDB
import SwiftUI

/// A sign-in code or a meeting, and the mail it came in.
struct Due: Identifiable {
    let message: Message
    let action: Action
    var id: String { action.kind == "meeting" ? action.event ?? message.id : "\(message.id)-code" }

    /// What the sidebar shows at `now`, the same rules as the web (apps/web/src/now.tsx): sign-in codes for `life`
    /// minutes after they arrive, meetings from `lead` minutes before they start until they end. The newest invitation
    /// of a meeting wins, so an update moves it and a cancellation hides it. At most three, the most urgent last.
    static func now(_ messages: [Message], at now: Date, lead: Int, life: Int) -> [Due] {
        var codes: [Due] = []
        var meetings: [String: Due] = [:]
        for m in messages {
            for a in m.actions {
                let age = now.timeIntervalSince(m.sentAt)
                if a.kind == "code", age < Double(life * 60), age > -60 { codes.append(Due(message: m, action: a)) }
                guard a.kind == "meeting" else { continue }
                let key = a.event ?? m.id
                if let had = meetings[key], had.message.sentAt >= m.sentAt { continue }
                meetings[key] = Due(message: m, action: a)
            }
        }
        let soon = meetings.values.filter { d in
            guard let start = d.action.start else { return false }
            let end = d.action.end ?? start.addingTimeInterval(30 * 60)
            return d.action.cancelled != true && start.addingTimeInterval(Double(-lead * 60)) <= now && now < end
        }
        .sorted { ($0.action.start ?? .distantPast) > ($1.action.start ?? .distantPast) }
        return Array((soon + codes.sorted { $0.message.sentAt < $1.message.sentAt }).suffix(3))
    }
}

/// Sign-in codes and meetings about to start for the accounts in view, above the profile. A click on the card opens
/// its mail; the button copies the code or joins the call.
struct NowCards: View {
    @Environment(Mail.self) private var mail
    @Environment(\.openURL) private var openURL
    @State private var found: [Message] = []

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { t in
            let inView = Set(mail.accounts.filter { a in mail.account.map { $0 == a.id } ?? !a.archived }.map(\.id))
            let cards = Due.now(found.filter { inView.contains($0.accountId) }, at: t.date, lead: mail.prefs.meetingLead, life: mail.prefs.codeLife)
            VStack(spacing: 6) {
                ForEach(cards) { card($0, now: t.date) }
            }
        }
        .task { await observe() }
    }

    private func card(_ due: Due, now: Date) -> some View {
        let a = due.action
        let m = due.message
        let title: String
        let detail: String
        if a.kind == "code", let code = a.code {
            title = code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
            let ago = Int(now.timeIntervalSince(m.sentAt) / 60)
            detail = "\(m.sender) · \(ago < 1 ? "just now" : "\(ago) min ago")"
        } else {
            let left = Int(((a.start ?? now).timeIntervalSince(now) / 60).rounded(.up))
            title = a.title ?? m.subject
            detail = [left > 0 ? "In \(left) min" : "Now", a.provider].compactMap { $0 }.joined(separator: " · ")
        }
        return HStack(spacing: 8) {
            Button {
                mail.thread = m.threadId
            } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(detail).font(.xs).foregroundStyle(.muted).lineLimit(1)
                    Text(title).font(.sm.weight(.medium)).monospacedDigit().foregroundStyle(.ink).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if a.kind == "code", let code = a.code {
                CopyButton(text: code)
            } else if let url = a.url.flatMap(URL.init(string:)) {
                Button("Join") { openURL(url) }.buttonStyle(.glass).controlSize(.small)
            }
        }
        .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
        .background(.paper, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).stroke(.line))
    }

    // Mail with a code or a meeting in it, outside Trash and Junk.
    private func observe() async {
        let found = ValueObservation.tracking { db in
            try Message.filter(sql: "actions != '[]' AND mailboxId NOT IN (SELECT id FROM mailbox WHERE role IN ('trash', 'junk'))").fetchAll(db)
        }
        do {
            for try await value in found.values(in: Store.db) { self.found = value }
        } catch {}
    }
}

/// "Copy", then "Copied" for a moment.
private struct CopyButton: View {
    let text: String
    @State private var copied = false

    var body: some View {
        Button(copied ? "Copied" : "Copy") {
            Clipboard.copy(text)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        }
        .buttonStyle(.glass)
        .controlSize(.small)
    }
}
