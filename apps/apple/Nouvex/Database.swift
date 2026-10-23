// SPDX-License-Identifier: AGPL-3.0-only
import CryptoKit
import Foundation
import GRDB

struct Account: Codable, Hashable, Identifiable, FetchableRecord, PersistableRecord {
    var id: String
    var email: String
    var displayName: String
    var signature: String
    /// Out of All inboxes and the picker, still there to look into.
    var archived = false
    /// Why the server can't sync it right now, if it can't.
    var syncError: String?
    /// How the user tells it apart: a short name, one of the label hues, its place in the picker.
    var nickname = ""
    var color: String?
    var position = 0
    /// Its mail counts for no unread dot or notification in All inboxes.
    var muted = false

    var name: String { nickname.isEmpty ? email : nickname }
}

/// Accounts read together, like one inbox; an account can be in several.
struct AccountGroup: Codable, Hashable, Identifiable, FetchableRecord, PersistableRecord {
    var id: String
    var name: String
    var position: Int
    var muted: Bool
    var focus: Focus?
    var accountIds: [String]

    /// Outside its focus times its mail waits out of All inboxes and makes no noise.
    func resting(_ at: Date = .now) -> Bool { focus.map { !$0.within(at) } ?? false }
}

struct Mailbox: Codable, Hashable, FetchableRecord, PersistableRecord {
    var id: String
    var accountId: String
    var name: String
    var role: String
}

/// A file attached to a message; the bytes come on request, by its place in the list.
struct Attachment: Codable, Hashable, Sendable {
    var name: String
    var type: String
    var size: Int
}

/// A sign-in code or a meeting the engine found in a message.
struct Action: Codable, Hashable, Sendable {
    var kind: String
    var code: String?
    var title: String?
    var start: Date?
    var end: Date?
    var url: String?
    var provider: String?
    var event: String?
    var cancelled: Bool?
}

// A message as GET /accounts/{id}/changes delivers it, with what was sealed in it opened (Mail.changes).
struct Message: Codable, Hashable, Identifiable, Sendable, FetchableRecord, PersistableRecord {
    var id: String
    var accountId: String
    var mailboxId: String
    var messageId: String
    var threadId: String
    var subject: String
    var snippet: String
    var fromName: String
    var fromAddr: String
    var to: [String]
    var cc: [String]
    var sentAt: Date
    var flags: [String]
    var category: String
    var attachments: Int
    // What flags says, kept apart so unread and starred mail is found through an index.
    var seen = false
    var starred = false
    var files: [Attachment] = []
    var actions: [Action] = []
    /// The message's own key, sealed to the user: it opens the body and the attachments too.
    var key = Data()
    /// A rich mail with a designed version (docs/rich-mail.md).
    var rich = false
    /// Put into the inbox by Nouvex itself, so its nx-actions may open places in the app.
    var seeded = false

    /// Opens the message's key with this device's private key.
    func open() throws -> SymmetricKey {
        guard let mine = Keys.stored else { throw AuthError(errorDescription: "This device is locked.") }
        return try Crypto.openKey(mine, key)
    }

    var sender: String { fromName.isEmpty ? fromAddr : fromName }
    /// Sent from one of the reader's own addresses.
    func ours(_ accounts: [Account]) -> Bool { accounts.contains { $0.email.caseInsensitiveCompare(fromAddr) == .orderedSame } }
    /// Everyone on it but the reader's own addresses, each once.
    func others(_ accounts: [Account]) -> [String] {
        let mine = Set(accounts.map { $0.email.lowercased() })
        var seen = Set<String>()
        return ([fromAddr] + to + cc).filter { !mine.contains($0.lowercased()) && seen.insert($0.lowercased()).inserted }
    }
    /// The id of the draft this message is a saved version of.
    var draftId: String? { messageId.firstMatch(of: /^<?draft-([0-9a-f-]{36})@/).map { String($0.1) } }

    mutating func set(seen: Bool? = nil, starred: Bool? = nil) {
        for (flag, on) in [("\\Seen", seen), ("\\Flagged", starred)] {
            guard let on else { continue }
            flags.removeAll { $0 == flag }
            if on { flags.append(flag) }
        }
        self.seen = flags.contains("\\Seen")
        self.starred = flags.contains("\\Flagged")
    }
}

struct Cursor: Codable, FetchableRecord, PersistableRecord {
    var accountId: String
    var version: Int
}

struct Html: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "body"
    var id: String
    var html: String

    /// A message's HTML, fetched once and kept for reading offline.
    static func load(_ m: Message) async -> String? {
        let id = m.id
        if let stored = try? await Store.db.read({ try Html.fetchOne($0, key: id) }) { return stored.html }
        guard let sealed = try? await API.client.getMessageBody(path: .init(accountId: m.accountId, messageId: id)).ok.body.json.sealed,
              let opened = try? Crypto.decrypt(m.open(), "body", Data(base64Encoded: sealed) ?? Data())
        else { return nil }
        let html = String(decoding: opened, as: UTF8.self)
        try? await Store.db.write { try Html(id: id, html: html).save($0) }
        return html
    }

    /// A rich mail's designed version, fetched once and kept like the body.
    static func rich(_ m: Message) async -> String? {
        let id = m.id
        if let stored = try? await Store.db.read({ try Rich.fetchOne($0, key: id) }) { return stored.html }
        guard let sealed = try? await API.client.getMessageRich(path: .init(accountId: m.accountId, messageId: id)).ok.body.json.sealed,
              let opened = try? Crypto.decrypt(m.open(), "rich", Data(base64Encoded: sealed) ?? Data())
        else { return nil }
        let html = String(decoding: opened, as: UTF8.self)
        try? await Store.db.write { try Rich(id: id, html: html).save($0) }
        return html
    }

    private struct Rich: Codable, FetchableRecord, PersistableRecord {
        var id: String
        var html: String
    }

    /// The mail as plain text, for quoting.
    // ponytail: tags dropped by pattern, entities beyond the common ones stay as written.
    static func text(_ html: String) -> String {
        html.replacing(/(?is)<(style|script|head)\b.*?<\/\1>/, with: "")
            .replacing(/(?i)<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/, with: "\n")
            .replacing(/<[^>]+>/, with: "")
            .replacingOccurrences(of: "&nbsp;", with: " ").replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&amp;", with: "&")
            .replacing(/[ \t]+\n/, with: "\n")
            .replacing(/\n{3,}/, with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// One row in a list: the conversation's messages in that folder, newest first.
struct Conversation: Identifiable, Hashable, Sendable {
    let messages: [Message]
    var id: String { messages[0].threadId }
    var latest: Message { messages[0] }
    var unread: Bool { messages.contains { !$0.seen } }
    var starred: Bool { messages.contains(where: \.starred) }
}

enum Folder: Hashable, Sendable {
    case inbox, category(String), starred, role(String)
    /// One of the account's own IMAP folders, by id, with its name.
    case mailbox(String, String)

    /// Only these accounts, given as one JSON array.
    static let within = "accountId IN (SELECT value FROM json_each(?))"

    func conversations(_ db: GRDB.Database, categories: Bool, accounts: [String]) throws -> [Conversation] {
        let inbox = "mailboxId IN (SELECT id FROM mailbox WHERE role = 'inbox')"
        let (sql, args): (String, StatementArguments) = switch self {
        case .inbox: (categories ? "\(inbox) AND category = 'primary'" : inbox, [])
        case .category(let name): ("\(inbox) AND category = ?", [name])
        case .starred: ("starred = 1 AND mailboxId NOT IN (SELECT id FROM mailbox WHERE role IN ('trash', 'junk'))", [])
        case .role(let role): ("mailboxId IN (SELECT id FROM mailbox WHERE role = ?)", [role])
        case .mailbox(let id, _): ("mailboxId = ?", [id])
        }
        return try Conversation.fetch(db, "(\(sql)) AND \(Self.within)", args + [accounts.json])
    }
}

extension Conversation {
    // ponytail: newest 2000 matching messages, page through older ones once someone scrolls that far.
    static func fetch(_ db: GRDB.Database, _ sql: String, _ args: StatementArguments) throws -> [Conversation] {
        let rows = try Message.filter(sql: sql, arguments: args).order(Column("sentAt").desc).limit(2000).fetchAll(db)
        var order: [String] = []
        var threads: [String: [Message]] = [:]
        for m in rows {
            if threads[m.threadId] == nil { order.append(m.threadId) }
            threads[m.threadId, default: []].append(m)
        }
        return order.map { Conversation(messages: threads[$0]!) }
    }

    /// Searches every folder but Trash and Junk of the account in view, like the web: words in the subject, preview or
    /// sender, plus from:, to:, is:unread, is:starred, has:attachment, after: and before: (YYYY-MM-DD). Archived
    /// accounts only when the caller passes them, for in:archived.
    static func search(_ db: GRDB.Database, _ text: String, accounts: [String]) throws -> [Conversation] {
        var clauses = ["mailboxId NOT IN (SELECT id FROM mailbox WHERE role IN ('trash', 'junk'))", Folder.within]
        var args: [DatabaseValueConvertible] = [accounts.json]
        for token in text.split(separator: " ") {
            let (key, value) = token.split(separator: ":", maxSplits: 1).count == 2
                ? (token.prefix { $0 != ":" }.lowercased(), String(token.drop { $0 != ":" }.dropFirst()))
                : ("", String(token))
            let day = value.split(separator: "-").compactMap { Int($0) }
            let date = day.count == 3 ? Calendar.current.date(from: DateComponents(year: day[0], month: day[1], day: day[2])) : nil
            switch (key, value.lowercased()) {
            case ("from", _):
                clauses.append("(fromAddr || ' ' || fromName) LIKE ?")
                args.append("%\(value)%")
            case ("to", _):
                clauses.append("(\"to\" || cc) LIKE ?")
                args.append("%\(value)%")
            case ("is", "unread"): clauses.append("seen = 0")
            case ("is", "starred"): clauses.append("starred = 1")
            case ("has", "attachment"): clauses.append("attachments > 0")
            case ("in", "archived"): break
            case ("after", _) where date != nil:
                clauses.append("sentAt >= ?")
                args.append(date!)
            case ("before", _) where date != nil:
                clauses.append("sentAt < ?")
                args.append(date!)
            default:
                clauses.append("(subject || ' ' || snippet || ' ' || fromName || ' ' || fromAddr) LIKE ?")
                args.append("%\(token)%")
            }
        }
        return try fetch(db, clauses.joined(separator: " AND "), StatementArguments(args))
    }
}

/// Unread conversations in the inbox per category, and the newest unread messages there.
struct Unread: Equatable, Sendable {
    var counts: [String: Int] = [:]
    var recent: [Message] = []

    static func fetch(_ db: GRDB.Database) throws -> Unread {
        let inbox = "seen = 0 AND mailboxId IN (SELECT id FROM mailbox WHERE role = 'inbox') AND \(Folder.within)"
        let ids = try AccountGroup.loud(db).json
        let rows = try Row.fetchAll(db, sql: "SELECT category, COUNT(DISTINCT threadId) AS n FROM message WHERE \(inbox) GROUP BY category", arguments: [ids])
        return Unread(
            counts: Dictionary(uniqueKeysWithValues: rows.map { ($0["category"], $0["n"]) }),
            recent: try Message.filter(sql: inbox, arguments: [ids]).order(Column("sentAt").desc).limit(20).fetchAll(db)
        )
    }
}

extension AccountGroup {
    /// The accounts whose new mail counts and notifies in All inboxes: not archived, muted or resting.
    // ponytail: read when mail changes, so a focus time starting shows with the next mail, not to the minute.
    static func loud(_ db: GRDB.Database, at: Date = .now) throws -> [String] {
        let groups = try AccountGroup.fetchAll(db)
        let quiet = Set(groups.filter { $0.muted || $0.resting(at) }.flatMap(\.accountIds))
        return try Account.filter(Column("archived") == false && Column("muted") == false).fetchAll(db).map(\.id).filter { !quiet.contains($0) }
    }
}

extension [String] {
    var json: String { String(data: try! JSONEncoder().encode(self), encoding: .utf8)! }
}

/// Someone mail came from.
struct Person: Hashable {
    let name: String
    let address: String
}

enum Store {
    /// People whose mail matches what's typed, most recent first.
    static func people(matching typed: String, limit: Int) async -> [Person] {
        (try? await db.read { db in
            try Row.fetchAll(db, sql: """
                SELECT fromName, fromAddr FROM message WHERE fromAddr LIKE ?1 OR fromName LIKE ?1
                GROUP BY lower(fromAddr) ORDER BY MAX(sentAt) DESC LIMIT ?2
                """, arguments: ["%\(typed)%", limit]).map { Person(name: $0["fromName"], address: $0["fromAddr"]) }
        }) ?? []
    }

    static let db: DatabasePool = {
        // Per bundle id: on the Mac, Application Support is shared, and a development build mustn't open the installed
        // app's copy.
        var dir = URL.applicationSupportDirectory.appending(path: Bundle.main.bundleIdentifier ?? "Nouvex")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // A copy of the server's mail: it syncs back after a restore, so it stays out of device backups.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        let db = try! DatabasePool(path: dir.appending(path: "mail.sqlite").path)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.create(table: "account") { t in
                t.primaryKey("id", .text)
                t.column("email", .text).notNull()
                t.column("displayName", .text).notNull()
            }
            try db.create(table: "cursor") { t in
                t.primaryKey("accountId", .text).references("account", onDelete: .cascade)
                t.column("version", .integer).notNull()
            }
            try db.create(table: "mailbox") { t in
                t.primaryKey("id", .text)
                t.column("accountId", .text).notNull().indexed().references("account", onDelete: .cascade)
                t.column("name", .text).notNull()
                t.column("role", .text).notNull()
            }
            try db.create(table: "message") { t in
                t.primaryKey("id", .text)
                t.column("accountId", .text).notNull().indexed().references("account", onDelete: .cascade)
                t.column("mailboxId", .text).notNull()
                t.column("messageId", .text).notNull()
                t.column("threadId", .text).notNull().indexed()
                t.column("subject", .text).notNull()
                t.column("snippet", .text).notNull()
                t.column("fromName", .text).notNull()
                t.column("fromAddr", .text).notNull()
                t.column("sentAt", .datetime).notNull()
                t.column("flags", .text).notNull()
                t.column("category", .text).notNull()
                t.column("attachments", .integer).notNull()
                t.column("seen", .boolean).notNull()
                t.column("starred", .boolean).notNull()
            }
            try db.create(index: "message_mailbox_sent", on: "message", columns: ["mailboxId", "sentAt"])
            try db.create(table: "body") { t in
                t.primaryKey("id", .text).references("message", onDelete: .cascade)
                t.column("html", .text).notNull()
            }
        }
        // Recipients and signatures came later; messages are fetched again to get them.
        migrator.registerMigration("v2") { db in
            try db.alter(table: "account") { t in t.add(column: "signature", .text).notNull().defaults(to: "") }
            try db.alter(table: "message") { t in
                t.add(column: "to", .text).notNull().defaults(to: "[]")
                t.add(column: "cc", .text).notNull().defaults(to: "[]")
            }
            try db.execute(sql: "DELETE FROM body; DELETE FROM message; DELETE FROM cursor")
        }
        // Attachments by name, codes and meetings, and archived accounts came later; messages are fetched again.
        migrator.registerMigration("v3") { db in
            try db.alter(table: "account") { t in
                t.add(column: "archived", .boolean).notNull().defaults(to: false)
                t.add(column: "syncError", .text)
            }
            try db.alter(table: "message") { t in
                t.add(column: "files", .text).notNull().defaults(to: "[]")
                t.add(column: "actions", .text).notNull().defaults(to: "[]")
            }
            try db.execute(sql: "DELETE FROM message; DELETE FROM cursor")
        }
        // Mail comes sealed for the user now; what was stored before is fetched again.
        migrator.registerMigration("v4") { db in
            try db.alter(table: "message") { t in t.add(column: "key", .blob).notNull().defaults(to: Data()) }
            try db.execute(sql: "DELETE FROM body; DELETE FROM message; DELETE FROM mailbox; DELETE FROM cursor")
        }
        // Account groups, short names, colors and order.
        migrator.registerMigration("v5") { db in
            try db.alter(table: "account") { t in
                t.add(column: "nickname", .text).notNull().defaults(to: "")
                t.add(column: "color", .text)
                t.add(column: "position", .integer).notNull().defaults(to: 0)
                t.add(column: "muted", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "accountGroup") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("position", .integer).notNull()
                t.column("muted", .boolean).notNull()
                t.column("focus", .text)
                t.column("accountIds", .text).notNull()
            }
        }
        // Rich mail: its designed version is kept like the body.
        migrator.registerMigration("v6") { db in
            try db.alter(table: "message") { t in
                t.add(column: "rich", .boolean).notNull().defaults(to: false)
                t.add(column: "seeded", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "rich") { t in
                t.primaryKey("id", .text).references("message", onDelete: .cascade)
                t.column("html", .text).notNull()
            }
        }
        try! migrator.migrate(db)
        return db
    }()
}
