// SPDX-License-Identifier: AGPL-3.0-only
import GRDB
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// One conversation, pushed over its list with its actions in the toolbar; the newest message is open, earlier ones
/// fold away unless unread. Replies go out from a bar floating at the bottom.
struct ThreadView: View {
    let threadId: String
    @Environment(Mail.self) private var mail
    @Environment(\.compact) private var compact
    @State private var messages: [Message] = []
    @State private var drafts: Set<String> = []
    @State private var open: Set<String> = []
    @State private var unfolded = false
    @State private var snoozing = false
    @State private var preview: URL?
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // A phone's title bar has no room for a subject.
                if compact {
                    Text(subject).font(.xl).foregroundStyle(.ink).textSelection(.enabled)
                        .padding(.horizontal, inset).padding(.top, 4).padding(.bottom, 8)
                }
                ForEach(shown, id: \.self) { item in
                    switch item {
                    case .message(let m):
                        if open.contains(m.id) { expanded(m) } else { collapsed(m) }
                    case .fold(let count):
                        Button { withAnimation(.quick) { unfolded = true } } label: {
                            Text("\(count) earlier messages").font(.sm).foregroundStyle(.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, inset).frame(height: 40).contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        Rectangle().fill(.line).frame(height: 1).padding(.horizontal, 12)
                    }
                }
            }
            // Room for the reply bar over the end of the mail.
            .padding(.bottom, mail.reply == nil || Device.phone ? 96 : 360)
        }
        #if os(macOS)
        .scrollIndicators(.hidden)
        #endif
        .background(.paper)
        .navigationTitle(compact ? "" : subject)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { toolbar }
        .sheet(isPresented: Binding(get: { compact && snoozing }, set: { snoozing = $0 })) {
            WhenPicker(action: "Snooze", pick: snooze)
            .presentationDetents([.medium])
        }
        .overlay(alignment: .bottom) {
            // A phone writes the reply in a sheet over all of this.
            if mail.reply != nil, !Device.phone {
                Composer(placement: .reply).padding(.horizontal, 24).padding(.bottom, 16)
                    .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
            } else if let newest {
                let others = newest.others(mail.accountList)
                ReplyBar(
                    to: replyTo(newest), others: others, everyone: mail.prefs.replyDefault == "all" && others.count > 1,
                    resuming: saved != nil, write: answer
                )
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
        }
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onAppear { focused = true }
        .onKeyPress(phases: .down) { press in key(press) }
        .onEscape { back() }
        .quickLookPreview($preview)
        .task { await observe() }
        // "After 2 seconds": only what's still open then counts as read.
        .task {
            guard mail.prefs.markRead == "delay", (try? await Task.sleep(for: .seconds(2))) != nil else { return }
            mail.update(messages.filter { !$0.seen }, seen: true)
        }
    }

    private enum Item: Hashable {
        case message(Message)
        case fold(Int)
    }

    // The newest message and unread ones are open; three or more read ones before them fold into one row.
    private var shown: [Item] {
        let closed = messages.dropLast().filter { !open.contains($0.id) }
        guard !unfolded, closed.count >= 3 else { return messages.map(Item.message) }
        let folded = Set(closed.dropFirst().map(\.id))
        var items: [Item] = []
        for m in messages where !folded.contains(m.id) {
            items.append(.message(m))
            if m.id == closed.first?.id { items.append(.fold(folded.count)) }
        }
        return items
    }

    private var newest: Message? { messages.last { !drafts.contains($0.mailboxId) } }

    // A reply to one of our own messages goes to whoever it went to.
    private func replyTo(_ m: Message) -> String {
        m.ours(mail.accountList) ? m.to.joined(separator: ", ") : m.sender
    }

    private func from(_ m: Message) -> some View {
        HStack(spacing: 6) {
            Text(m.sender).font(.md.weight(.medium)).foregroundStyle(.ink)
            if drafts.contains(m.mailboxId) { Text("Draft").font(.sm).foregroundStyle(.danger) }
        }
    }

    private var subject: String { messages.last?.subject ?? "" }
    private var inset: CGFloat { compact ? 16 : 24 }
    private var draft: Message? { messages.last.flatMap { drafts.contains($0.mailboxId) ? $0 : nil } }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if compact {
            ToolbarItem {
                Button("Archive", systemImage: "archivebox") { leave { mail.update(inFolder, archive: true) } }
            }
            ToolbarItem {
                Menu("More", systemImage: "ellipsis") {
                    let starred = messages.contains(where: \.starred)
                    if let draft {
                        Button("Edit draft", systemImage: "pencil") { Task { mail.compose = await Draft.resume(draft) } }
                    }
                    Button(starred ? "Unstar" : "Star", systemImage: starred ? "star.slash" : "star") { mail.update(messages, starred: !starred) }
                    Button("Mark as unread", systemImage: "envelope.badge") {
                        mail.update(messages, seen: false)
                        back()
                    }
                    Button("Snooze…", systemImage: "clock") { snoozing = true }
                    Divider()
                    Button("Delete", systemImage: "trash", role: .destructive) { leave { mail.update(inFolder, trash: true) } }
                }
            }
        } else {
            wideToolbar
        }
    }

    @ToolbarContentBuilder private var wideToolbar: some ToolbarContent {
        if let draft {
            ToolbarItem {
                Button("Edit draft") { Task { mail.compose = await Draft.resume(draft) } }
            }
        }
        ToolbarItemGroup {
            let starred = messages.contains(where: \.starred)
            Button(starred ? "Unstar" : "Star", systemImage: starred ? "star.fill" : "star") {
                mail.update(messages, starred: !starred)
            }
            .help("\(starred ? "Unstar" : "Star") (S)")
            Button("Mark as unread", systemImage: "envelope.badge") {
                mail.update(messages, seen: false)
                back()
            }
            .help("Mark as unread (⇧U)")
            Button("Snooze", systemImage: "clock") { snoozing = true }
                .help("Snooze (H)")
                .popover(isPresented: Binding(get: { !compact && snoozing }, set: { snoozing = $0 })) {
                    WhenPicker(action: "Snooze", pick: snooze)
                }
        }
        ToolbarItemGroup {
            Button("Archive", systemImage: "archivebox") { leave { mail.update(inFolder, archive: true) } }.help("Archive (E)")
            Button("Delete", systemImage: "trash") { leave { mail.update(inFolder, trash: true) } }.help("Delete (#)")
        }
    }

    /// Archive, delete and snooze move what's in the folder being read, not the replies sitting in Sent.
    private var inFolder: [Message] {
        let here = messages.filter { m in
            switch mail.folder {
            case .role("sent"): true
            default: m.fromAddr.isEmpty || !m.ours(mail.accountList)
            }
        }
        return here.isEmpty ? messages : here
    }

    private func expanded(_ m: Message) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Avatar(name: m.sender)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        SenderName(message: m)
                        if drafts.contains(m.mailboxId) { Text("Draft").font(.sm).foregroundStyle(.danger) }
                    }
                    Text("to \(m.to.joined(separator: ", "))\(m.cc.isEmpty ? "" : " · cc \(m.cc.joined(separator: ", "))")")
                        .font(.sm).foregroundStyle(.muted).lineLimit(1)
                }
                Spacer()
                Text(m.sentAt.formatted(date: .abbreviated, time: .shortened)).font(.xs).foregroundStyle(.muted)
            }
            .contentShape(.rect)
            .onTapGesture { if m.id != messages.last?.id { withAnimation(.quick) { _ = open.remove(m.id) } } }
            MailBody(message: m)
            if !m.files.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 200, maximum: 260), spacing: 8, alignment: .leading)], alignment: .leading, spacing: 8) {
                    ForEach(Array(m.files.enumerated()), id: \.offset) { index, file in
                        AttachmentTile(message: m, index: index, file: file, preview: $preview)
                    }
                }
            }
        }
        .textSelection(.enabled)
        .padding(.horizontal, inset)
        .padding(.vertical, 20)
        .overlay(alignment: .bottom) { Rectangle().fill(.line).frame(height: 1).padding(.horizontal, 12) }
    }

    private func collapsed(_ m: Message) -> some View {
        Button { withAnimation(.quick) { _ = open.insert(m.id) } } label: {
            HStack(spacing: 12) {
                Avatar(name: m.sender)
                VStack(alignment: .leading, spacing: 2) {
                    from(m)
                    Text(m.snippet).font(.sm).foregroundStyle(.muted).lineLimit(1)
                }
                Spacer()
                Text(m.sentAt.mailDate).font(.xs).foregroundStyle(.muted)
            }
            .padding(.horizontal, inset)
            .padding(.vertical, 14)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { Rectangle().fill(.line).frame(height: 1).padding(.horizontal, 12) }
    }

    private func key(_ press: KeyPress) -> KeyPress.Result {
        // Letters typed into a reply are text, not shortcuts.
        guard mail.reply == nil, mail.compose == nil else { return .ignored }
        switch press.characters {
        case "e": leave { mail.update(inFolder, archive: true) }
        case "#": leave { mail.update(inFolder, trash: true) }
        case "s": mail.update(messages, starred: !messages.contains(where: \.starred))
        case "U":
            mail.update(messages, seen: false)
            back()
        case "h": snoozing = true
        case "r": answer(mail.prefs.replyDefault == "all" && (newest?.others(mail.accountList).count ?? 0) > 1 ? .replyAll : .reply)
        case "a": answer(.replyAll)
        case "f": answer(.forward)
        case "?": mail.shortcutsOpen = true
        default: return .ignored
        }
        return .handled
    }

    /// A reply already saved in this conversation, to carry on with.
    private var saved: Message? { messages.last { drafts.contains($0.mailboxId) } }

    private func answer(_ kind: Draft.Answer) {
        Task {
            let draft = if let saved, kind != .forward { await Draft.resume(saved) } else { await Draft.answer(kind, thread: threadId) }
            withAnimation(.quick) { mail.reply = draft }
        }
    }

    private func back() {
        mail.reply = nil
        mail.thread = nil
    }

    private func snooze(_ date: Date) {
        snoozing = false
        leave { mail.update(inFolder, snoozeUntil: date) }
    }

    // After archiving, deleting or snoozing: the conversation next to this one, or back to the list, as set.
    private func leave(_ change: () -> Void) {
        let order = mail.order
        let here = order.firstIndex(of: threadId)
        let step = ["next": 1, "previous": -1][mail.prefs.afterArchive]
        let neighbour = here.flatMap { i in step.flatMap { order.indices.contains(i + $0) ? order[i + $0] : nil } }
        change()
        mail.reply = nil
        mail.thread = neighbour
    }

    private func observe() async {
        let id = threadId
        var read = false
        var known = Set<String>()
        do {
            drafts = try await Store.db.read { try Set(String.fetchAll($0, sql: "SELECT id FROM mailbox WHERE role = 'drafts'")) }
            let thread = ValueObservation.tracking {
                try Message.filter(Column("threadId") == id).order(Column("sentAt")).fetchAll($0)
            }
            for try await value in thread.values(in: Store.db) {
                // The same mail can sit in two folders, like Sent and an inbox of another account.
                var ids = Set<String>()
                messages = value.filter { ids.insert($0.messageId.isEmpty ? $0.id : $0.messageId).inserted }
                if !read {
                    read = true
                    open = Set(messages.filter { !$0.seen }.map(\.id) + [messages.last?.id].compactMap { $0 })
                    if mail.prefs.markRead == "instant" { mail.update(value.filter { !$0.seen }, seen: true) }
                } else {
                    // What arrives while reading, a reply just sent included, comes in open.
                    open.formUnion(messages.map(\.id).filter { !known.contains($0) })
                }
                known = Set(messages.map(\.id))
            }
        } catch {}
    }
}

/// "Reply to Lena…" floating on glass at the bottom of a conversation, with Reply all and Forward next to it.
struct ReplyBar: View {
    let to: String
    let others: [String]
    /// R replies to everyone, as set.
    var everyone = false
    /// A reply is saved already and R carries on with it.
    var resuming = false
    let write: (Draft.Answer) -> Void

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                Button { write(everyone ? .replyAll : .reply) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: everyone ? "arrowshape.turn.up.left.2" : "arrowshape.turn.up.left").font(.sm).foregroundStyle(.muted)
                        Text(resuming ? "Continue your reply to \(to)…" : everyone ? "Reply to everyone…" : "Reply to \(to)…")
                            .lineLimit(1).font(.md).foregroundStyle(.muted)
                        Spacer()
                        if !Device.phone {
                            Text("R").font(.xs).foregroundStyle(.muted).frame(minWidth: 18, minHeight: 18)
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(.lineStrong))
                        }
                    }
                    .padding(.leading, 16).padding(.trailing, 12)
                    .frame(height: 44)
                    .contentShape(.capsule)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .capsule)
                if others.count > 1 {
                    if everyone {
                        Button("Reply", systemImage: "arrowshape.turn.up.left") { write(.reply) }.help("Reply to \(to)")
                    } else {
                        Button("Reply all", systemImage: "arrowshape.turn.up.left.2") { write(.replyAll) }.help("Reply all (A)")
                    }
                }
                Button("Forward", systemImage: "arrowshape.turn.up.right") { write(.forward) }.help("Forward (F)")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .controlSize(.extraLarge)
        }
        .frame(maxWidth: 640)
    }
}

/// The sender's name; hovering shows the address, a click copies it.
private struct SenderName: View {
    let message: Message
    @State private var hovered = false
    @State private var copied = false

    var body: some View {
        Button {
            Clipboard.copy(message.fromAddr)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Text(copied ? "Copied" : hovered ? message.fromAddr : message.sender)
                .font(.md.weight(.medium)).foregroundStyle(.ink).contentTransition(.opacity)
        }
        .buttonStyle(.plain)
        .onHover { over in withAnimation(.quick) { hovered = over } }
        .help("Copy \(message.fromAddr)")
    }
}

/// A file attached to a message. A click saves it (to Downloads on the Mac) and opens it in Quick Look.
struct AttachmentTile: View {
    let message: Message
    let index: Int
    let file: Attachment
    @Binding var preview: URL?
    @Environment(Mail.self) private var mail
    @State private var busy = false
    @State private var hovered = false

    var body: some View {
        Button { Task { await open() } } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(.muted).frame(width: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(file.name).font(.sm).foregroundStyle(.ink).lineLimit(1).truncationMode(.middle)
                    Text(busy ? "Downloading…" : file.size.formatted(.byteCount(style: .file))).font(.xs).foregroundStyle(.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 48)
            .background(hovered ? Color.hover : .clear, in: .rect(cornerRadius: Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).stroke(.line))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .onHover { hovered = $0 }
        .help("Save and preview \(file.name)")
    }

    private var symbol: String {
        guard let type = UTType(mimeType: file.type) else { return "doc" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .audiovisualContent) { return "film" }
        if type.conforms(to: .archive) { return "doc.zipper" }
        if type.conforms(to: .calendarEvent) { return "calendar" }
        return "doc"
    }

    private func open() async {
        busy = true
        defer { busy = false }
        let res = try? await API.client.getAttachment(path: .init(accountId: message.accountId, messageId: message.id, index: index))
        guard case .ok(let ok) = res, let data = try? await Data(collecting: ok.body.any, upTo: 100 << 20) else {
            return mail.toast("Couldn't download “\(file.name)”")
        }
        // On the Mac the file is meant to stay; on a phone the preview shares it from a temporary copy.
        #if os(macOS)
        let dir = URL.downloadsDirectory
        #else
        let dir = URL.temporaryDirectory
        #endif
        let name = file.name.replacingOccurrences(of: "/", with: "-")
        var url = dir.appending(path: name)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appending(path: "\((name as NSString).deletingPathExtension) \(n).\((name as NSString).pathExtension)")
            n += 1
        }
        do {
            try data.write(to: url)
            preview = url
        } catch {
            mail.toast("Couldn't save “\(file.name)”")
        }
    }
}
