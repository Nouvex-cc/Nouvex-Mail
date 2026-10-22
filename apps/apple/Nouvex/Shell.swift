// SPDX-License-Identifier: AGPL-3.0-only
import GRDB
import SwiftUI

/// A native split view: the sidebar on Liquid Glass, the mail on paper, title, search and actions in the toolbar. A
/// conversation is pushed over its list. A new message docks in the bottom right, or comes up as a sheet on a phone.
struct Shell: View {
    @Environment(Mail.self) private var mail
    @State private var query = ""
    @State private var column = NavigationSplitViewColumn.detail
    @FocusState private var searching: Bool
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var size
    #endif

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            Sidebar { column = .detail }.navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 320)
        } detail: {
            NavigationStack {
                MailList(query: $query, searching: $searching)
                    .navigationDestination(item: Binding(get: { mail.thread }, set: { mail.thread = $0 })) { thread in
                        ThreadView(threadId: thread).id(thread)
                    }
            }
            .overlay(alignment: .bottomTrailing) {
                if !Device.phone, mail.compose != nil { Composer(placement: .dock).padding(.trailing, 20) }
            }
        }
        .sheet(isPresented: Binding(
            get: { Device.phone && (mail.compose != nil || mail.reply != nil) },
            set: { if !$0 { mail.compose = nil; mail.reply = nil } }
        )) {
            Composer(placement: .sheet)
        }
        .overlay(alignment: .bottom) { Toasts().padding(.bottom, 84) }
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

extension Folder {
    var name: String {
        switch self {
        case .inbox: "Inbox"
        case .starred: "Starred"
        case .category(let id): Sidebar.categories.first { $0.0 == id }?.1 ?? ""
        case .role(let role): Sidebar.folders.first { $0.0 == role }?.1 ?? ""
        case .mailbox(_, let name): name
        }
    }
}

struct Sidebar: View {
    /// Brings the list into view where the sidebar covers it, like a phone.
    let show: () -> Void
    @Environment(Mail.self) private var mail
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
        List(selection: Binding(get: { mail.folder }, set: { folder in
            guard let folder else { return }
            mail.folder = folder
            mail.thread = nil
            show()
        })) {
            if mail.categories {
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
            row("Starred", icon: "star", folder: .starred)
            // An account's own folders, only while one account is in view, like the web.
            if mail.account != nil, !own.isEmpty {
                #if os(macOS)
                DisclosureGroup("Folders", isExpanded: $ownOpen) {
                    ForEach(own, id: \.id) { b in row(b.name, icon: "folder", folder: .mailbox(b.id, b.name)) }
                }
                #else
                Section("Folders") {
                    ForEach(own, id: \.id) { b in row(b.name, icon: "folder", folder: .mailbox(b.id, b.name)) }
                }
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
            VStack(alignment: .leading, spacing: 12) {
                Image(.logo).resizable().scaledToFit().frame(height: 16).foregroundStyle(.ink)
                    .padding(.leading, 10)
                    .accessibilityLabel("Nouvex Mail")
                AccountPicker()
                // A phone writes from the list's bottom bar.
                if !Device.phone {
                    Button { mail.compose = mail.compose ?? Draft(accountId: mail.account) } label: {
                        Label("Write", systemImage: "square.and.pencil").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .help("New message (⌘N)")
                }
            }
            .padding(.horizontal, 10)
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
        .task(id: mail.account) { await observeDots() }
        .task(id: mail.account) { await observeFolders() }
    }

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
    private func observeDots() async {
        let account = mail.account
        let dots = ValueObservation.tracking { db in
            var sql = "SELECT DISTINCT category FROM message WHERE seen = 0 AND mailboxId IN (SELECT id FROM mailbox WHERE role = 'inbox')"
            var args: StatementArguments = []
            if let account {
                sql += " AND accountId = ?"
                args = [account]
            }
            return try Set(String.fetchAll(db, sql: sql, arguments: args))
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
            .background(hovered ? Color.hover : .clear, in: .rect(cornerRadius: Radius.md))
            .onHover { hovered = $0 }
    }
}

/// All inboxes or one account, quiet at the top of the sidebar; picking one happens in a popover.
struct AccountPicker: View {
    @Environment(Mail.self) private var mail
    @State private var open = false
    @State private var archivedOpen = false

    var body: some View {
        let current = mail.accounts.first { $0.id == mail.account }
        Button { open.toggle() } label: {
            HStack(spacing: 10) {
                badge(current)
                VStack(alignment: .leading, spacing: 1) {
                    Text(current?.email ?? "All inboxes").font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                    Text(subtitle(current)).font(.xs).foregroundStyle(.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(.faint)
            }
            .padding(.horizontal, 8)
            .frame(height: 48)
            .contentShape(.rect)
        }
        .buttonStyle(SidebarItemStyle())
        .help("Switch account")
        .popover(isPresented: $open, arrowEdge: Device.phone ? .top : .bottom) {
            VStack(spacing: 2) {
                choice(nil)
                Rectangle().fill(.line).frame(height: 1).padding(.vertical, 4).padding(.horizontal, 8)
                ForEach(mail.accountList) { choice($0) }
                // Archived accounts wait behind one row, like archived chats; picking one checks it for mail.
                let archived = mail.accounts.filter(\.archived)
                if !archived.isEmpty {
                    DisclosureGroup("Archived \(archived.count)", isExpanded: $archivedOpen) {
                        ForEach(archived) { choice($0) }
                    }
                    .font(.sm).foregroundStyle(.muted)
                    .padding(.horizontal, 8).padding(.top, 4)
                }
            }
            .padding(6)
            .frame(width: 272)
            .presentationCompactAdaptation(.popover)
        }
    }

    private func choice(_ account: Account?) -> some View {
        let picked = mail.account == account?.id
        return Button {
            mail.account = account?.id
            open = false
            if let account, account.archived { Task { _ = try? await API.client.syncAccount(path: .init(accountId: account.id)) } }
        } label: {
            HStack(spacing: 10) {
                badge(account)
                VStack(alignment: .leading, spacing: 1) {
                    Text(account?.email ?? "All inboxes").font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                    let detail = account.map(\.displayName) ?? subtitle(nil)
                    if !detail.isEmpty { Text(detail).font(.xs).foregroundStyle(.muted).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if picked { Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(.muted) }
            }
            .padding(.horizontal, 8)
            .frame(height: 44)
            .contentShape(.rect)
        }
        .buttonStyle(SidebarItemStyle())
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    @ViewBuilder private func badge(_ account: Account?) -> some View {
        if let account {
            Avatar(name: account.displayName.isEmpty ? account.email : account.displayName, size: 28)
        } else {
            Image(systemName: "tray.2").font(.system(size: 12)).foregroundStyle(.muted)
                .frame(width: 28, height: 28).background(.line, in: .circle)
        }
    }

    private func subtitle(_ account: Account?) -> String {
        guard let account else { return mail.accountList.count == 1 ? "1 account" : "\(mail.accountList.count) accounts" }
        return account.displayName.isEmpty ? "Only this account" : account.displayName
    }
}

/// Who's signed in, at the bottom of the sidebar; signing out and starting at login live here.
struct Profile: View {
    @Environment(Mail.self) private var mail

    var body: some View {
        Menu {
            #if os(macOS)
            LoginToggle()
            Divider()
            #endif
            Button("Sign Out") { Task { await mail.signOut() } }
        } label: {
            HStack(spacing: 10) {
                Avatar(name: mail.me.name.isEmpty ? mail.me.email : mail.me.name)
                VStack(alignment: .leading, spacing: 1) {
                    Text(mail.me.name).font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                    Text(mail.me.email).font(.xs).foregroundStyle(.muted).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(.muted)
            }
            .padding(.horizontal, 8)
            .frame(height: 48)
            .contentShape(.rect)
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(SidebarItemStyle())
    }
}
