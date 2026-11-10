// SPDX-License-Identifier: AGPL-3.0-only
import GRDB
import SwiftUI

/// A native split view: the sidebar on Liquid Glass, the mail on paper, title, search and actions in the toolbar. A
/// conversation is pushed over its list. A new message docks in the bottom right, or comes up as a sheet on a phone.
struct Shell: View {
    @Environment(Mail.self) private var mail
    @State private var query = ""
    @Namespace private var composer
    @State private var column = NavigationSplitViewColumn.detail
    @FocusState private var searching: Bool
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var size
    #endif
    /// Writing comes up as a sheet on a phone, and on an iPad in a window too narrow to dock it.
    private var narrow: Bool {
        #if os(iOS)
        Device.phone || size == .compact
        #else
        false
        #endif
    }

    private var writing: Binding<Bool> {
        Binding(
            get: { narrow && (mail.compose != nil || mail.reply != nil) },
            set: { if !$0 { mail.compose = nil; mail.reply = nil } }
        )
    }

    var body: some View {
        @Bindable var mail = mail
        NavigationSplitView(preferredCompactColumn: $column) {
            Sidebar { column = .detail }.navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 320)
        } detail: {
            NavigationStack {
                MailList(query: $query, searching: $searching)
                    .navigationDestination(item: $mail.thread) { thread in
                        ThreadView(threadId: thread).id(thread)
                    }
            }
            .overlay(alignment: .bottomTrailing) {
                if !narrow, let d = mail.compose { Composer(placement: .dock).id(d.draftId).padding(.trailing, 20) }
            }
            #if os(macOS)
            // Stays in the toolbar while a conversation is open, like Mail.
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("New message", systemImage: "square.and.pencil") { mail.write(mail.compose ?? Draft(accountId: mail.sender)) }
                        .help("New message (⌘N)")
                }
            }
            #endif
        }
        .environment(\.composer, composer)
        #if os(iOS)
        // A glass card of its own rather than a sheet: a sheet snaps to the screen's edges and loses its glass once the
        // keyboard comes up. It grows out of the button it was started with, and the keyboard only lifts its lower edge.
        .fullScreenCover(isPresented: writing) {
            Composer(placement: .sheet)
                .modifier(GlassCard())
                .padding(8)
                // Down to the screen's edge, its corners following the screen's; the keyboard still lifts it.
                .ignoresSafeArea(.container, edges: .bottom)
                // Blurs and dims what's around it, so the mail behind doesn't read through the gaps.
                .presentationBackground { Rectangle().fill(.ultraThinMaterial).overlay(Color.scrim).ignoresSafeArea() }
                .navigationTransition(.zoom(sourceID: (mail.reply ?? mail.compose)?.source ?? "compose", in: composer))
                // The zoom's own swipe to dismiss took the first tap in the card; the card closes with its X.
                .interactiveDismissDisabled()
        }
        #else
        .sheet(isPresented: writing) { Composer(placement: .sheet) }
        #endif
        .sheet(isPresented: $mail.shortcutsOpen) { ShortcutsSheet() }
        #if os(iOS)
        .sheet(isPresented: $mail.settingsOpen) { SettingsView() }
        #endif
        .overlay(alignment: Device.phone ? .top : .bottom) {
            // A little below the toolbar, also once it's collapsed to its slim bar.
            if Device.phone { StatusPill().padding(.top, 62) } else { Toasts().padding(.bottom, 84) }
        }
        .background {
            Button("Search") { searching = true }.keyboardShortcut("f").hidden()
        }
        #if os(iOS)
        .environment(\.compact, size == .compact)
        #else
        .frame(minWidth: 860, minHeight: 520)
        #endif
    }
}

#if os(iOS)
/// The writing card: glass, its corners concentric with the screen's where it comes close to them.
private struct GlassCard: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            let shape = ConcentricRectangle(corners: .concentric(minimum: .fixed(32)), isUniform: false)
            content.clipShape(shape).background { Color.clear.glassEffect(.regular, in: shape) }
        } else {
            content.clipShape(.rect(cornerRadius: 32)).background(.regularMaterial, in: .rect(cornerRadius: 32))
        }
    }
}
#endif

extension Folder {
    var isCategory: Bool {
        if case .category = self { true } else { false }
    }

    var name: String {
        switch self {
        case .inbox: "Inbox"
        case .starred: "Starred"
        case .category(let id): tabs.first { $0.0 == id }?.1 ?? ""
        case .role(let role): Sidebar.folders.first { $0.0 == role }?.1 ?? ""
        case .mailbox(_, let name): name
        case .outbox: "Scheduled"
        }
    }
}

struct Sidebar: View {
    /// Brings the list into view where the sidebar covers it, like a phone.
    let show: () -> Void
    @Environment(Mail.self) private var mail
    @Environment(\.composer) private var composer
    @State private var dots: Set<String> = []
    @State private var categoriesOpen = true
    /// The selected account's own folders, by name.
    @State private var own: [Mailbox] = []
    @State private var ownOpen = true

    nonisolated static let categories = [("promotions", "Promotions"), ("social", "Social"), ("updates", "Updates"), ("newsletters", "Newsletters")]
    nonisolated static let folders = [
        ("snoozed", "Snoozed", "clock"), ("archive", "Archive", "archivebox"), ("sent", "Sent", "paperplane"),
        ("drafts", "Drafts", "doc"), ("junk", "Junk", "xmark.bin"), ("trash", "Trash", "trash"),
    ]

    var body: some View {
        Group {
            #if os(iOS)
            if Device.phone { home } else { list }
            #else
            list
            #endif
        }
        .task(id: mail.inView.map(\.id)) { await observeDots() }
        .task(id: mail.account) { await observeFolders() }
    }

    private var list: some View {
        List(selection: Binding(get: { mail.folder }, set: { folder in
            guard let folder else { return }
            mail.folder = folder
            mail.thread = nil
            show()
        })) {
            if mail.prefs.categories {
                #if os(macOS)
                DisclosureGroup(isExpanded: $categoriesOpen) {
                    ForEach(Self.categories, id: \.0) { id, name in
                        row(name, folder: .category(id), dot: dots.contains(id))
                    }
                } label: {
                    row("Inbox", icon: "tray", folder: .inbox, dot: dots.contains("primary"))
                }
                #else
                // A tap on a disclosure label only folds it on iOS, so the categories stay open under Inbox.
                row("Inbox", icon: "tray", folder: .inbox, dot: dots.contains("primary"))
                ForEach(Self.categories, id: \.0) { id, name in
                    row(name, folder: .category(id), dot: dots.contains(id))
                }
                #endif
            } else {
                row("Inbox", icon: "tray", folder: .inbox, dot: dots.contains("any"))
            }
            ForEach(Self.folders, id: \.0) { role, name, icon in
                row(name, icon: icon, folder: .role(role))
            }
            // Only while something waits there; a dot when one couldn't be sent.
            if !mail.outbox.isEmpty || mail.folder == .outbox {
                row("Scheduled", icon: "calendar.badge.clock", folder: .outbox, dot: mail.outbox.contains { $0.error != nil })
            }
            row("Starred", icon: "star", folder: .starred)
            // An account's own folders, only while one account is in view, like the web.
            if mail.account != nil, !own.isEmpty {
                let folders = ForEach(own, id: \.id) { b in row(b.name, icon: "folder", folder: .mailbox(b.id, b.name)) }
                #if os(macOS)
                DisclosureGroup("Folders", isExpanded: $ownOpen) { folders }
                #else
                Section("Folders") { folders }
                #endif
            }
            #if os(iOS)
            Section {
                NowCards()
                Profile()
            }
            #endif
        }
        .listStyle(.sidebar)
        // Icons as quiet as the text around them, not in the ink accent.
        .tint(.muted)
        .safeAreaInset(edge: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 14) {
                Image(.logo).resizable().scaledToFit().frame(height: 16).foregroundStyle(.ink)
                    .padding(.leading, 10)
                    .accessibilityLabel("Nouvex Mail")
                AccountPicker()
            }
            .padding(.horizontal, 10)
            // Room under the window buttons, so the logo doesn't sit on them.
            #if os(macOS)
            .padding(.top, 12)
            #endif
        }
        #if os(macOS)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                NowCards()
                Profile()
            }
            .padding(.horizontal, 10).padding(.bottom, 8)
        }
        #endif
    }

    #if os(iOS)
    /// On a phone the folders are a plain page, like a home screen: who's in view and who's signed in at the top,
    /// rows without fills or lines, quiet headers, writing at the bottom.
    private var home: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if mail.prefs.categories {
                    link("Inbox", icon: "tray", folder: .inbox, dot: dots.contains("primary"))
                    ForEach(Self.categories, id: \.0) { id, name in link(name, folder: .category(id), dot: dots.contains(id)) }
                } else {
                    link("Inbox", icon: "tray", folder: .inbox, dot: dots.contains("any"))
                }
                link("Starred", icon: "star", folder: .starred)
                link("Snoozed", icon: "clock", folder: .role("snoozed"))
                // Only while something waits to go out, with when the next one does.
                if !mail.outbox.isEmpty {
                    link("Scheduled", icon: "calendar.badge.clock", folder: .outbox, dot: mail.outbox.contains { $0.error != nil },
                         detail: mail.outbox.compactMap(\.runAt).min()?.when)
                }
                header("Mailboxes")
                ForEach(Self.folders.filter { $0.0 != "snoozed" }, id: \.0) { role, name, icon in link(name, icon: icon, folder: .role(role)) }
                if mail.account != nil, !own.isEmpty {
                    header("Folders")
                    ForEach(own, id: \.id) { b in link(b.name, icon: "folder", folder: .mailbox(b.id, b.name)) }
                }
                NowCards().padding(.top, 24)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .background(.paper)
        // No title here, so no room kept for a large one.
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { AccountPicker(bar: true) }
            ToolbarItem(placement: .topBarTrailing) { Profile(bar: true) }
            if #available(iOS 26, *) {
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

    private func link(_ name: String, icon: String? = nil, folder: Folder, dot: Bool = false, detail: String? = nil) -> some View {
        Button {
            mail.folder = folder
            mail.thread = nil
            show()
        } label: {
            HStack(spacing: 14) {
                // Categories sit under Inbox without icons, lined up with its name.
                Image(systemName: icon ?? "").font(.system(size: 17)).foregroundStyle(.muted).frame(width: 24)
                Text(name).font(.lg).foregroundStyle(.ink)
                Spacer()
                if let detail { Text(detail).font(.sm).foregroundStyle(.muted) }
                Dot(on: dot, color: .muted)
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .contentShape(.rect)
        }
        .buttonStyle(SidebarItemStyle())
    }

    private func header(_ title: String) -> some View {
        Text(title).font(.sm.weight(.medium)).foregroundStyle(.muted)
            .padding(.horizontal, 12).padding(.top, 24).padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }
    #endif

    private func row(_ name: String, icon: String? = nil, folder: Folder, dot: Bool = false) -> some View {
        HStack {
            if let icon {
                Label(name, systemImage: icon)
            } else {
                #if os(macOS)
                Text(name)
                #else
                Text(name).padding(.leading, 40)
                #endif
            }
            Spacer()
            Dot(on: dot, color: .muted)
        }
        .tag(folder)
    }

    private func observeFolders() async {
        guard let account = mail.account else { return own = [] }
        let folders = ValueObservation.tracking { db in
            try Mailbox.filter(Column("accountId") == account && Column("role") == "").order(Column("name")).fetchAll(db)
        }
        do {
            for try await value in folders.values(in: Store.db) { own = value }
        } catch {}
    }

    // Inbox's dot only counts what the categories leave, like on the web.
    // All inboxes leaves muted accounts and groups out.
    private func observeDots() async {
        let ids = mail.inView.map(\.id), all = mail.scope == nil
        let dots = ValueObservation.tracking { db in
            let sql = "SELECT DISTINCT category FROM message WHERE seen = 0 AND spam = 0 AND mailboxId IN (SELECT id FROM mailbox WHERE role = 'inbox') AND \(Folder.within)"
            return try Set(String.fetchAll(db, sql: sql, arguments: [(all ? try AccountGroup.loud(db) : ids).json]))
        }
        do {
            for try await value in dots.values(in: Store.db) { self.dots = value.isEmpty ? value : value.union(["any"]) }
        } catch {}
    }
}

private struct SidebarItemStyle: ButtonStyle {
    @State private var hovered = false

    func makeBody(configuration: ButtonStyleConfiguration) -> some View {
        configuration.label
            .background(hovered || configuration.isPressed ? Color.hover : .clear, in: .rect(cornerRadius: Radius.md))
            .onHover { hovered = $0 }
    }
}

/// All inboxes or one account, quiet at the top of the sidebar; picking one happens in a popover.
struct AccountPicker: View {
    /// In a phone's toolbar: the badge and name only.
    var bar = false
    @Environment(Mail.self) private var mail
    @State private var open = false
    @State private var archivedOpen = false

    var body: some View {
        Button { open.toggle() } label: {
            if bar {
                HStack(spacing: 8) {
                    badge(mail.scope, size: 26)
                    Text(mail.title(mail.scope)).font(.md.weight(.semibold)).foregroundStyle(.ink).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(.muted)
                }
                .padding(.trailing, 4)
                .fixedSize()
            } else {
            HStack(spacing: 8) {
                badge(mail.scope, size: 22)
                Text(mail.title(mail.scope)).font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(.faint)
            }
            .padding(.horizontal, 8)
            .frame(height: 36)
            .contentShape(.rect)
            }
        }
        .buttonStyle(SidebarItemStyle())
        .help("Switch account")
        .popover(isPresented: $open, arrowEdge: Device.phone ? .top : .bottom) {
            VStack(spacing: 2) {
                choice(nil)
                Rectangle().fill(.line).frame(height: 1).padding(.vertical, 4).padding(.horizontal, 8)
                if !mail.groups.isEmpty {
                    ForEach(mail.groups) { choice("group:\($0.id)") }
                    Rectangle().fill(.line).frame(height: 1).padding(.vertical, 4).padding(.horizontal, 8)
                }
                ForEach(mail.accountList) { choice($0.id) }
                // Archived accounts wait behind one row, like archived chats; picking one checks it for mail.
                let archived = mail.accounts.filter(\.archived)
                if !archived.isEmpty {
                    DisclosureGroup("Archived \(archived.count)", isExpanded: $archivedOpen) {
                        ForEach(archived) { choice($0.id) }
                    }
                    .font(.sm).foregroundStyle(.muted)
                    .padding(.horizontal, 8).padding(.top, 4)
                }
                Rectangle().fill(.line).frame(height: 1).padding(.vertical, 4).padding(.horizontal, 8)
                SettingsButton(page: .addAccount, before: { open = false }) {
                    HStack(spacing: 10) {
                        Image(systemName: "plus").font(.system(size: 12)).foregroundStyle(.muted).frame(width: 28, height: 28)
                        Text("Add account…").font(.sm).foregroundStyle(.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 40)
                    .contentShape(.rect)
                }
                .buttonStyle(SidebarItemStyle())
            }
            .padding(6)
            .frame(width: 272)
            .presentationCompactAdaptation(.popover)
        }
    }

    private func choice(_ choice: String?) -> some View {
        let picked = mail.scope == choice
        let key = mail.choices.firstIndex(of: choice).flatMap { $0 < 9 ? "⌘\($0 + 1)" : nil }
        return Button {
            mail.scope = choice
            open = false
            if let a = mail.accounts.first(where: { $0.id == choice }), a.archived {
                Task { _ = try? await API.client.syncAccount(path: .init(accountId: a.id)) }
            }
        } label: {
            HStack(spacing: 10) {
                badge(choice)
                VStack(alignment: .leading, spacing: 1) {
                    Text(mail.title(choice)).font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                    let detail = detail(choice)
                    if !detail.isEmpty { Text(detail).font(.xs).foregroundStyle(.muted).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if let key, !Device.phone { Text(key).font(.xs).foregroundStyle(.faint) }
                Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(.muted).opacity(picked ? 1 : 0)
            }
            .padding(.horizontal, 8)
            .frame(height: 44)
            .contentShape(.rect)
        }
        .buttonStyle(SidebarItemStyle())
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    @ViewBuilder private func badge(_ choice: String?, size: CGFloat = 28) -> some View {
        if let account = mail.accounts.first(where: { $0.id == choice }) {
            Avatar(name: account.name, size: size, color: account.color)
        } else {
            Image(systemName: choice == nil ? "tray.2" : "folder").font(.system(size: size * 0.43)).foregroundStyle(.muted)
                .frame(width: size, height: size).background(.line, in: .circle)
        }
    }

    private func detail(_ choice: String?) -> String {
        guard let choice else { return mail.accountList.count == 1 ? "1 account" : "\(mail.accountList.count) accounts" }
        if let g = mail.groups.first(where: { "group:\($0.id)" == choice }) {
            return mail.accounts.filter { g.accountIds.contains($0.id) }.map(\.name).joined(separator: ", ")
        }
        return mail.accounts.first { $0.id == choice }?.email ?? ""
    }
}

/// Who's signed in, at the bottom of the sidebar; signing out and starting at login live here.
struct Profile: View {
    /// In a phone's toolbar: the avatar only.
    var bar = false
    @Environment(Mail.self) private var mail

    var body: some View {
        Menu {
            if !mail.me.name.isEmpty { Text(mail.me.email) }
            SettingsButton { Text("Settings…") }
            #if os(macOS)
            LoginToggle()
            #endif
            Divider()
            Button("Sign Out") { Task { await mail.signOut() } }
        } label: {
            let name = mail.me.name.isEmpty ? mail.me.email : mail.me.name
            if bar {
                Avatar(name: name, size: 30).accessibilityLabel(name)
            } else {
            HStack(spacing: 8) {
                Avatar(name: name, size: 22)
                Text(name).font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(.faint)
            }
            .padding(.horizontal, 8)
            .frame(height: 36)
            .contentShape(.rect)
            }
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(SidebarItemStyle())
    }
}
