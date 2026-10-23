// SPDX-License-Identifier: AGPL-3.0-only
import GRDB
import OpenAPIRuntime
import SwiftUI
import UniformTypeIdentifiers

/// What a composer window starts with: empty, a reply or forward with the earlier mail quoted under the text, or a
/// saved draft to continue.
struct Draft: Hashable {
    var draftId = UUID().uuidString.lowercased()
    var accountId: String?
    var to: [String] = []
    var cc: [String] = []
    var subject = ""
    var body = ""
    var quote = ""
    var inReplyTo: String?
    /// It's in the Drafts folder: it has its signature already, and discarding it deletes it there.
    var saved = false

    enum Answer { case reply, replyAll, forward }

    /// Answers the newest message of a conversation. When that's one of ours, a reply goes to whoever it went to.
    static func answer(_ kind: Answer, thread: String) async -> Draft? {
        let found = try? await Store.db.read { db in (try sent(thread).fetchAll(db).last, try Account.fetchAll(db)) }
        guard let (newest, accounts) = found, let newest else { return nil }
        let text = await Html.load(newest).map(Html.text) ?? newest.snippet
        let sender = newest.fromName.isEmpty ? newest.fromAddr : "\(newest.fromName) <\(newest.fromAddr)>"
        let date = newest.sentAt.formatted(date: .abbreviated, time: .shortened)
        if kind == .forward {
            return Draft(
                accountId: newest.accountId, subject: prefixed("Fwd:", newest.subject),
                quote: "\n\n---------- Forwarded message ----------\nFrom: \(sender)\nDate: \(date)\nSubject: \(newest.subject)\n\n\(text)"
            )
        }
        return Draft(
            accountId: newest.accountId,
            to: kind == .replyAll ? newest.others(accounts) : newest.ours(accounts) ? newest.to : [newest.fromAddr],
            subject: prefixed("Re:", newest.subject),
            quote: "\n\nOn \(date), \(sender) wrote:\n" + text.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n"),
            inReplyTo: newest.messageId.isEmpty ? nil : newest.messageId
        )
    }

    /// Continues a draft saved in the Drafts folder.
    static func resume(_ m: Message) async -> Draft {
        let earlier = try? await Store.db.read { db in try sent(m.threadId).reversed().fetchOne(db) }
        return Draft(
            draftId: m.draftId ?? UUID().uuidString.lowercased(), accountId: m.accountId, to: m.to, cc: m.cc,
            subject: m.subject, body: await Html.load(m).map(Html.text) ?? "", inReplyTo: earlier.flatMap { $0.messageId.isEmpty ? nil : $0.messageId }, saved: true
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

    // A conversation's messages without its saved drafts, oldest first.
    private static func sent(_ thread: String) -> QueryInterfaceRequest<Message> {
        Message.filter(sql: "threadId = ? AND mailboxId NOT IN (SELECT id FROM mailbox WHERE role = 'drafts')", arguments: [thread])
            .order(Column("sentAt"))
    }

    private static func prefixed(_ prefix: String, _ subject: String) -> String {
        subject.lowercased().hasPrefix(prefix.lowercased()) ? subject : "\(prefix) \(subject)"
    }
}

/// Writing a message. A new one docks in the window's bottom right, leaves the inbox usable and folds down to its
/// title; a reply takes the reply bar's place, starts in the text and keeps recipients and subject on one line until
/// clicked. On a phone both come up as a sheet. Closing keeps it as a draft, sending leaves a short window to undo.
struct Composer: View {
    enum Placement { case dock, reply, sheet }

    let placement: Placement
    @Environment(Mail.self) private var mail
    @State private var draft = Draft()
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var copies = false
    @State private var fields = false
    @State private var files: [File] = []
    @State private var picking = false
    @State private var scheduling = false
    @State private var folded = false
    @State private var showQuote = false
    @State private var error: String?
    @State private var phase = Phase.writing
    @State private var stored: [String] = []
    @State private var leaving = false
    /// A new message goes out from the account last used with its first recipient, until one is picked.
    @State private var autoFrom = false
    /// A save on its way to the server; discarding waits for it, or the save would land after the discard.
    @State private var saving: Task<Void, Never>?
    @FocusState private var focus: Field?

    enum Field { case to, cc, bcc, subject, body }
    private enum Phase: Equatable { case writing, undo(Task<Void, Never>), sending }

    // Read when attached: at most 25 MB each, which the server takes.
    private struct File: Identifiable {
        let id = UUID()
        let name: String
        let type: String
        let data: Data
    }

    var body: some View {
        Group {
            if placement == .sheet { sheet } else { card }
        }
        .font(.md)
        .textFieldStyle(.plain)
        .dropDestination(for: URL.self) { urls, _ in
            attach(urls)
            return true
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { attach(urls) }
        }
        .onEscape { close() }
        .task { setUp() }
        .task(id: recipients(to).first) {
            guard autoFrom, let first = recipients(to).first,
                  let id = try? await Store.db.read({ try Draft.lastUsed($0, to: first) }), mail.accountList.contains(where: { $0.id == id })
            else { return }
            draft.accountId = id
        }
        // Saved as a draft two seconds after typing stops, and once more when it closes.
        .task(id: snapshot) {
            guard (try? await Task.sleep(for: .seconds(2))) != nil else { return }
            await save()
        }
        .onDisappear { Task { await save() } }
    }

    private var card: some View {
        VStack(spacing: 0) {
            if placement == .dock { header }
            if !folded {
                if placement == .dock || fields {
                    addressing
                } else {
                    summary
                }
                if !files.isEmpty { attachments }
                editor
                if !draft.quote.isEmpty { quote }
                if let error { failure(error) }
                Rectangle().fill(.line).frame(height: 1)
                actions
            }
        }
        .frame(width: placement == .dock ? 512 : nil, height: placement == .dock ? (folded ? 44 : 480) : nil)
        .frame(maxWidth: placement == .reply ? 760 : nil)
        .background(.raised)
        .clipShape(shape)
        .overlay(shape.stroke(.line))
        .shadow(color: Color.ink.opacity(0.1), radius: 16, y: 6)
    }

    // A phone writes full height: Close and Send in the bar, holding Send offers to send later.
    private var sheet: some View {
        NavigationStack {
            VStack(spacing: 0) {
                addressing
                if !files.isEmpty { attachments }
                editor
                if !draft.quote.isEmpty { quote }
                if let error { failure(error) }
            }
            .background(.paper)
            .navigationTitle(draft.inReplyTo == nil ? "New message" : "Reply")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") {
                        if stored == snapshot && !draft.saved { close() } else { leaving = true }
                    }
                    .confirmationDialog("Keep this message as a draft?", isPresented: $leaving) {
                        Button("Delete draft", role: .destructive) { Task { await discard() } }
                        Button("Keep draft") { close() }
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Attach files", systemImage: "paperclip") { picking = true }
                }
                ToolbarItem(placement: .confirmationAction) { sendButton }
            }
            .sheet(isPresented: $scheduling) {
                WhenPicker(action: "Schedule", pick: schedule)
                .presentationDetents([.medium])
            }
        }
        .interactiveDismissDisabled(phase != .writing)
    }

    private var sendButton: some View {
        SendButton(undoing: undoing, seconds: mail.prefs.undoSend) {
            if case .undo(let task) = phase {
                task.cancel()
                phase = .writing
            } else {
                send()
            }
        }
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(phase == .sending || recipients(to).isEmpty || !Recipients.valid(to, cc, bcc))
        .contextMenu {
            Button("Send later…", systemImage: "clock") { scheduling = true }
        }
    }

    @ViewBuilder private var addressing: some View {
        if mail.accountList.count > 1 { from }
        row("To") {
            Recipients(label: "To", text: $to, focus: $focus, field: .to) { next(.to) }
            if !copies {
                Button("Cc") { copies = true }.buttonStyle(QuietButtonStyle())
                Button("Bcc") { copies = true }.buttonStyle(QuietButtonStyle())
            }
        }
        // Suggestions open below a field, over the rows that follow.
        .zIndex(3)
        if copies {
            row("Cc") { Recipients(label: "Cc", text: $cc, focus: $focus, field: .cc) { next(.cc) } }
                .zIndex(2)
            row("Bcc") { Recipients(label: "Bcc", text: $bcc, focus: $focus, field: .bcc) { next(.bcc) } }
                .zIndex(1)
        }
        row(nil) {
            TextField("Subject", text: $draft.subject, prompt: Text("Subject").foregroundStyle(.faint))
                .focused($focus, equals: .subject).submitLabel(.next)
                .onKeyPress(.tab) { next(.subject) }.onSubmit { _ = next(.subject) }
        }
    }

    private func failure(_ error: String) -> some View {
        Text(error).font(.sm).foregroundStyle(.danger).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.bottom, 8)
    }

    // Docked, it sits on the window's bottom edge.
    private var shape: UnevenRoundedRectangle {
        let bottom = placement == .dock ? 0 : Radius.lg
        return UnevenRoundedRectangle(topLeadingRadius: Radius.lg, bottomLeadingRadius: bottom, bottomTrailingRadius: bottom, topTrailingRadius: Radius.lg)
    }

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                Text(draft.subject.isEmpty ? "New message" : draft.subject).font(.md.weight(.medium)).lineLimit(1)
                Spacer()
                IconButton(label: folded ? "Open" : "Fold down", symbol: "chevron.up.chevron.down") { withAnimation(.quick) { folded.toggle() } }
                IconButton(label: "Close, keeps a draft", symbol: "xmark", key: "Esc") { close() }
            }
            .padding(.leading, 12).padding(.trailing, 6)
            .frame(height: 44)
            .contentShape(.rect)
            .onTapGesture { if folded { withAnimation(.quick) { folded = false } } }
            if !folded { Rectangle().fill(.line).frame(height: 1) }
        }
    }

    private var from: some View {
        row(nil) {
            Menu {
                ForEach(mail.accountList, id: \.id) { a in
                    Button(a.email) {
                        autoFrom = false
                        draft.accountId = a.id
                    }
                }
            } label: {
                Text("From \(mail.accountList.first { $0.id == draft.accountId }?.email ?? "")").font(.sm).foregroundStyle(.muted)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        }
    }

    // A reply keeps who it goes to and its subject on one line until clicked.
    private var summary: some View {
        HStack(spacing: 6) {
            Image(systemName: draft.inReplyTo == nil ? "arrowshape.turn.up.right" : "arrowshape.turn.up.left").font(.sm).foregroundStyle(.muted)
            Text(to.isEmpty ? "Add recipients" : to).foregroundStyle(.ink).lineLimit(1)
            Text(draft.subject).foregroundStyle(.muted).lineLimit(1)
            Spacer()
            IconButton(label: "Close, keeps a draft", symbol: "xmark", key: "Esc") { close() }
        }
        .padding(.leading, 12).padding(.trailing, 6)
        .frame(height: 44)
        .contentShape(.rect)
        .onTapGesture { withAnimation(.quick) { fields = true } }
        .overlay(alignment: .bottom) { Rectangle().fill(.line).frame(height: 1) }
    }

    private func row<Content: View>(_ label: String?, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8) {
            if let label { Text(label).font(.sm).foregroundStyle(.muted).frame(minWidth: 28, alignment: .leading) }
            content()
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .overlay(alignment: .bottom) { Rectangle().fill(.line).frame(height: 1) }
    }

    private var attachments: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(files) { f in
                    HStack(spacing: 6) {
                        Image(systemName: "paperclip").font(.xs)
                        Text(f.name).lineLimit(1)
                        Text(f.data.count.formatted(.byteCount(style: .file))).foregroundStyle(.muted)
                        Button("Remove \(f.name)", systemImage: "xmark") { files.removeAll { $0.id == f.id } }
                            .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(.muted)
                    }
                    .font(.sm)
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(.sunken, in: .rect(cornerRadius: Radius.md))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
    }

    private var editor: some View {
        TextEditor(text: $draft.body)
            .focused($focus, equals: .body)
            .font(.md)
            .lineSpacing(3)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, 7).padding(.vertical, 10)
            .frame(height: placement == .reply ? 140 : nil)
            .frame(maxHeight: placement == .reply ? nil : .infinity)
            .overlay(alignment: .topLeading) {
                if draft.body.isEmpty {
                    Text("Write something").foregroundStyle(.faint).padding(.horizontal, 12).padding(.vertical, 10).allowsHitTesting(false)
                }
            }
    }

    // The quoted message waits behind "•••".
    private var quote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button("•••") { withAnimation(.quick) { showQuote.toggle() } }
                .buttonStyle(QuietButtonStyle())
                .help(showQuote ? "Hide quoted text" : "Show quoted text")
            if showQuote {
                ScrollView {
                    Text(draft.quote.trimmingCharacters(in: .newlines)).font(.sm).foregroundStyle(.muted).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8).padding(.bottom, 8)
    }

    private var actions: some View {
        HStack(spacing: 4) {
            sendButton
            IconButton(label: "Send later", symbol: "clock") { scheduling = true }
                .disabled(recipients(to).isEmpty)
                .popover(isPresented: $scheduling) {
                    WhenPicker(action: "Schedule", pick: schedule)
                }
            IconButton(label: "Attach files", symbol: "paperclip") { picking = true }
            Spacer()
            HoldButton(title: "Discard", duration: 0.7) { Task { await discard() } }
        }
        .padding(.horizontal, 10)
        .frame(height: 52)
    }

    // Tab walks the fields of the composer and never leaves it for the list behind.
    private func next(_ field: Field) -> KeyPress.Result {
        let order: [Field] = copies ? [.to, .cc, .bcc, .subject, .body] : [.to, .subject, .body]
        if let i = order.firstIndex(of: field), order.indices.contains(i + 1) { focus = order[i + 1] }
        return .handled
    }

    private var undoing: Bool {
        if case .undo = phase { true } else { false }
    }

    private var snapshot: [String] { [draft.accountId ?? "", to, cc, bcc, draft.subject, draft.body] }

    private func setUp() {
        let start = switch placement {
        case .dock: mail.compose
        case .reply: mail.reply
        case .sheet: mail.compose ?? mail.reply
        }
        guard stored.isEmpty, let start else { return }
        draft = start
        autoFrom = !start.saved && start.inReplyTo == nil && start.quote.isEmpty && start.to.isEmpty
        if draft.accountId == nil { draft.accountId = mail.accountList.first?.id }
        // The signature goes above a quoted message, the way replies are written.
        if !draft.saved, let signature = mail.accountList.first(where: { $0.id == draft.accountId })?.signature, !signature.isEmpty {
            draft.body += "\n\n-- \n\(signature)"
        }
        to = draft.to.joined(separator: ", ")
        cc = draft.cc.joined(separator: ", ")
        copies = !cc.isEmpty
        stored = snapshot
        // After the view is in the window, or the list keeps the focus.
        Task { focus = draft.to.isEmpty ? .to : .body }
    }

    private func close() {
        Task { await save() }
        dismiss()
    }

    private func dismiss() {
        withAnimation(.quick) {
            switch placement {
            case .dock: mail.compose = nil
            case .reply: mail.reply = nil
            case .sheet:
                mail.compose = nil
                mail.reply = nil
            }
        }
    }

    private func attach(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            guard data.count <= 25 * 1024 * 1024 else {
                error = "“\(url.lastPathComponent)” is larger than 25 MB."
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            files.append(File(name: url.lastPathComponent, type: type, data: data))
        }
    }

    // Takes "Name <a@b.c>" and bare addresses, separated by commas, semicolons or spaces.
    private func recipients(_ field: String) -> [String] {
        field.split(whereSeparator: { ",;\n".contains($0) }).flatMap { part -> [String] in
            if let inner = part.firstMatch(of: /<([^>]+)>/) { return [String(inner.1)] }
            return part.split(separator: " ").map(String.init)
        }
        .filter { $0.contains("@") }
    }

    private func save() async {
        guard phase == .writing, !stored.isEmpty, snapshot != stored, let accountId = draft.accountId else { return }
        stored = snapshot
        draft.saved = true
        let body = Operations.saveDraft.Input.Body.jsonPayload(
            to: recipients(to), cc: recipients(cc), bcc: recipients(bcc), subject: draft.subject, text: draft.body + draft.quote,
            inReplyTo: draft.inReplyTo
        )
        let path = Operations.saveDraft.Input.Path(accountId: accountId, draftId: draft.draftId)
        let task = Task { _ = try? await API.client.saveDraft(path: path, body: .json(body)) }
        saving = task
        await task.value
    }

    // Sending waits out the undo window first, then goes.
    private func schedule(_ date: Date) {
        scheduling = false
        Task { await Background.keepAlive { await deliver(at: date) } }
    }

    private func send() {
        guard mail.prefs.undoSend > 0 else {
            Task { await Background.keepAlive { await deliver() } }
            return
        }
        let seconds = mail.prefs.undoSend
        phase = .undo(Task {
            await Background.keepAlive {
                guard (try? await Task.sleep(for: .seconds(seconds))) != nil else { return }
                await deliver()
            }
        })
    }

    private func deliver(at sendAt: Date? = nil) async {
        guard let accountId = draft.accountId else { return }
        phase = .sending
        let client = API.client
        var uploads: [Operations.sendMessage.Input.Body.jsonPayload.attachmentsPayloadPayload] = []
        for f in files {
            let res = try? await client.uploadFile(
                path: .init(accountId: accountId),
                body: .multipartForm([.file(.init(payload: .init(body: HTTPBody(f.data)), filename: f.name))])
            )
            guard case .created(let created) = res, let id = try? created.body.json.id else {
                error = "Couldn't upload “\(f.name)”. Try again."
                phase = .writing
                return
            }
            uploads.append(.init(id: id, name: f.name, _type: f.type))
        }
        let res = try? await client.sendMessage(
            path: .init(accountId: accountId),
            body: .json(.init(
                to: recipients(to), cc: recipients(cc), bcc: recipients(bcc), subject: draft.subject, text: draft.body + draft.quote,
                inReplyTo: draft.inReplyTo, draftId: draft.draftId, sendAt: sendAt, attachments: uploads.isEmpty ? nil : uploads
            ))
        )
        guard case .accepted = res else {
            error = "Couldn't send. Check the recipients and try again."
            phase = .writing
            return
        }
        if let sendAt { mail.toast("Scheduled for \(sendAt.when)") }
        dismiss()
    }

    private func discard() async {
        phase = .sending
        await saving?.value
        if let accountId = draft.accountId, draft.saved {
            _ = try? await API.client.discardDraft(path: .init(accountId: accountId, draftId: draft.draftId))
        }
        dismiss()
    }
}

/// Send, then for a few seconds Undo, its outline draining while the window to take it back runs out.
private struct SendButton: View {
    let undoing: Bool
    let seconds: Int
    let action: () -> Void
    @State private var left: CGFloat = 1

    var body: some View {
        Button(action: action) {
            Text(undoing ? "Undo" : "Send").frame(width: 84)
        }
        .glassButton(prominent: true)
        .overlay {
            if undoing {
                Capsule().trim(from: 0, to: left).stroke(Color.onInk.opacity(0.6), lineWidth: 2)
                    .padding(2).allowsHitTesting(false)
            }
        }
        .onChange(of: undoing) { _, undoing in
            left = 1
            if undoing { withAnimation(.linear(duration: Double(seconds))) { left = 0 } }
        }
    }
}

extension View {
    /// Addresses: no capitals, no corrections, the keyboard with @.
    func address() -> some View {
        #if os(iOS)
        keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.next)
        #else
        self
        #endif
    }
}

/// Addresses as chips: Enter, a comma or leaving the field makes one, Backspace in an empty field takes the last one
/// back, and typing suggests people from mail that's already here. It all stays one comma-separated text, whatever is
/// being typed included, so sending and drafts see it too.
struct Recipients: View {
    let label: String
    @Binding var text: String
    var focus: FocusState<Composer.Field?>.Binding
    let field: Composer.Field
    let next: () -> KeyPress.Result
    @State private var people: [Person] = []
    @State private var highlighted = 0
    /// What's in the field, after an invisible mark: the text field keeps Backspace to itself, so an empty field
    /// losing the mark is how Backspace there shows. It becomes chips after the keystroke, which the field takes in.
    @State private var entry = Self.mark
    private static let mark = "\u{200B}"

    private var focused: Bool { focus.wrappedValue == field }
    private var parts: [String] { text.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
    // While typing, the last part is the text in the field; otherwise every part is a chip.
    private var chips: [String] { (focused ? parts.dropLast() : parts[...]).filter { !$0.isEmpty } }

    /// A bare address or "Name <address>".
    static func valid(_ chip: String) -> Bool {
        let address = chip.firstMatch(of: /<([^>]+)>/).map { String($0.1) } ?? chip
        return address.wholeMatch(of: /[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+/) != nil
    }

    /// Every chip in these fields is an address.
    static func valid(_ fields: String...) -> Bool {
        fields.allSatisfy { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.allSatisfy(valid) }
    }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(Array(chips.enumerated()), id: \.offset) { i, chip in
                    HStack(spacing: 4) {
                        Text(chip).font(.sm).foregroundStyle(Self.valid(chip) ? Color.ink : .danger)
                        Button("Remove \(chip)", systemImage: "xmark") { remove(i) }
                            .labelStyle(.iconOnly).buttonStyle(.plain).font(.system(size: 9, weight: .semibold)).foregroundStyle(.muted)
                    }
                    .padding(.horizontal, 8).frame(height: 24)
                    .background(Self.valid(chip) ? Color.hover : Color.danger.opacity(0.12), in: .capsule)
                }
                TextField(label, text: $entry, prompt: Text(""))
                    .focused(focus, equals: field)
                    .address()
                    .frame(minWidth: 140)
                    .onSubmit { commit(people.indices.contains(highlighted) ? people[highlighted] : nil) }
                    .onKeyPress(.tab) {
                        commit()
                        return next()
                    }
                    .onKeyPress(.downArrow) { move(1) }
                    .onKeyPress(.upArrow) { move(-1) }
                    .onKeyPress(.escape) {
                        guard !people.isEmpty else { return .ignored }
                        people = []
                        return .handled
                    }
            }
        }
        .scrollIndicators(.hidden)
        .task(id: focused ? typed : nil) { await suggest() }
        .onChange(of: entry) { old, new in
            let now = new.replacingOccurrences(of: Self.mark, with: "")
            if new.isEmpty, old == Self.mark, !chips.isEmpty {
                remove(chips.count - 1)
            } else if now.contains(",") || now.contains(";") {
                let parts = now.split(whereSeparator: { ",;".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                set(chips + parts, typing: "")
            } else {
                set(chips, typing: now)
            }
        }
        .onChange(of: focused) { _, now in
            // Coming in, what's there becomes chips; leaving, the last bit typed becomes one too.
            let filled = parts.filter { !$0.isEmpty }
            if now { set(filled, typing: "") } else { text = filled.joined(separator: ", ") }
        }
        .overlay(alignment: .topLeading) {
            if focused, !people.isEmpty { suggestions.offset(y: 34) }
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(people.enumerated()), id: \.element) { i, p in suggestion(p, lit: i == highlighted) }
        }
        .padding(4)
        .frame(width: 280)
        .background(.raised, in: .rect(cornerRadius: Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).stroke(.line))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    private func suggestion(_ p: Person, lit: Bool) -> some View {
        Button { commit(p) } label: {
            VStack(alignment: .leading, spacing: 1) {
                Text(p.name.isEmpty ? p.address : p.name).font(.sm).foregroundStyle(.ink)
                if !p.name.isEmpty { Text(p.address).font(.xs).foregroundStyle(.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(lit ? Color.hover : .clear, in: .rect(cornerRadius: Radius.md))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func move(_ step: Int) -> KeyPress.Result {
        guard !people.isEmpty else { return .ignored }
        highlighted = (highlighted + step + people.count) % people.count
        return .handled
    }

    private var typed: String { entry.replacingOccurrences(of: Self.mark, with: "") }

    private func set(_ chips: [String], typing: String) {
        text = (chips + [typing]).joined(separator: ", ")
        if entry != Self.mark + typing { entry = Self.mark + typing }
    }

    private func commit(_ person: Person? = nil) {
        let typed = typed.trimmingCharacters(in: .whitespaces)
        set(chips + [person?.address ?? typed].filter { !$0.isEmpty }, typing: "")
        people = []
    }

    private func remove(_ i: Int) {
        var rest = chips
        rest.remove(at: i)
        set(rest, typing: focused ? typed : "")
    }

    // Up to five, leaving out who's in already.
    private func suggest() async {
        let query = focused ? typed : ""
        guard !query.isEmpty, (try? await Task.sleep(for: .milliseconds(80))) != nil else { return people = [] }
        let taken = Set(chips.map { $0.lowercased() })
        let found = await Store.people(matching: query, limit: 10)
        people = Array(found.filter { !taken.contains($0.address.lowercased()) }.prefix(5))
        highlighted = 0
    }
}
