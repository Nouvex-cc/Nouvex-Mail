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
    @State private var selection = Set<String>()
    /// Filters picked in the search field, like the web's chips.
    @State private var tokens: [SearchToken] = []
    /// People whose mail matches what's typed, offered as "From …".
    @State private var people: [SearchToken] = []
    /// Where a shift-click range starts.
    @State private var anchor: String?
    /// Conversations a new mail just came into; they light up for a moment.
    @State private var fresh = Set<String>()
    @Environment(\.accessibilityReduceMotion) private var still
    #if os(iOS)
    @State private var editMode = EditMode.inactive
    #endif

    var body: some View {
        ScrollViewReader { scroll in
            rows
                .environment(\.compact, compact || narrow)
                .onGeometryChange(for: Bool.self) { $0.size.width < 600 } action: { narrow = $0 }
                .navigationTitle(query.isEmpty && tokens.isEmpty ? mail.folder.name : "Search")
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
        .safeAreaInset(edge: .top, spacing: 0) { banners }
        #if os(macOS)
        .overlay(alignment: .bottom) {
            if !selection.isEmpty { bulkBar.padding(.bottom, 16).transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom))) }
        }
        .animation(.quick, value: selection.isEmpty)
        #endif
        .searchable(text: $query, tokens: $tokens, prompt: "Search mail") { Label($0.title, systemImage: $0.icon) }
        .searchSuggestions {
            ForEach(SearchToken.suggestions(for: query, people: people, archived: mail.accounts.contains(where: \.archived))) {
                Label($0.title, systemImage: $0.icon).searchCompletion($0)
            }
        }
        .task(id: query) { await suggestPeople() }
        .searchFocused(searching)
        .task(id: [AnyHashable(mail.folder), AnyHashable(mail.account), AnyHashable(query), AnyHashable(tokens)]) { await observe() }
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
        .glassEffect(.regular, in: .capsule)
    }

    // Accounts in view that are syncing or can't: a running line, and what went wrong with a way out.
    @ViewBuilder private var banners: some View {
        let inView = mail.accounts.filter { a in mail.account.map { $0 == a.id } ?? !a.archived }
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
        if mail.compose != nil, press.key != .downArrow, press.key != .upArrow { return .ignored }
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
        case (_, "s"): mail.update(c.messages, starred: !c.starred)
        case (_, "x"): pick(c.id)
        case (_, "X"): extend(to: c.id)
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

    // Up to four people whose mail matches what's typed.
    private func suggestPeople() async {
        let typed = query.trimmingCharacters(in: .whitespaces)
        guard typed.count > 1, (try? await Task.sleep(for: .milliseconds(100))) != nil else { return people = [] }
        people = (try? await Store.db.read { db in
            try Row.fetchAll(db, sql: """
                SELECT fromName, fromAddr FROM message WHERE fromAddr LIKE ?1 OR fromName LIKE ?1
                GROUP BY lower(fromAddr) ORDER BY MAX(sentAt) DESC LIMIT 4
                """, arguments: ["%\(typed)%"]).map { SearchToken.from($0["fromAddr"], $0["fromName"]) }
        }) ?? []
    }

    private func observe() async {
        let folder = mail.folder
        let categories = mail.categories
        let account = mail.account
        let query = (tokens.map(\.query) + [query.trimmingCharacters(in: .whitespaces)]).filter { !$0.isEmpty }.joined(separator: " ")
        // Waits for typing to pause before searching.
        if !query.isEmpty, (try? await Task.sleep(for: .milliseconds(150))) == nil { return }
        let fetch: @Sendable (GRDB.Database) throws -> [Conversation] = { db in
            query.isEmpty ? try folder.conversations(db, categories: categories, account: account) : try Conversation.search(db, query, account: account)
        }
        var first = true
        do {
            for try await value in ValueObservation.tracking(fetch).values(in: Store.db) {
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

/// A filter in the search field, the way the web turns words into chips.
enum SearchToken: Identifiable, Hashable {
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

    /// The filters that fit what's typed (all of them while it's empty), dates it reads as one, and matching people.
    static func suggestions(for text: String, people: [SearchToken], archived: Bool) -> [SearchToken] {
        let typed = text.trimmingCharacters(in: .whitespaces).lowercased()
        let flags = [SearchToken.unread, .starred, .attachment] + (archived ? [.archived] : [])
        guard !typed.isEmpty else { return flags }
        let words = typed.split(separator: " ").map(String.init)
        let matching = flags.filter { f in words.contains { f.title.lowercased().contains($0) } }
        return matching + (day(typed).map { [$0] } ?? []) + people
    }

    // A day in the past from a word: today, yesterday, a weekday (the last one), or a month (its first day).
    private static func day(_ word: String) -> SearchToken? {
        let cal = Calendar.current
        let today = cal.startOfDay(for: .now)
        let word = word.replacingOccurrences(of: "since ", with: "").replacingOccurrences(of: "after ", with: "")
        if word == "today" { return .since(today, "today") }
        if word == "yesterday" { return .since(cal.date(byAdding: .day, value: -1, to: today)!, "yesterday") }
        let weekdays = cal.weekdaySymbols.map { $0.lowercased() }
        if let i = weekdays.firstIndex(where: { $0.hasPrefix(word) && word.count >= 3 }) {
            let back = (cal.component(.weekday, from: today) - 1 - i + 7) % 7
            return .since(cal.date(byAdding: .day, value: -(back == 0 ? 7 : back), to: today)!, cal.weekdaySymbols[i])
        }
        let months = cal.monthSymbols.map { $0.lowercased() }
        if let i = months.firstIndex(where: { $0.hasPrefix(word) && word.count >= 3 }) {
            var year = cal.component(.year, from: today)
            if i + 1 > cal.component(.month, from: today) { year -= 1 }
            return .since(cal.date(from: DateComponents(year: year, month: i + 1, day: 1))!, cal.monthSymbols[i])
        }
        return nil
    }
}
