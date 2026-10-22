// SPDX-License-Identifier: AGPL-3.0-only
import GRDB
import SwiftUI

/// A folder or search as one dense list, a row per conversation. On iOS it's a native list: swipe left to archive,
/// right to snooze, pull to catch up, Select to act on several.
struct MailList: View {
    @Environment(Mail.self) private var mail
    @Environment(\.compact) private var compact
    @Binding var query: String
    var searching: FocusState<Bool>.Binding
    @State private var conversations: [Conversation] = []
    /// The row the keyboard is on.
    @State private var cursor: String?
    /// Like focus-visible on the web: the cursor only shows once the keyboard moved it.
    @State private var keyboard = false
    @State private var snoozing: String?
    /// Too narrow for one line per row, like an iPad held upright: rows stack the way they do on a phone.
    @State private var narrow = false
    @FocusState private var focused: Bool
    #if os(iOS)
    @State private var selection = Set<String>()
    @State private var editMode = EditMode.inactive
    #endif

    var body: some View {
        ScrollViewReader { scroll in
            rows
                .environment(\.compact, compact || narrow)
                .onGeometryChange(for: Bool.self) { $0.size.width < 600 } action: { narrow = $0 }
                .navigationTitle(query.isEmpty ? mail.folder.name : "Search")
                .overlay {
                    if conversations.isEmpty {
                        Text(query.isEmpty ? "Nothing here" : "No mail matches").font(.md).foregroundStyle(.muted)
                    }
                }
                .focusable()
                .focusEffectDisabled()
                .focused($focused)
                .onAppear { focused = true }
                .onKeyPress(phases: .down) { press in key(press, scroll) }
        }
        .searchable(text: $query, prompt: "Search mail")
        .searchFocused(searching)
        .task(id: [AnyHashable(mail.folder), AnyHashable(mail.account), AnyHashable(query)]) { await observe() }
        #if os(iOS)
        .toolbar { toolbar }
        .sheet(isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } })) {
            WhenPicker(action: "Snooze") { date in
                if let c = conversations.first(where: { $0.id == snoozing }) { act(c) { mail.update(c.messages, snoozeUntil: date) } }
                snoozing = nil
            }
            .presentationDetents([.medium])
        }
        #endif
    }

    private var outgoing: Bool { [.role("sent"), .role("drafts")].contains(mail.folder) }

    #if os(macOS)
    private var rows: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(conversations) { c in
                    ConversationRow(conversation: c, outgoing: outgoing, cursor: keyboard && cursor == c.id,
                        snoozing: Binding(get: { snoozing == c.id }, set: { snoozing = $0 ? c.id : nil }))
                        .id(c.id)
                        .onTapGesture {
                            keyboard = false
                            open(c)
                        }
                        .contextMenu { menu(c) }
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { open(c) }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .scrollIndicators(.hidden)
        .background(.paper)
    }
    #else
    private var rows: some View {
        List(selection: $selection) {
            ForEach(conversations) { c in
                // Snoozing from a row, its hover button or a key, comes up as one sheet here.
                ConversationRow(conversation: c, outgoing: outgoing, cursor: keyboard && cursor == c.id,
                    snoozing: Binding(get: { false }, set: { if $0 { snoozing = c.id } }))
                    .contentShape(.rect)
                    .onTapGesture {
                        keyboard = false
                        open(c)
                    }
                    // While selecting, a tap belongs to the list and ticks the row.
                    .allowsHitTesting(!editMode.isEditing)
                    .listRowInsets(EdgeInsets(top: 0, leading: compact || narrow ? 4 : 12, bottom: 0, trailing: compact || narrow ? 16 : 12))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.paper)
                    .swipeActions(edge: .trailing) {
                        Button("Archive", systemImage: "archivebox") { act(c) { mail.update(c.messages, archive: true) } }.tint(.positive)
                    }
                    .swipeActions(edge: .leading) {
                        Button("Snooze", systemImage: "clock") { snoozing = c.id }.tint(.muted)
                    }
                    .contextMenu { menu(c) }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { open(c) }
                    .id(c.id)
                    .tag(c.id)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(.paper)
        .environment(\.editMode, $editMode)
        .refreshable { await mail.refresh() }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button(editMode.isEditing ? "Done" : "Select") {
                withAnimation(.quick) {
                    editMode = editMode.isEditing ? .inactive : .active
                    selection = []
                }
            }
            .disabled(conversations.isEmpty && !editMode.isEditing)
        }
        if editMode.isEditing {
            ToolbarItemGroup(placement: .bottomBar) {
                let picked = conversations.filter { selection.contains($0.id) }.flatMap(\.messages)
                Button("Archive", systemImage: "archivebox") { bulk { mail.update(picked, archive: true) } }
                Spacer()
                Button("Mark as read", systemImage: "envelope.open") { bulk { mail.update(picked, seen: true) } }
                Spacer()
                Button("Delete", systemImage: "trash", role: .destructive) { bulk { mail.update(picked, trash: true) } }
            }
        } else if compact {
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button("New message", systemImage: "square.and.pencil") { mail.compose = mail.compose ?? Draft(accountId: mail.account) }
            }
        }
    }

    private func bulk(_ change: () -> Void) {
        guard !selection.isEmpty else { return }
        change()
        withAnimation(.quick) {
            selection = []
            editMode = .inactive
        }
    }
    #endif

    private var current: Conversation? { conversations.first { $0.id == cursor } }

    // The same keys as on the web.
    private func key(_ press: KeyPress, _ scroll: ScrollViewProxy) -> KeyPress.Result {
        let char = press.characters
        // While writing, letters are text: only moving through the list still works from the keyboard.
        if mail.compose != nil, press.key != .downArrow, press.key != .upArrow { return .ignored }
        if char == "/" {
            searching.wrappedValue = true
            return .handled
        }
        if press.key == .downArrow || char == "j" || press.key == .upArrow || char == "k" {
            let step = press.key == .downArrow || char == "j" ? 1 : -1
            let i = conversations.firstIndex { $0.id == cursor }.map { $0 + step } ?? 0
            if conversations.indices.contains(i) {
                cursor = conversations[i].id
                keyboard = true
                scroll.scrollTo(cursor)
            }
            return .handled
        }
        guard let c = current else { return .ignored }
        switch (press.key, char) {
        case (.return, _), (_, "o"): open(c)
        case (_, "e"): act(c) { mail.update(c.messages, archive: true) }
        case (_, "#"), (.delete, _): act(c) { mail.update(c.messages, trash: true) }
        case (_, "s"): mail.update(c.messages, starred: !c.starred)
        case (_, "U"): mail.update(c.messages, seen: false)
        case (_, "h"): snoozing = c.id
        case (_, "r"), (_, "a"), (_, "f"):
            open(c)
            Task { mail.reply = await Draft.answer(char == "r" ? .reply : char == "a" ? .replyAll : .forward, thread: c.id) }
        default: return .ignored
        }
        return .handled
    }

    private func open(_ c: Conversation) {
        cursor = c.id
        mail.thread = c.id
    }

    // The row below takes the cursor once this one leaves.
    private func act(_ c: Conversation, _ change: () -> Void) {
        if let i = conversations.firstIndex(of: c) {
            let next = conversations.indices.contains(i + 1) ? i + 1 : i - 1
            cursor = conversations.indices.contains(next) ? conversations[next].id : nil
        }
        change()
    }

    @ViewBuilder private func menu(_ c: Conversation) -> some View {
        Button("Archive") { act(c) { mail.update(c.messages, archive: true) } }
        Button(c.unread ? "Mark as Read" : "Mark as Unread") { mail.update(c.messages, seen: c.unread) }
        Button(c.starred ? "Unstar" : "Star") { mail.update(c.messages, starred: !c.starred) }
        Button("Snooze…") { snoozing = c.id }
        Divider()
        Button("Delete", role: .destructive) { act(c) { mail.update(c.messages, trash: true) } }
    }

    private func observe() async {
        let folder = mail.folder
        let categories = mail.categories
        let account = mail.account
        let query = query.trimmingCharacters(in: .whitespaces)
        // Waits for typing to pause before searching.
        if !query.isEmpty, (try? await Task.sleep(for: .milliseconds(150))) == nil { return }
        let fetch: @Sendable (GRDB.Database) throws -> [Conversation] = { db in
            query.isEmpty ? try folder.conversations(db, categories: categories, account: account) : try Conversation.search(db, query)
        }
        do {
            for try await value in ValueObservation.tracking(fetch).values(in: Store.db) {
                conversations = value
                if query.isEmpty { mail.order = value.map(\.id) }
                if cursor == nil || !value.contains(where: { $0.id == cursor }) { cursor = value.first?.id }
            }
        } catch {}
    }
}

/// One conversation. Hovering swaps the date for quick actions in the same place, so nothing around it moves. On a
/// phone it takes three lines: who and when, the subject, then the start of the text.
struct ConversationRow: View {
    @Environment(Mail.self) private var mail
    @Environment(\.compact) private var compact
    let conversation: Conversation
    /// Sent and Drafts name who it's for instead of who it's from.
    var outgoing = false
    var cursor = false
    @Binding var snoozing: Bool
    @State private var hovered = false

    var body: some View {
        let m = conversation.latest
        let unread = conversation.unread
        Group {
            if compact { stacked } else { wide }
        }
        .font(.md)
        // Hovering only shows the actions, as on the web; a fill is left for the keyboard cursor.
        .background(cursor ? Color.hover : .clear, in: .rect(cornerRadius: Radius.md))
        // A hairline between rows, starting at the sender.
        .overlay(alignment: .bottom) {
            Rectangle().fill(.line).frame(height: 1).padding(.leading, compact ? 26 : 30).padding(.trailing, compact ? 0 : 8).opacity(cursor ? 0 : 1)
        }
        .contentShape(.rect)
        .onHover { over in withAnimation(.quick) { hovered = over } }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(unread ? "Unread, " : "")\(m.sender), \(m.subject), \(m.sentAt.mailDate)")
    }

    private var who: String { outgoing ? conversation.latest.to.joined(separator: ", ") : conversation.latest.sender }

    private var stacked: some View {
        let m = conversation.latest
        let unread = conversation.unread
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            // Level with the middle of the sender's lowercase letters.
            Dot(on: unread).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(who).font(.lg.weight(unread ? .semibold : .regular)).foregroundStyle(.ink).lineLimit(1)
                    if conversation.messages.count > 1 {
                        Text("\(conversation.messages.count)").font(.xs).foregroundStyle(.muted)
                    }
                    Spacer(minLength: 8)
                    if conversation.starred { Image(systemName: "star.fill").font(.xs).foregroundStyle(.muted) }
                    if m.attachments > 0 { Image(systemName: "paperclip").font(.xs).foregroundStyle(.muted) }
                    Text(m.sentAt.mailDate).font(.sm).foregroundStyle(unread ? .ink : .muted)
                }
                Text(m.subject.isEmpty ? "(No subject)" : m.subject)
                    .fontWeight(unread ? .medium : .regular)
                    .foregroundStyle(.ink)
                    .lineLimit(1)
                if !m.snippet.isEmpty {
                    Text(m.snippet).font(.sm).foregroundStyle(.muted).lineLimit(2)
                }
            }
        }
        .padding(.leading, 10)
        .padding(.vertical, 10)
    }

    private var wide: some View {
        let m = conversation.latest
        let unread = conversation.unread
        return HStack(spacing: 12) {
            Dot(on: unread)
            HStack(spacing: 6) {
                Text(who)
                    .fontWeight(unread ? .semibold : .regular)
                    .foregroundStyle(unread ? .ink : .muted)
                    .lineLimit(1)
                if conversation.messages.count > 1 {
                    Text("\(conversation.messages.count)").font(.xs).foregroundStyle(.muted)
                }
            }
            .frame(width: 160, alignment: .leading)
            let subject = Text(m.subject.isEmpty ? "(No subject)" : m.subject)
                .fontWeight(unread ? .semibold : .regular)
                .foregroundStyle(unread ? .ink : .muted)
            Text("\(subject)\(Text(m.snippet.isEmpty ? "" : " · \(m.snippet)").foregroundStyle(.muted))")
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if conversation.starred { Image(systemName: "star.fill").font(.xs).foregroundStyle(.muted) }
            if m.attachments > 0 { Image(systemName: "paperclip").font(.xs).foregroundStyle(.muted) }
            ZStack(alignment: .trailing) {
                Text(m.sentAt.mailDate)
                    .font(.sm.weight(unread ? .medium : .regular))
                    .foregroundStyle(unread ? .ink : .muted)
                    .opacity(hovered || cursor || snoozing ? 0 : 1)
                // Only built while hovered: every row carrying four buttons costs more than it shows.
                if hovered || cursor || snoozing {
                    HStack(spacing: 0) {
                        IconButton(label: conversation.starred ? "Unstar" : "Star", symbol: conversation.starred ? "star.fill" : "star", key: "S") {
                            mail.update(conversation.messages, starred: !conversation.starred)
                        }
                        IconButton(label: "Archive", symbol: "archivebox", key: "E") { mail.update(conversation.messages, archive: true) }
                        IconButton(label: "Snooze", symbol: "clock", key: "H") { snoozing = true }
                            .popover(isPresented: $snoozing) {
                                WhenPicker(action: "Snooze") { date in
                                    snoozing = false
                                    mail.update(conversation.messages, snoozeUntil: date)
                                }
                            }
                        IconButton(label: "Delete", symbol: "trash", key: "#") { mail.update(conversation.messages, trash: true) }
                    }
                    .transition(.opacity)
                }
            }
            .frame(minWidth: 112, alignment: .trailing)
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .frame(height: 44)
    }
}
