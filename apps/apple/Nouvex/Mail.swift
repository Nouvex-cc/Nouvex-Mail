// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import GRDB
import Observation
import UserNotifications
#if os(macOS)
import AppKit
#endif

/// The signed-in session: keeps the local copy in step with the server and changes mail there.
@MainActor @Observable final class Mail {
    enum State { case loading, signedOut, signedIn }

    var state = State.loading
    var folder = Folder.inbox
    /// The account the sidebar shows, all of them when nil.
    var account: String?
    var thread: String?
    /// A new message, docked in the window's bottom right.
    var compose: Draft?
    /// A reply being written in the open conversation, in the reply bar's place.
    var reply: Draft?
    /// Who's signed in, for the profile at the bottom of the sidebar.
    private(set) var me = (name: "", email: "")
    private(set) var accountList: [Account] = []
    /// Settings that follow the user from the web.
    private(set) var categories = true
    private(set) var undoSend = 5
    private(set) var unread = Unread()

    /// Unread conversations in the inbox, the way the sidebar counts them.
    var inboxUnread: Int { categories ? unread.counts["primary"] ?? 0 : unread.counts.values.reduce(0, +) }
    var recent: [Message] { Array(unread.recent.filter { !categories || $0.category == "primary" }.prefix(5)) }

    private var pulls: [String: Task<Void, Never>] = [:]
    private var again: Set<String> = []
    private var tasks: [Task<Void, Never>] = []

    func start() {
        guard tasks.isEmpty else { return }
        state = .loading
        tasks = [Task { await connect() }, Task { await watchUnread() }]
    }

    /// Back on screen: a socket from before a suspend can look open and never deliver again, so it starts over and
    /// catches up.
    func resume() {
        guard state == .signedIn, !tasks.isEmpty else { return }
        tasks[0].cancel()
        tasks[0] = Task { await connect() }
    }

    /// Pull to refresh: everything since the last pull, waiting until it's in.
    func refresh() async {
        resume()
        for a in accountList { pull(a.id) }
        while !pulls.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
    }

    func signedIn() {
        stop()
        start()
    }

    func signOut() async {
        stop()
        await API.signOut()
        _ = try? await Store.db.write { try Account.deleteAll($0) }
        state = .signedOut
    }

    private func stop() {
        for t in tasks { t.cancel() }
        tasks = []
    }

    // Accounts and settings first, then the socket; every (re)connect catches up on what was missed.
    private func connect() async {
        while !Task.isCancelled {
            do {
                try await load()
                let socket = URLSession.shared.webSocketTask(with: socketURL)
                socket.resume()
                defer { socket.cancel() }
                for a in accountList { pull(a.id) }
                while !Task.isCancelled {
                    let message = try await withTaskCancellationHandler { try await socket.receive() } onCancel: { socket.cancel() }
                    if case .string(let text) = message { event(text) }
                }
            } catch is SignedOut {
                state = .signedOut
                return
            } catch {
                // Offline: whatever was synced before still shows.
                if state == .loading {
                    let known = (try? await Store.db.read { try Account.fetchCount($0) }) ?? 0
                    state = known > 0 ? .signedIn : .signedOut
                }
            }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    private var socketURL: URL {
        var url = URLComponents(url: Server.url.appending(path: "ws"), resolvingAgainstBaseURL: false)!
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        return url.url!
    }

    private func load() async throws {
        let client = API.client
        let list: [Account]
        switch try await client.listAccounts() {
        case .ok(let ok):
            list = try ok.body.json.filter { $0.archivedAt == nil }.map {
                Account(id: $0.id, email: $0.email, displayName: $0.displayName, signature: $0.signature)
            }
        case .undocumented(statusCode: 401, _): throw SignedOut()
        case .undocumented: throw URLError(.badServerResponse)
        }
        if let prefs = try? await client.getPrefs().ok.body.json {
            categories = prefs.categories ?? true
            undoSend = Int(prefs.undoSend?.value1 ?? 5)
        }
        if let user = await API.me() { me = user }
        // Accounts removed or archived elsewhere take their mail with them.
        try await Store.db.write { db in
            try Account.filter(!list.map(\.id).contains(Column("id"))).deleteAll(db)
            for a in list { try a.save(db) }
        }
        accountList = list
        if let account, !list.contains(where: { $0.id == account }) { self.account = nil }
        // Asked once there's mail to tell about, not on the sign-in screen.
        if state != .signedIn {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        }
        state = .signedIn
    }

    // Engine events (packages/schema), with only the fields used here.
    private struct Event: Decodable {
        struct About: Decodable {
            let accountId: String
            let subject: String?
            let error: String?
        }
        let subject: String
        let data: About
    }

    private func event(_ text: String) {
        guard let e = try? JSONDecoder().decode(Event.self, from: Data(text.utf8)), accountList.contains(where: { $0.id == e.data.accountId }) else { return }
        if e.subject.hasPrefix("evt.mailbox.") { pull(e.data.accountId) }
        // Sending happens after the composer closed, so only a failure is worth a word.
        if e.subject == "evt.message.sent", let error = e.data.error {
            let content = UNMutableNotificationContent()
            content.title = "Couldn't send “\(e.data.subject ?? "")”"
            content.body = error
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    /// Fetches everything after the stored cursor. A pull asked for while one runs follows right after it.
    func pull(_ accountId: String) {
        guard pulls[accountId] == nil else {
            again.insert(accountId)
            return
        }
        pulls[accountId] = Task {
            if let fresh = try? await Self.changes(accountId) { notify(fresh) }
            pulls[accountId] = nil
            if again.remove(accountId) != nil { pull(accountId) }
        }
    }

    /// Applies the changes page by page and returns what came into an inbox since the last pull.
    nonisolated private static func changes(_ accountId: String) async throws -> [Message] {
        var fresh: [Message] = []
        while true {
            let since = try await Store.db.read { try Cursor.fetchOne($0, key: accountId)?.version } ?? 0
            let page = try await API.client.getChanges(path: .init(accountId: accountId), query: .init(since: since)).ok.body.json
            let messages = page.messages.upserted.map { m in
                var message = Message(
                    id: m.id, accountId: accountId, mailboxId: m.mailboxId, messageId: m.messageId, threadId: m.threadId,
                    subject: m.subject, snippet: m.snippet, fromName: m.fromName, fromAddr: m.fromAddr, to: m.to, cc: m.cc, sentAt: m.sentAt,
                    flags: m.flags, category: m.category.rawValue, attachments: m.attachments.count
                )
                message.set()
                return message
            }
            fresh += try await Store.db.write { db in
                for b in page.mailboxes.upserted {
                    try Mailbox(id: b.id, accountId: accountId, name: b.name, role: b.role.rawValue).save(db)
                }
                _ = try Mailbox.deleteAll(db, keys: page.mailboxes.deleted)
                // The first pull brings the whole mailbox, none of it new.
                let inboxes = try Set(String.fetchAll(db, sql: "SELECT id FROM mailbox WHERE role = 'inbox'"))
                let new = since == 0 ? [] : try messages.filter { try !$0.exists(db) && !$0.seen && inboxes.contains($0.mailboxId) }
                for m in messages { try m.save(db) }
                _ = try Message.deleteAll(db, keys: page.messages.deleted)
                try Cursor(accountId: accountId, version: page.version).save(db)
                return new
            }
            if !page.more { return fresh }
        }
    }

    private func notify(_ fresh: [Message]) {
        for m in fresh where !categories || m.category == "primary" {
            let content = UNMutableNotificationContent()
            content.title = m.sender
            content.body = m.subject
            content.threadIdentifier = m.threadId
            content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: m.id, content: content, trigger: nil))
        }
    }

    private func watchUnread() async {
        do {
            for try await value in ValueObservation.tracking(Unread.fetch).removeDuplicates().values(in: Store.db) {
                unread = value
                #if os(macOS)
                NSApplication.shared.dockTile.badgeLabel = inboxUnread > 0 ? "\(inboxUnread)" : nil
                #else
                try? await UNUserNotificationCenter.current().setBadgeCount(inboxUnread)
                #endif
            }
        } catch {}
    }

    /// Changes the local copy right away; a message the server refuses to change is put back as it was.
    func update(
        _ messages: [Message], seen: Bool? = nil, starred: Bool? = nil, archive: Bool = false, trash: Bool = false, snoozeUntil: Date? = nil
    ) {
        Task { await Background.keepAlive {
            try? await Store.db.write { db in
                for var m in messages {
                    if archive || trash || snoozeUntil != nil {
                        _ = try m.delete(db)
                    } else {
                        m.set(seen: seen, starred: starred)
                        try m.save(db)
                    }
                }
            }
            let client = API.client
            for m in messages {
                let change = Operations.updateMessage.Input.Body.jsonPayload(
                    seen: seen, flagged: starred, trash: trash ? true : nil, archive: archive ? true : nil, snoozeUntil: snoozeUntil
                )
                let res = try? await client.updateMessage(path: .init(accountId: m.accountId, messageId: m.id), body: .json(change))
                if case .accepted = res { continue }
                try? await Store.db.write { try m.save($0) }
            }
        } }
    }
}
