// SPDX-License-Identifier: AGPL-3.0-only
import GRDB
import SwiftUI

/// A folder or search as one dense list, a row per conversation. On iOS it's a native list: swipe left to archive,
/// right to snooze, pull to catch up, Select to act on several.
struct MailList: View {
    @Environment(Mail.self) private var mail
    @Environment(\.compact) private var compact
    @Environment(\.composer) private var composer
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
    @State private var selection = Set<String>()
    /// Filters picked in the search field, like the web's chips.
    @State private var tokens: [SearchToken] = []
    /// Where a shift-click range starts.
    @State private var anchor: String?
    /// Unread, starred or with attachments, from the filter menu on iOS.
    @State private var filters = Set<SearchToken>()
    /// Conversations a new mail just came into; they light up for a moment.
    @State private var fresh = Set<String>()
    @Environment(\.accessibilityReduceMotion) private var still
    #if os(iOS)
    @State private var editMode = EditMode.inactive
    #endif

    var body: some View {
        ScrollViewReader { scroll in
            Group { if mail.folder == .outbox && query.isEmpty { OutboxList() } else { rows } }
                .environment(\.compact, compact || narrow)
                .onGeometryChange(for: Bool.self) { $0.size.width < 600 } action: { narrow = $0 }
                // A chip filters the inbox; the title stays Inbox.
                .navigationTitle(query.isEmpty && tokens.isEmpty ? title : "Search")
                #if os(iOS)
                // Said outright: "automatic" takes the folder page's inline title, and the large one then sat on the rows.
                .navigationBarTitleDisplayMode(.large)
                #endif
                .overlay {
                    if conversations.isEmpty, mail.folder != .outbox || !query.isEmpty {
                        Text(query.isEmpty ? "Nothing here" : "No mail matches").font(.md).foregroundStyle(.muted)
                    }
                }
                .focusable()
                .focusEffectDisabled()
                .focused($focused)
                .onAppear { focused = true }
                .onKeyPress(phases: .down) { press in key(press, scroll) }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                #if os(macOS)
                if inbox, query.isEmpty, tokens.isEmpty { InboxChips() }
                #endif
                banners
            }
        }
        #if os(macOS)
        .overlay(alignment: .bottom) {
            if !selection.isEmpty { bulkBar.padding(.bottom, 16).transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom))) }
        }
        .animation(.quick, value: selection.isEmpty)
        #endif
        .environment(\.marks, query.split(separator: " ").filter { !$0.contains(":") }.flatMap { Search.terms(String($0)) })
        .modifier(SearchBox(query: $query, tokens: $tokens, focused: searching))
        .task(id: [AnyHashable(mail.folder), AnyHashable(mail.inView.map(\.id)), AnyHashable(query), AnyHashable(tokens), AnyHashable(filters)]) { await observe() }
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
    /// The one inbox, which tabs filter.
    private var inbox: Bool { !mail.prefs.categories && (mail.folder == .inbox || mail.folder.isCategory) }
    private var title: String {
        #if os(macOS)
        // A chip filters the inbox; the title stays Inbox.
        if inbox { return "Inbox" }
        #endif
        return mail.folder.name
    }

    #if os(macOS)
    private var rows: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(conversations) { c in
                    ConversationRow(conversation: c, outgoing: outgoing, cursor: keyboard && cursor == c.id,
                        snoozing: Binding(get: { snoozing == c.id }, set: { snoozing = $0 ? c.id : nil }),
                        picked: selection.contains(c.id), picking: !selection.isEmpty, fresh: fresh.contains(c.id)) { pick(c.id) }
                        .id(c.id)
                        .onTapGesture { click(c) }
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
                    snoozing: Binding(get: { false }, set: { if $0 { snoozing = c.id } }), fresh: fresh.contains(c.id))
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
                    .contextMenu { menu(c) } preview: { MailPreview(message: c.latest).environment(mail) }
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
        if !editMode.isEditing, mail.folder != .outbox {
            ToolbarItem(placement: .topBarTrailing) { FilterMenu(tabs: inbox && query.isEmpty && tokens.isEmpty, filters: $filters) }
        }
        // Scheduled mail is changed by opening it, not picked.
        if mail.folder != .outbox {
        ToolbarItem(placement: .topBarTrailing) {
            Button(editMode.isEditing ? "Done" : "Select") {
                withAnimation(.quick) {
                    editMode = editMode.isEditing ? .inactive : .active
                    selection = []
                }
            }
            .disabled(conversations.isEmpty && !editMode.isEditing)
        }
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
        } else if !compact {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New message", systemImage: "square.and.pencil") { mail.write(mail.compose ?? Draft(accountId: mail.sender)) }
            }
        } else {
            // On iOS 18 search stays at the top and the button keeps to the right.
            if #available(iOS 26, *) {
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                ToolbarSpacer(.flexible, placement: .bottomBar)
            } else {
                ToolbarItem(placement: .bottomBar) { Spacer() }
            }
            ToolbarItem(placement: .bottomBar) {
                Button("New message", systemImage: "square.and.pencil") { mail.write(mail.compose ?? Draft(accountId: mail.sender)) }
            }
            .composerSource("compose", in: composer)
        }
    }

    #endif

    private func bulk(_ change: () -> Void) {
        guard !selection.isEmpty else { return }
        change()
        withAnimation(.quick) {
            selection = []
            #if os(iOS)
            editMode = .inactive
            #endif
        }
    }

    // What the selected conversations can have done to them, as on the web's bulk bar.
    private var bulkBar: some View {
        let picked = conversations.filter { selection.contains($0.id) }.flatMap(\.messages)
        return HStack(spacing: 2) {
            Text("\(selection.count) selected").font(.sm.weight(.medium)).foregroundStyle(.ink).padding(.horizontal, 12)
            if mail.folder != .role("archive") {
                IconButton(label: "Archive", symbol: "archivebox", key: "E") { bulk { mail.update(picked, archive: true) } }
            }
            IconButton(label: "Mark as read", symbol: "envelope.open") { bulk { mail.update(picked, seen: true) } }
            IconButton(label: "Delete", symbol: "trash", key: "#") { bulk { mail.update(picked, trash: true) } }
            IconButton(label: "Clear selection", symbol: "xmark", key: "Esc") { withAnimation(.quick) { selection = [] } }
        }
        .padding(6)
        .glass(in: Capsule())
    }

    // Accounts in view that are syncing or can't: a running line, and what went wrong with a way out.
    @ViewBuilder private var banners: some View {
        let inView = mail.inView
        VStack(spacing: 0) {
            if inView.contains(where: { mail.syncing.contains($0.id) }) { SyncLine() }
            ForEach(inView.filter { $0.syncError != nil }) { a in
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.danger)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Couldn't sync \(a.email)").font(.sm.weight(.medium)).foregroundStyle(.ink)
                        Text(a.syncError ?? "").font(.xs).foregroundStyle(.muted).lineLimit(2)
                    }
                    Spacer()
                    HoldButton(title: "Remove account") { Task { await mail.remove(a) } }
                }
                .padding(12)
                .background(.sunken, in: .rect(cornerRadius: Radius.md))
                .padding(.horizontal, 12).padding(.top, 8)
            }
        }
    }

    // A plain click opens; with ⌘ it picks the row, with ⇧ everything from the last pick to here.
    private func click(_ c: Conversation) {
        #if os(macOS)
        let keys = NSEvent.modifierFlags
        if keys.contains(.command) { return pick(c.id) }
        if keys.contains(.shift) { return extend(to: c.id) }
        #endif
        keyboard = false
        selection = []
        open(c)
    }

    private func pick(_ id: String) {
        withAnimation(.quick) { if selection.remove(id) == nil { selection.insert(id) } }
        anchor = id
    }

    private func extend(to id: String) {
        guard let from = conversations.firstIndex(where: { $0.id == (anchor ?? cursor) }),
              let to = conversations.firstIndex(where: { $0.id == id })
        else { return pick(id) }
        withAnimation(.quick) { selection.formUnion(conversations[min(from, to)...max(from, to)].map(\.id)) }
    }

    private var current: Conversation? { conversations.first { $0.id == cursor } }

    // The same keys as on the web.
    private func key(_ press: KeyPress, _ scroll: ScrollViewProxy) -> KeyPress.Result {
        let char = press.characters
        // While writing, letters are text: only moving through the list still works from the keyboard.
        if mail.typing, press.key != .downArrow, press.key != .upArrow { return .ignored }
        if char == "/" {
            searching.wrappedValue = true
            return .handled
        }
        if char == "?" {
            mail.shortcutsOpen = true
            return .handled
        }
        if press.modifiers.contains(.command) {
            guard char == "a" else { return .ignored }
            withAnimation(.quick) { selection = Set(conversations.map(\.id)) }
            return .handled
        }
        if press.key == .escape, !selection.isEmpty {
            withAnimation(.quick) { selection = [] }
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
        case (_, "s"): mail.update(c.messages, toggleStar: true)
        case (_, "x"): pick(c.id)
        case (_, "X"): extend(to: c.id)
        case (_, "U"): mail.update(c.messages, seen: false)
        case (_, "h"): snoozing = c.id
        case (_, "r"), (_, "a"), (_, "f"):
            open(c)
            let everyone = mail.prefs.replyDefault == "all" && (c.messages.first?.others(mail.accountList).count ?? 0) > 1
            let kind: Answering.Kind = char == "f" ? .forward : char == "a" || everyone ? .replyAll : .reply
            Task { if let d = await Draft.start(kind, thread: c.id) { mail.write(d) } }
        default: return .ignored
        }
        return .handled
    }

    // A draft opens to be written on; a reply's draft in its conversation.
    private func open(_ c: Conversation) {
        cursor = c.id
        if mail.folder == .role("drafts"), let d = c.messages.first {
            // A reply's draft opens its conversation with it (Mail.write).
            Task { mail.write(await Draft.resume(d)) }
            return
        }
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
        Button(c.starred ? "Unstar" : "Star") { mail.update(c.messages, toggleStar: true) }
        Button("Snooze…") { snoozing = c.id }
        Divider()
        SortMenu(message: c.latest)
        Divider()
        Button("Delete", role: .destructive) { act(c) { mail.update(c.messages, trash: true) } }
    }

    private func observe() async {
        let folder = mail.folder
        let categories = mail.prefs.categories
        let query = (tokens.map(\.query) + [query.trimmingCharacters(in: .whitespaces)]).filter { !$0.isEmpty }.joined(separator: " ")
        // in:archived in All inboxes looks into archived accounts too.
        let all = mail.scope == nil && query.split(separator: " ").contains("in:archived")
        let accounts = (all ? mail.accounts : mail.inView).map(\.id)
        let fetch: @Sendable (GRDB.Database) throws -> [Conversation] = { db in
            query.isEmpty ? try folder.conversations(db, categories: categories, accounts: accounts) : try Conversation.search(db, query, accounts: accounts)
        }
        let filters = filters
        var first = true
        do {
            // ponytail: filters only see the newest 2000 messages a folder loads, a SQL clause if that falls short.
            for try await all in ValueObservation.tracking(fetch).values(in: Store.db) {
                let value = all.filter { c in filters.allSatisfy { $0.keeps(c) } }
                // New unread mail lights its conversation up: a new one, or one a reply pushed to the top.
                let before = Dictionary(conversations.map { ($0.id, $0.latest.id) }, uniquingKeysWith: { a, _ in a })
                let arrived = first ? [] : value.filter { before[$0.id] != $0.latest.id && !$0.latest.seen }.map(\.id)
                withAnimation(first || still ? nil : .quick) { conversations = value }
                first = false
                if !arrived.isEmpty {
                    fresh.formUnion(arrived)
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation(.easeOut(duration: 0.6)) { fresh.subtract(arrived) }
                    }
                }
                selection.formIntersection(value.map(\.id))
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
    /// Picked for the bulk bar, and whether anything is.
    var picked = false
    var picking = false
    /// New mail just came in.
    var fresh = false
    var pick: (() -> Void)?
    @State private var hovered = false
    @Environment(\.marks) private var marks

    var body: some View {
        let m = conversation.latest
        let unread = conversation.unread
        Group {
            if compact { stacked } else { wide }
        }
        .font(.md)
        // Hovering only shows the actions, as on the web; a fill is left for the keyboard cursor and picked rows.
        .background(cursor ? Color.hover : picked || fresh ? .selected : .clear, in: .rect(cornerRadius: Radius.md))
        // A hairline between rows, starting at the sender.
        .overlay(alignment: .bottom) {
            Rectangle().fill(.line).frame(height: 1).padding(.leading, compact ? 26 : pick == nil ? 30 : 60).padding(.trailing, compact ? 0 : 8)
                .opacity(cursor || picked ? 0 : 1)
        }
        .contentShape(.rect)
        .onHover { over in withAnimation(.quick) { hovered = over } }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(unread ? "Unread, " : "")\(m.sender)\(to.map { ", to \($0.name)" } ?? ""), \(m.subject), \(m.sentAt.mailDate)")
    }

    private var who: String { outgoing ? conversation.latest.to.joined(separator: ", ") : conversation.latest.sender }
    /// The account it came to, where several mix in the list; its color tints the sender.
    private var to: Account? { mail.mixed ? mail.accounts.first { $0.id == conversation.latest.accountId } : nil }
    private var tint: Color? { outgoing ? nil : Color.label(to?.color) }

    private var stacked: some View {
        let m = conversation.latest
        let unread = conversation.unread
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            // Level with the middle of the sender's lowercase letters.
            Dot(on: unread).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Search.marked(who, marks)).font(.lg.weight(unread ? .semibold : .regular)).foregroundStyle(tint ?? .ink).lineLimit(1)
                    if conversation.messages.count > 1 {
                        Text("\(conversation.messages.count)").font(.xs).foregroundStyle(.muted)
                    }
                    Spacer(minLength: 8)
                    if conversation.starred { Image(systemName: "star.fill").font(.xs).foregroundStyle(.muted) }
                    if m.attachments > 0 { Image(systemName: "paperclip").font(.xs).foregroundStyle(.muted) }
                    Text(m.sentAt.mailDate).font(.sm).foregroundStyle(unread ? .ink : .muted)
                }
                Text(Search.marked(m.subject.isEmpty ? "(No subject)" : m.subject, marks))
                    .fontWeight(unread ? .medium : .regular)
                    .foregroundStyle(.ink)
                    .lineLimit(1)
                if !m.snippet.isEmpty {
                    Text(Search.marked(m.snippet, marks)).font(.sm).foregroundStyle(.muted).lineLimit(2)
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
            if let pick {
                // Picking is a click away on hover, and stays visible on every row while anything is picked.
                Button(picked ? "Deselect" : "Select", systemImage: picked ? "checkmark.circle.fill" : "circle", action: pick)
                    .labelStyle(.iconOnly).buttonStyle(.plain).font(.system(size: 14))
                    .foregroundStyle(picked ? Color.ink : .faint)
                    .opacity(hovered || picking ? 1 : 0)
                    .help("Select (X)")
            }
            Dot(on: unread)
            HStack(spacing: 6) {
                Text(Search.marked(who, marks))
                    .fontWeight(unread ? .semibold : .regular)
                    .foregroundStyle(tint ?? (unread ? .ink : .muted))
                    .lineLimit(1)
                if conversation.messages.count > 1 {
                    Text("\(conversation.messages.count)").font(.xs).foregroundStyle(.muted)
                }
            }
            .frame(width: 160, alignment: .leading)
            let subject = Text(Search.marked(m.subject.isEmpty ? "(No subject)" : m.subject, marks))
                .fontWeight(unread ? .semibold : .regular)
                .foregroundStyle(unread ? .ink : .muted)
            Text("\(subject)\(Text(Search.marked(m.snippet.isEmpty ? "" : " · \(m.snippet)", marks)).foregroundStyle(.muted))")
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if m.attachments > 0 { Image(systemName: "paperclip").font(.xs).foregroundStyle(.muted) }
            ZStack(alignment: .trailing) {
                // A set star sits where the Star action does, so hovering turns it yellow in place instead of
                // showing a second one.
                if conversation.starred, !(hovered || cursor || snoozing) {
                    Image(systemName: "star.fill").font(.system(size: 15)).foregroundStyle(.ink)
                        .frame(width: tapSize).frame(width: tapSize * 4, alignment: .leading)
                }
                Text(m.sentAt.mailDate)
                    .font(.sm.weight(unread ? .medium : .regular))
                    .foregroundStyle(unread ? .ink : .muted)
                    .opacity(hovered || cursor || snoozing ? 0 : 1)
                // Only built while hovered: every row carrying four buttons costs more than it shows.
                if hovered || cursor || snoozing {
                    HStack(spacing: 0) {
                        IconButton(
                            label: conversation.starred ? "Unstar" : "Star", symbol: conversation.starred ? "star.fill" : "star", key: "S",
                            tint: conversation.starred ? .star : nil
                        ) {
                            mail.update(conversation.messages, toggleStar: true)
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

/// A segment running along the top while an account in view syncs; with Reduce Motion it's a still, faint line.
private struct SyncLine: View {
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        TimelineView(.animation(paused: still)) { t in
            GeometryReader { g in
                let phase = still ? 0.4 : t.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                Capsule().fill(Color.muted.opacity(0.5))
                    .frame(width: g.size.width * 0.25, height: 2)
                    .offset(x: g.size.width * 1.25 * phase - g.size.width * 0.25)
            }
        }
        .frame(height: 2)
        .clipped()
        .accessibilityLabel("Syncing")
    }
}

extension Search {
    /// The text with the words that were found stressed, so a result shows why it's there.
    static func marked(_ text: String, _ typed: [Term]) -> AttributedString {
        var out = AttributedString(text)
        guard !typed.isEmpty else { return out }
        for part in text.split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
            let found = terms(String(part)).contains { w in typed.contains { likeness($0, w) > 0 } }
            guard found, let range = Range(part.startIndex..<part.endIndex, in: out) else { continue }
            out[range].inlinePresentationIntent = .stronglyEmphasized
            out[range].foregroundColor = Color.ink
        }
        return out
    }
}

extension EnvironmentValues {
    /// The typed words, for rows to stress where they were found.
    @Entry var marks: [Search.Term] = []
}

/// The search field on its own: a keystroke redraws this and not the list under it, which follows once typing pauses.
private struct SearchBox: ViewModifier {
    @Environment(Mail.self) private var mail
    @Binding var query: String
    @Binding var tokens: [SearchToken]
    var focused: FocusState<Bool>.Binding
    @State private var typed = ""
    /// People whose mail matches the last word typed, offered as "From …".
    @State private var people: [SearchToken] = []
    @AppStorage(SearchToken.recentKey) private var recent = ""

    private var offered: [SearchToken] {
        SearchToken.suggestions(for: typed, people: people, archived: mail.accounts.contains(where: \.archived)).filter { !tokens.contains($0) }
    }

    func body(content: Content) -> some View {
        content
            #if os(iOS)
            .scrollDismissesKeyboard(.immediately)
            .safeAreaInset(edge: .top, spacing: 0) {
                // Not searchSuggestions: on a phone those cover the results.
                SearchChips(offered: offered, recent: typed.isEmpty ? recent.split(separator: "\n").map(String.init) : []) { token in
                    tokens.append(token)
                    let kept = typed.split(separator: " ").filter { !token.covers(String($0)) }.joined(separator: " ")
                    typed = kept.isEmpty ? "" : "\(kept) "
                } again: { typed = $0 }
            }
            #endif
            .searchable(text: $typed, tokens: $tokens, prompt: "Search mail") { Label($0.title, systemImage: $0.icon) }
            #if os(macOS)
            .searchSuggestions {
                ForEach(offered) { Label($0.title, systemImage: $0.icon).searchCompletion($0) }
            }
            #endif
            .searchFocused(focused)
            .onSubmit(of: .search) { remember() }
            .onChange(of: mail.thread) { _, thread in if thread != nil { remember() } }
            .task(id: typed) { await follow() }
    }

    private func follow() async {
        let text = typed.trimmingCharacters(in: .whitespaces)
        // A single letter is in nearly every mail.
        guard text.count != 1 else { return query = "" }
        if !text.isEmpty, (try? await Task.sleep(for: .milliseconds(120))) == nil { return }
        query = text
        let last = text.split(separator: " ").last.map(String.init) ?? ""
        people = last.count > 1 ? await Store.people(matching: last, limit: 4).map { SearchToken.from($0.address, $0.name) } : []
    }

    private func remember() {
        guard query.count > 1 else { return }
        let others = recent.split(separator: "\n").map(String.init).filter { $0.lowercased() != query.lowercased() }
        recent = ([query] + others).prefix(6).joined(separator: "\n")
    }
}

#if os(iOS)
/// Under the search field while it's in use: filters that fit what's typed, and earlier searches while it's empty.
private struct SearchChips: View {
    @Environment(\.isSearching) private var active
    let offered: [SearchToken]
    let recent: [String]
    let pick: (SearchToken) -> Void
    let again: (String) -> Void

    var body: some View {
        if active, !offered.isEmpty || !recent.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(offered) { token in chip(token.title, token.icon) { pick(token) } }
                    ForEach(recent, id: \.self) { text in chip(text, "clock") { again(text) } }
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
            }
            .scrollIndicators(.hidden)
            .background(.paper)
        }
    }

    private func chip(_ title: String, _ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.sm.weight(.medium))
                .foregroundStyle(.muted)
                .lineLimit(1)
                .padding(.horizontal, 12).frame(height: 32)
                .overlay(Capsule().strokeBorder(.line))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
#endif

/// A filter in the search field, the way the web turns words into chips.
enum SearchToken: Identifiable, Hashable {
    /// Earlier searches, kept on this device until sign-out.
    static let recentKey = "recentSearches"

    case unread, starred, attachment, archived
    case from(String, String)
    case since(Date, String)

    var id: Self { self }

    var title: String {
        switch self {
        case .unread: "Unread"
        case .starred: "Starred"
        case .attachment: "With attachments"
        case .archived: "In archived accounts"
        case .from(let address, let name): "From \(name.isEmpty ? address : name)"
        case .since(_, let label): "Since \(label)"
        }
    }

    var icon: String {
        switch self {
        case .unread: "envelope.badge"
        case .starred: "star"
        case .attachment: "paperclip"
        case .archived: "archivebox"
        case .from: "person"
        case .since: "calendar"
        }
    }

    /// For the filter menu, which narrows the list without searching.
    func keeps(_ c: Conversation) -> Bool {
        switch self {
        case .unread: c.unread
        case .starred: c.starred
        case .attachment: c.messages.contains { $0.attachments > 0 }
        default: true
        }
    }

    /// What Conversation.search reads.
    var query: String {
        switch self {
        case .unread: "is:unread"
        case .starred: "is:starred"
        case .attachment: "has:attachment"
        case .archived: "in:archived"
        case .from(let address, _): "from:\(address)"
        case .since(let date, _): "after:\(date.formatted(.iso8601.year().month().day()))"
        }
    }

    // The words that ask for this filter, in the languages people type in.
    private var keywords: [String] {
        switch self {
        case .unread: ["unread", "ungelesen"]
        case .starred: ["starred", "markiert", "stern"]
        case .attachment: ["attachments", "anhang", "anhänge"]
        case .archived: ["archived", "archiviert"]
        case .from, .since: []
        }
    }

    /// Whether a typed word only asked for this filter, so picking it takes the word out of the field.
    func covers(_ typed: String) -> Bool {
        let word = typed.lowercased()
        switch self {
        case .from(let address, let name): return ["from", "von"].contains(word) || "\(name) \(address)".lowercased().contains(word)
        case .since(_, let label): return ["since", "after", "seit", "last", "letzte", "letzten", "letzter"].contains(word) || label.lowercased().contains(word) || Self.day(word) != nil
        case .attachment where ["with", "mit"].contains(word): return true
        default: return word.count > 1 && keywords.contains { $0.hasPrefix(word) }
        }
    }

    /// The filters that fit what's typed (all of them while it's empty), dates it reads as one, and matching people.
    static func suggestions(for text: String, people: [SearchToken], archived: Bool) -> [SearchToken] {
        let typed = text.trimmingCharacters(in: .whitespaces).lowercased()
        let flags = [SearchToken.unread, .starred, .attachment] + (archived ? [.archived] : [])
        guard !typed.isEmpty else { return flags }
        let words = typed.split(separator: " ").map(String.init)
        let matching = flags.filter { f in words.contains { w in w.count > 1 && f.keywords.contains { $0.hasPrefix(w) } } }
        let date = day(words.suffix(2).joined(separator: " ")) ?? day(words.last ?? "")
        return matching + (date.map { [$0] } ?? []) + people
    }

    // A day in the past from a word: today, yesterday, a weekday (the last one), or a month (its first day).
    private static func day(_ word: String) -> SearchToken? {
        let cal = Calendar.current
        let today = cal.startOfDay(for: .now)
        let word = ["since ", "after ", "seit "].reduce(word) { $0.replacingOccurrences(of: $1, with: "") }
        if ["today", "heute"].contains(word) { return .since(today, "today") }
        if ["yesterday", "gestern"].contains(word) { return .since(cal.date(byAdding: .day, value: -1, to: today)!, "yesterday") }
        if ["last week", "letzte woche"].contains(word) { return .since(cal.date(byAdding: .day, value: -7, to: today)!, "a week ago") }
        if ["last month", "letzter monat", "letzten monat"].contains(word) { return .since(cal.date(byAdding: .month, value: -1, to: today)!, "a month ago") }
        // The device's language and English, whichever is typed.
        let english = DateFormatter()
        english.locale = Locale(identifier: "en")
        let weekdays = cal.weekdaySymbols.map { $0.lowercased() }
        let weekdayNames = english.weekdaySymbols.map { $0.lowercased() }
        if let i = weekdays.firstIndex(where: { $0.hasPrefix(word) && word.count >= 3 }) ?? weekdayNames.firstIndex(where: { $0.hasPrefix(word) && word.count >= 3 }) {
            let back = (cal.component(.weekday, from: today) - 1 - i + 7) % 7
            return .since(cal.date(byAdding: .day, value: -(back == 0 ? 7 : back), to: today)!, cal.weekdaySymbols[i])
        }
        let months = cal.monthSymbols.map { $0.lowercased() }
        let monthNames = english.monthSymbols.map { $0.lowercased() }
        if let i = months.firstIndex(where: { $0.hasPrefix(word) && word.count >= 3 }) ?? monthNames.firstIndex(where: { $0.hasPrefix(word) && word.count >= 3 }) {
            var year = cal.component(.year, from: today)
            if i + 1 > cal.component(.month, from: today) { year -= 1 }
            return .since(cal.date(from: DateComponents(year: year, month: i + 1, day: 1))!, cal.monthSymbols[i])
        }
        return nil
    }
}

/// Where a sender's mail goes from now on: a tab, spam or not, and leaving its list. In a row's context menu and an
/// open conversation's More menu.
struct SortMenu: View {
    let message: Message
    @Environment(Mail.self) private var mail

    var body: some View {
        Menu("Always sort as", systemImage: "tray.2") {
            ForEach(tabs, id: \.0) { id, name in
                Button(name) { mail.sortSender(message, category: id) }.disabled(message.category == id)
            }
        }
        Button(message.spam ? "Not spam" : "Report spam", systemImage: message.spam ? "tray.and.arrow.up" : "xmark.bin") {
            mail.sortSender(message, spam: !message.spam)
        }
        if message.unsubscribe != nil {
            Button("Unsubscribe", systemImage: "envelope.badge.shield.half.filled") { mail.unsubscribe(message) }
        }
    }
}

/// With everything in one inbox, chips over the list filter it by tab; each only when there's mail for it, with a dot
/// for unread.
struct InboxChips: View {
    @Environment(Mail.self) private var mail
    @State private var present: Set<String> = []
    @State private var unread: Set<String> = []

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                chip("All", folder: .inbox, dot: false)
                ForEach(tabs.filter { present.contains($0.0) }, id: \.0) { id, name in
                    chip(name, folder: .category(id), dot: unread.contains(id))
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
        .opacity(present.count > 1 ? 1 : 0)
        .frame(height: present.count > 1 ? nil : 0)
        .task(id: mail.inView.map(\.id)) { await observe() }
    }

    private func chip(_ name: String, folder: Folder, dot: Bool) -> some View {
        let on = mail.folder == folder
        return Button {
            mail.folder = folder
            mail.thread = nil
        } label: {
            HStack(spacing: 6) {
                Text(name).font(.sm.weight(.medium))
                if dot { Circle().frame(width: 6, height: 6).accessibilityLabel("Unread") }
            }
            .foregroundStyle(on ? Color.onInk : Color.muted)
            .padding(.horizontal, 12).frame(height: 32)
            .background(on ? Color.ink : Color.clear, in: Capsule())
            .overlay(Capsule().strokeBorder(on ? Color.ink : Color.line))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func observe() async {
        do {
            for try await tabs in Self.tabState(in: mail.inView.map(\.id)) { (present, unread) = tabs }
        } catch {}
    }

    /// The tabs with inbox mail, and those of them with unread mail.
    static func tabState(in ids: [String]) -> AsyncValueObservation<(Set<String>, Set<String>)> {
        ValueObservation.tracking { db in
            let sql = "SELECT category, MIN(seen) FROM message WHERE spam = 0 AND mailboxId IN (SELECT id FROM mailbox WHERE role = 'inbox') AND \(Folder.within) GROUP BY category"
            // Typed on purpose: Bool(row[1]) would read the number as text first, and GRDB stops the app on that.
            let rows = try Row.fetchAll(db, sql: sql, arguments: [ids.json]).map { row -> (String, Bool) in (row[0], row[1]) }
            return (Set(rows.map(\.0)), Set(rows.filter { !$0.1 }.map(\.0)))
        }
        .values(in: Store.db)
    }
}

#if os(iOS)
/// The inbox's tabs and a few filters, in one menu next to Select instead of chips over the list.
struct FilterMenu: View {
    @Environment(Mail.self) private var mail
    /// Whether the inbox's tabs are offered.
    let tabs: Bool
    @Binding var filters: Set<SearchToken>
    @State private var present: Set<String> = []
    @State private var unread: Set<String> = []

    var body: some View {
        let on = !filters.isEmpty || mail.folder.isCategory && tabs
        Menu {
            if tabs, present.count > 1 {
                Picker("Show", selection: Binding(get: { mail.folder }, set: { mail.folder = $0; mail.thread = nil })) {
                    Text("All").tag(Folder.inbox)
                    ForEach(Nouvex.tabs.filter { present.contains($0.0) }, id: \.0) { id, name in
                        Text(unread.contains(id) ? "\(name) •" : name).tag(Folder.category(id))
                    }
                }
                .pickerStyle(.inline)
            }
            Section {
                ForEach([SearchToken.unread, .starred, .attachment]) { f in
                    Toggle(f.title, systemImage: f.icon, isOn: Binding(
                        get: { filters.contains(f) },
                        set: { if $0 { filters.insert(f) } else { filters.remove(f) } }
                    ))
                }
            }
            if on {
                Button("Clear filters", systemImage: "xmark") {
                    filters = []
                    if mail.folder.isCategory { mail.folder = .inbox }
                }
            }
        } label: {
            Label("Filter", systemImage: on ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .menuActionDismissBehavior(.disabled)
        .task(id: mail.inView.map(\.id)) {
            do {
                for try await tabs in InboxChips.tabState(in: mail.inView.map(\.id)) { (present, unread) = tabs }
            } catch {}
        }
    }
}
#endif

#if os(iOS)
/// A long press on a row shows the mail itself above the menu, like Mail; it isn't marked as read by that.
private struct MailPreview: View {
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(message.subject.isEmpty ? "(No subject)" : message.subject).font(.xl).foregroundStyle(.ink).lineLimit(2)
            HStack(spacing: 10) {
                Avatar(name: message.sender, size: 28)
                Text(message.sender).font(.md.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                Spacer(minLength: 8)
                Text(message.sentAt.mailDate).font(.sm).foregroundStyle(.muted)
            }
            MailBody(message: message)
        }
        .padding(16)
        .frame(width: 380, height: 540, alignment: .top)
        .clipped()
        .background(.paper)
    }
}
#endif

/// What waits to go out later, and what couldn't be sent, which is back in Drafts. A scheduled one can be taken back
/// into Drafts to change or send now.
struct OutboxList: View {
    @Environment(Mail.self) private var mail

    var body: some View {
        List {
            ForEach(mail.outbox) { w in
                Button { Task { await mail.edit(w) } } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(w.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "(No subject)" : w.subject).font(.lg.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.xs.weight(.semibold)).foregroundStyle(.faint)
                        }
                        Text("To \(w.to.joined(separator: ", "))").font(.md).foregroundStyle(.muted).lineLimit(1)
                        // What makes it different from a sent mail: when it goes, or that it didn't.
                        Label(w.error.map { "Couldn't send: \($0)" } ?? "Goes out \(w.runAt?.when ?? "later")",
                              systemImage: w.error == nil ? "calendar.badge.clock" : "exclamationmark.circle")
                            .font(.sm.weight(.medium)).lineLimit(2)
                            .foregroundStyle(w.error == nil ? Color.ink : .danger)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(w.error == nil ? Color.hover : Color.danger.opacity(0.12), in: .capsule)
                            .padding(.top, 2)
                    }
                    .padding(.vertical, 8)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens it to change; it goes out again from there")
                .listRowBackground(Color.paper)
                .contextMenu {
                    Button("Edit", systemImage: "pencil") { Task { await mail.edit(w) } }
                    Button(w.error == nil ? "Back to Drafts" : "Remove", systemImage: "tray.and.arrow.down") { Task { await mail.takeBack(w) } }
                }
                #if os(iOS)
                .swipeActions {
                    Button(w.error == nil ? "Back to Drafts" : "Remove", systemImage: "tray.and.arrow.down") { Task { await mail.takeBack(w) } }
                }
                #endif
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(.paper)
        .overlay { if mail.outbox.isEmpty { Text("Nothing scheduled").font(.md).foregroundStyle(.muted) } }
        .task { await mail.loadOutbox() }
        .refreshable { await mail.loadOutbox() }
    }
}
