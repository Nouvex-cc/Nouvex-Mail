// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import GRDB
import Observation
import SwiftUI
import UserNotifications
#if os(macOS)
import AppKit
#endif

/// Settings that follow the user to every device; the server leaves out whatever is at its default.
struct Prefs {
    var markRead = "instant"
    var remoteImages = "always"
    var afterArchive = "list"
    var undoSend = 5
    var replyDefault = "reply"
    /// Replies to mail sent from an archived account still show in All inboxes.
    var archivedReplies = true
    /// Minutes before a meeting starts that it shows in the sidebar.
    var meetingLead = 15
    /// Minutes a sign-in code stays in the sidebar.
    var codeLife = 5
    var categories = true
}

/// A short word after something happened, at the bottom of the window.
struct Toast: Identifiable {
    let id = UUID()
    let title: String
    var detail: String?
}

/// The signed-in session: keeps the local copy in step with the server and changes mail there.
@MainActor @Observable final class Mail {
    enum State { case loading, signedOut, signedIn }

    var state = State.loading
    var folder = Folder.inbox
    /// What the sidebar shows: all accounts when nil, "group:<id>" or one account's id.
    var scope: String?
    /// The one account in view, if it's one.
    var account: String? { scope?.hasPrefix("group:") == true ? nil : scope }
    var group: AccountGroup? { groups.first { "group:\($0.id)" == scope } }
    /// The account a new message starts from: the one in view, or a group's first.
    var sender: String? { account ?? group?.accountIds.first }
    /// What the picker calls a choice.
    func title(_ choice: String?) -> String {
        guard let choice else { return "All inboxes" }
        return groups.first { "group:\($0.id)" == choice }?.name ?? accounts.first { $0.id == choice }?.name ?? ""
    }
    var thread: String?
    /// The conversations in the list, in order, for moving on to the next one after archiving.
    var order: [String] = []
    /// A new message, docked in the window's bottom right.
    var compose: Draft?
    /// A reply being written in the open conversation, in the reply bar's place.
    var reply: Draft?
    /// Who's signed in, for the profile at the bottom of the sidebar.
    var me = (name: "", email: "")
    /// The page Settings shows, and on iOS whether its sheet is up.
    var settings: SettingsPage? = .reading
    var settingsOpen = false
    /// This device has the key to the user's mail (Keys.swift); a passkey alone doesn't bring it.
    var unlocked = Keys.stored != nil
    var shortcutsOpen = false
    /// Every account, archived ones too.
    private(set) var accounts: [Account] = []
    private(set) var groups: [AccountGroup] = []
    private(set) var prefs = Prefs()
    private(set) var unread = Unread()
    /// Accounts the engine is syncing right now.
    private(set) var syncing: Set<String> = []
    private(set) var toasts: [Toast] = []

    /// The accounts in All inboxes and the picker.
    var accountList: [Account] { accounts.filter { !$0.archived } }
    /// The accounts in view: the one picked, a group's, or every active one whose group isn't resting.
    var inView: [Account] {
        if let group { return accounts.filter { group.accountIds.contains($0.id) } }
        if let account { return accounts.filter { $0.id == account } }
        let resting = Set(groups.filter { $0.resting() }.flatMap(\.accountIds))
        return accountList.filter { !resting.contains($0.id) }
    }
    /// Several accounts mix in the list, so senders take their account's color.
    var mixed: Bool { account == nil && inView.count > 1 }
    /// All inboxes, then the groups and the accounts, in the user's order; ⌘1 to ⌘9 pick them.
    var choices: [String?] { [nil] + groups.map { "group:\($0.id)" } + accountList.map(\.id) }

    /// Unread conversations in the inbox, the way the sidebar counts them.
    var inboxUnread: Int { prefs.categories ? unread.counts["primary"] ?? 0 : unread.counts.values.reduce(0, +) }
    var recent: [Message] { Array(unread.recent.filter { !prefs.categories || $0.category == "primary" }.prefix(5)) }

    private var pulls: [String: Task<Void, Never>] = [:]
    private var again: Set<String> = []
    private var tasks: [Task<Void, Never>] = []

    func start() {
        guard tasks.isEmpty else { return }
        state = .loading
        // What was there last time, so the list fills before the server answers, or without it.
        if let (a, g) = try? Store.db.read({ db in
            (try Account.order(Column("position")).fetchAll(db), try AccountGroup.order(Column("position")).fetchAll(db))
        }) { (accounts, groups) = (a, g) }
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
        for a in accounts { pull(a.id) }
        while !pulls.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
    }

    func signedIn() {
        unlocked = Keys.stored != nil
        stop()
        start()
    }

    func signOut() async {
        stop()
        Keys.forget()
        unlocked = false
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
                for a in accounts { pull(a.id) }
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
        try await loadAccounts()
        if let p = try? await API.client.getPrefs().ok.body.json {
            let d = Prefs()
            prefs = Prefs(
                markRead: p.markRead?.rawValue ?? d.markRead, remoteImages: p.remoteImages?.rawValue ?? d.remoteImages,
                afterArchive: p.afterArchive?.rawValue ?? d.afterArchive, undoSend: p.undoSend?.value1.map { Int($0) } ?? d.undoSend,
                replyDefault: p.replyDefault?.rawValue ?? d.replyDefault, archivedReplies: p.archivedReplies ?? d.archivedReplies,
                meetingLead: p.meetingLead?.value1.map { Int($0) } ?? d.meetingLead, codeLife: p.codeLife?.value1.map { Int($0) } ?? d.codeLife,
                categories: p.categories ?? d.categories
            )
        }
        if let user = await API.me() { me = user }
        let first = state != .signedIn
        state = .signedIn
        // Asked once there's mail to tell about, not on the sign-in screen. Nothing waits for the answer: with Focus on,
        // the question may not even show.
        if first { Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) } }
    }

    /// The accounts with their sync errors; one removed elsewhere takes its mail with it.
    func loadAccounts() async throws {
        let list: [Account]
        switch try await API.client.listAccounts() {
        case .ok(let ok):
            list = try ok.body.json.map {
                Account(
                    id: $0.id, email: $0.email, displayName: $0.displayName, signature: $0.signature, archived: $0.archivedAt != nil,
                    syncError: $0.syncError, nickname: $0.nickname, color: $0.color?.rawValue, muted: $0.muted
                )
            }
            .enumerated().map { i, a in var a = a; a.position = i; return a }
        case .undocumented(statusCode: 401, _): throw SignedOut()
        case .undocumented: throw URLError(.badServerResponse)
        }
        let groups = (try? await API.client.listGroups().ok.body.json)?.enumerated().map { i, g in
            AccountGroup(
                id: g.id, name: g.name, position: i, muted: g.muted,
                focus: g.focus.map { Focus(days: $0.days, from: $0.from, to: $0.to) }, accountIds: g.accountIds
            )
        }
        try await Store.db.write { db in
            try Account.filter(!list.map(\.id).contains(Column("id"))).deleteAll(db)
            for a in list { try a.save(db) }
            if let groups {
                try AccountGroup.deleteAll(db)
                for g in groups { try g.insert(db) }
            }
        }
        accounts = list
        if let groups { self.groups = groups }
        if let scope, !choices.contains(scope), !list.contains(where: { $0.id == scope }) { self.scope = nil }
    }

    /// Changes a setting here right away and on the server, where every other device picks it up.
    func set(_ change: (inout Prefs) -> Void) {
        let before = prefs
        change(&prefs)
        let p = prefs
        let body = Operations.updatePrefs.Input.Body.jsonPayload(
            markRead: .init(rawValue: p.markRead), remoteImages: .init(rawValue: p.remoteImages), afterArchive: .init(rawValue: p.afterArchive),
            undoSend: .init(value1: Double(p.undoSend)), replyDefault: .init(rawValue: p.replyDefault), archivedReplies: p.archivedReplies,
            meetingLead: .init(value1: Double(p.meetingLead)), codeLife: .init(value1: Double(p.codeLife)), categories: p.categories
        )
        Task {
            if case .noContent = try? await API.client.updatePrefs(body: .json(body)) { return }
            prefs = before
            toast("Couldn't save the setting")
        }
    }

    /// A setting as a binding for a control; changing it saves it.
    func binding<Value>(_ key: WritableKeyPath<Prefs, Value>) -> Binding<Value> {
        Binding(get: { self.prefs[keyPath: key] }, set: { v in self.set { $0[keyPath: key] = v } })
    }

    func toast(_ title: String, _ detail: String? = nil) {
        let t = Toast(title: title, detail: detail)
        withAnimation(.quick) { toasts = Array((toasts + [t]).suffix(3)) }
        Task {
            try? await Task.sleep(for: .seconds(4))
            withAnimation(.quick) { toasts.removeAll { $0.id == t.id } }
        }
    }

    // Engine events (packages/schema), with only the fields used here.
    private struct Event: Decodable {
        struct About: Decodable {
            let accountId: String
            let version: Int?
            let subject: String?
            let error: String?
        }
        let subject: String
        let data: About
    }

    private func event(_ text: String) {
        guard let e = try? JSONDecoder().decode(Event.self, from: Data(text.utf8)), accounts.contains(where: { $0.id == e.data.accountId }) else { return }
        let id = e.data.accountId
        switch e.subject {
        case "evt.mailbox.syncing":
            if e.data.version != nil { pull(id) }
            syncing.insert(id)
        case "evt.mailbox.synced":
            if e.data.error == nil { pull(id) }
            syncing.remove(id)
            // A sync that failed or worked again changes the account's error.
            Task { try? await loadAccounts() }
        case "evt.message.sent":
            if let error = e.data.error { toast("Couldn't send", error) } else { toast("Sent") }
        default: break
        }
    }

    /// What the engine sealed for the user (Meta in engine/internal/mail/sync.go).
    private struct Meta: Decodable {
        let messageId, subject, snippet, fromName, fromAddr: String
        let to, cc: [String]
        let attachments: [Attachment]
        let actions: [Action]
        let rich, seeded: Bool?
    }

    nonisolated private static let metaDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { try ISODates().decode($0.singleValueContainer().decode(String.self)) }
        return d
    }()

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
            guard let mine = Keys.stored else { return fresh }
            // One that doesn't open (sealed to a key from before a reset) is left out rather than holding up the rest.
            let messages = page.messages.upserted.compactMap { m -> Message? in
                let key = Data(base64Encoded: m.key) ?? Data()
                guard let plain = try? Crypto.decrypt(Crypto.openKey(mine, key), "meta", Data(base64Encoded: m.sealed) ?? Data()),
                      let meta = try? metaDecoder.decode(Meta.self, from: plain)
                else { return nil }
                var message = Message(
                    id: m.id, accountId: accountId, mailboxId: m.mailboxId, messageId: meta.messageId, threadId: m.threadId,
                    subject: meta.subject, snippet: meta.snippet, fromName: meta.fromName, fromAddr: meta.fromAddr, to: meta.to,
                    cc: meta.cc, sentAt: m.sentAt, flags: m.flags, category: m.category.rawValue, attachments: meta.attachments.count,
                    files: meta.attachments, actions: meta.actions, key: key, rich: meta.rich ?? false, seeded: meta.seeded ?? false
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
        let loud = Set((try? Store.db.read { try AccountGroup.loud($0) }) ?? [])
        for m in fresh where (!prefs.categories || m.category == "primary") && loud.contains(m.accountId) {
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

    func addGroup() async {
        let body = Operations.createGroup.Input.Body.jsonPayload(name: "New group", accountIds: [], muted: false, focus: nil)
        guard case .created(let created) = try? await API.client.createGroup(body: .json(body)), let id = try? created.body.json.id else {
            return toast("Couldn't add a group")
        }
        try? await loadAccounts()
        settings = .group(id)
    }

    /// Removes an account and everything synced from it; the mail server keeps its mail.
    func remove(_ account: Account) async {
        guard case .noContent = try? await API.client.deleteAccount(path: .init(accountId: account.id)) else {
            return toast("Couldn't remove \(account.email)")
        }
        _ = try? await Store.db.write { try Account.deleteOne($0, key: account.id) }
        try? await loadAccounts()
    }

    /// Changes the local copy right away; a message the server refuses to change is put back as it was.
    func update(
        _ messages: [Message], seen: Bool? = nil, starred: Bool? = nil, archive: Bool = false, trash: Bool = false, snoozeUntil: Date? = nil
    ) {
        if let snoozeUntil, !messages.isEmpty { toast("Snoozed until \(snoozeUntil.when)") }
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
