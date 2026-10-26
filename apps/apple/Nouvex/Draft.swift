// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import GRDB
import OpenAPIRuntime
import UniformTypeIdentifiers

/// What a composer starts with and keeps while it's open: a new message, a reply with the earlier mail quoted under
/// the text, a forward carrying the original along, or a saved draft to continue. Its files go with it, so closing and
/// opening it again, or sending it from the toast after a failure, loses none.
struct Draft: Hashable {
    var draftId = UUID().uuidString.lowercased()
    var accountId: String?
    /// nil for a new message.
    var kind: Answering.Kind?
    /// The conversation a reply belongs to; it shows there, and only there.
    var thread: String?
    var to: [String] = []
    var cc: [String] = []
    var bcc: [String] = []
    var subject = ""
    var body = ""
    /// A reply's quoted text, below what's written.
    var quote = ""
    /// A forward's original, shown as a card and sent along with its formatting.
    var forwarded: Forwarded?
    var files: [Piece] = []
    var inReplyTo: String?
    var references: [String] = []
    /// Who the reply bar named, for the composer's title.
    var person = ""
    /// It's in the Drafts folder: it has its signature already, and discarding it deletes it there.
    var saved = false

    struct Forwarded: Hashable {
        var from: String
        var date: String
        var subject: String
        var text: String
        var html: String?
    }

    /// A file going with the message: picked here, or one of a message's files, uploaded when it's first needed.
    struct Piece: Hashable, Identifiable {
        var id = UUID()
        var name: String
        var type: String
        var size: Int
        var data: Data?
        /// One of a stored message's files, opened only when it's sent.
        var source: Message?
        var index = 0
        var upload: String?
    }

    var title: String {
        switch kind {
        case nil: subject.isEmpty ? "New message" : subject
        case .reply: person.isEmpty ? "Reply" : "Reply to \(person)"
        case .replyAll: "Reply all"
        case .forward: "Forward"
        }
    }

    /// What goes out: the text, the quote under it, and a forward's original after it.
    var text: String {
        guard let f = forwarded else { return body + quote }
        return body + "\n\n---------- Forwarded message ----------\nFrom: \(f.from)\nDate: \(f.date)\nSubject: \(f.subject)\n\n\(f.text)"
    }

    /// A forward goes out with the original's formatting too: what was written, then the original as it looked.
    var html: String? {
        guard let f = forwarded, let original = f.html else { return nil }
        let escape = { (s: String) in
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        let written = escape(body).replacingOccurrences(of: "\n", with: "<br>")
        return """
        <div>\(written)</div><br><div>---------- Forwarded message ----------<br>From: \(escape(f.from))<br>Date: \(escape(f.date))<br>\
        Subject: \(escape(f.subject))</div><br>\(original)
        """
    }

    /// Starts an answer to a conversation, carrying on with a reply already saved there.
    static func start(_ kind: Answering.Kind, thread: String) async -> Draft? {
        if kind != .forward, let saved = try? await Store.db.read({ db in
            try Message.filter(sql: "threadId = ? AND mailboxId IN (SELECT id FROM mailbox WHERE role = 'drafts')", arguments: [thread])
                .order(Column("sentAt").desc).fetchOne(db)
        }) {
            var draft = await resume(saved)
            // Reply all on a saved reply adds whoever it left out.
            if kind == .replyAll, let fresh = await answer(.replyAll, thread: thread) {
                draft.kind = .replyAll
                draft.cc = draft.cc + fresh.cc.filter { c in !(draft.to + draft.cc).contains { $0.caseInsensitiveCompare(c) == .orderedSame } }
                draft.to = draft.to + fresh.to.filter { t in !draft.to.contains { $0.caseInsensitiveCompare(t) == .orderedSame } }
            }
            return draft
        }
        return await answer(kind, thread: thread)
    }

    /// Answers the newest message of a conversation.
    static func answer(_ kind: Answering.Kind, thread: String) async -> Draft? {
        let found = try? await Store.db.read { db in (try sent(thread).fetchAll(db), try Account.fetchAll(db)) }
        guard let (messages, accounts) = found, let newest = messages.last else { return nil }
        let html = await Html.load(newest)
        let text = html.map(Html.text) ?? newest.snippet
        let sender = newest.fromName.isEmpty ? newest.fromAddr : "\(newest.fromName) <\(newest.fromAddr)>"
        let date = newest.sentAt.formatted(date: .abbreviated, time: .shortened)
        let original = Answering.Original(from: newest.fromAddr, replyTo: newest.replyTo, to: newest.to, cc: newest.cc)
        let (to, cc) = Answering.addresses(kind, original, mine: Set(accounts.map { $0.email.lowercased() }))
        var draft = Draft(
            accountId: newest.accountId, kind: kind, thread: thread, to: to, cc: cc, subject: Answering.subject(kind, newest.subject),
            person: newest.ours(accounts) ? to.first ?? "" : newest.sender
        )
        if kind == .forward {
            draft.forwarded = Forwarded(from: sender, date: date, subject: newest.subject, text: text, html: html)
            draft.files = newest.files.enumerated().map { i, f in Piece(name: f.name, type: f.type, size: f.size, source: newest, index: i) }
        } else {
            draft.quote = "\n\nOn \(date), \(sender) wrote:\n"
                + text.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
            draft.inReplyTo = newest.messageId.isEmpty ? nil : newest.messageId
            draft.references = Answering.references(messages.map(\.messageId))
        }
        return draft
    }

    /// Continues a draft saved in the Drafts folder, with its files.
    static func resume(_ m: Message) async -> Draft {
        let earlier = try? await Store.db.read { db in try sent(m.threadId).fetchAll(db) }
        let parent = earlier?.last
        return Draft(
            draftId: m.draftId ?? UUID().uuidString.lowercased(), accountId: m.accountId, kind: parent == nil ? nil : .reply,
            thread: parent == nil ? nil : m.threadId, to: m.to, cc: m.cc, subject: m.subject,
            body: await Html.load(m).map(Html.text) ?? "",
            files: m.files.enumerated().map { i, f in Piece(name: f.name, type: f.type, size: f.size, source: m, index: i) },
            inReplyTo: parent.flatMap { $0.messageId.isEmpty ? nil : $0.messageId },
            references: Answering.references((earlier ?? []).map(\.messageId)), person: parent?.sender ?? "", saved: true
        )
    }

    /// A new message from a mailto: link, with what it asks for.
    static func mailto(_ url: URL, accountId: String?) -> Draft {
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let q = Dictionary((parts?.queryItems ?? []).map { ($0.name.lowercased(), $0.value ?? "") }) { a, _ in a }
        let list = { (s: String?) in (s ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        return Draft(
            accountId: accountId, to: list(parts?.path.removingPercentEncoding), cc: list(q["cc"]), bcc: list(q["bcc"]),
            subject: q["subject"] ?? "", body: q["body"] ?? ""
        )
    }

    /// The account last used to write to someone, from the newest mail in the Sent folders.
    static func lastUsed(_ db: GRDB.Database, to address: String) throws -> String? {
        try Message.filter(
            sql: "mailboxId IN (SELECT id FROM mailbox WHERE role = 'sent') AND EXISTS (SELECT 1 FROM json_each(\"to\") WHERE lower(value) = lower(?))",
            arguments: [address]
        )
        .order(Column("sentAt").desc).fetchOne(db)?.accountId
    }

    /// Uploads what isn't yet, a message's files opened first, and returns them as the API takes them.
    mutating func uploaded(_ accountId: String) async throws -> [(id: String, name: String, type: String)] {
        let client = API.client
        for i in files.indices where files[i].upload == nil {
            var data = files[i].data
            if data == nil, let m = files[i].source {
                let res = try await client.getAttachment(path: .init(accountId: m.accountId, messageId: m.id, index: files[i].index))
                guard case .ok(let ok) = res else { throw AuthError(errorDescription: "Couldn't attach “\(files[i].name)”. Check the connection and try again.") }
                let sealed = try await Data(collecting: ok.body.binary, upTo: 30 << 20)
                data = try Crypto.decrypt(m.open(), "att/\(files[i].index)", sealed)
            }
            guard let data else { throw AuthError(errorDescription: "Couldn't attach “\(files[i].name)”. Check the connection and try again.") }
            let res = try await client.uploadFile(
                path: .init(accountId: accountId),
                body: .multipartForm([.file(.init(payload: .init(body: HTTPBody(data)), filename: files[i].name))])
            )
            guard case .created(let created) = res else { throw AuthError(errorDescription: "Couldn't attach “\(files[i].name)”. Check the connection and try again.") }
            files[i].upload = try created.body.json.id
        }
        return files.map { ($0.upload ?? "", $0.name, $0.type) }
    }


    // A conversation's messages without its saved drafts, oldest first.
    private static func sent(_ thread: String) -> QueryInterfaceRequest<Message> {
        Message.filter(sql: "threadId = ? AND mailboxId NOT IN (SELECT id FROM mailbox WHERE role = 'drafts')", arguments: [thread])
            .order(Column("sentAt"))
    }
}
