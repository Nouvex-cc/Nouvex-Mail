// SPDX-License-Identifier: AGPL-3.0-only
import CoreImage.CIFilterBuiltins
import SwiftUI

/// The pages of Settings, the same as the web's.
enum SettingsPage: Hashable {
    case reading, writing, shortcuts, account(String), addAccount, profile, security, appearance
}

/// Settings: its own window on the Mac (⌘,), a sheet on iOS.
struct SettingsView: View {
    @Environment(Mail.self) private var mail

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { mail.settings }, set: { mail.settings = $0 })) {
                Section("Mail") {
                    Label("Reading", systemImage: "book").tag(SettingsPage.reading)
                    Label("Writing", systemImage: "pencil.line").tag(SettingsPage.writing)
                    Label("Shortcuts", systemImage: "keyboard").tag(SettingsPage.shortcuts)
                }
                Section("Accounts") {
                    // Archived accounts come last, marked by their icon.
                    ForEach(mail.accountList + mail.accounts.filter(\.archived)) { a in
                        Label(a.email, systemImage: a.archived ? "archivebox" : "envelope").tag(SettingsPage.account(a.id))
                    }
                    Label("Add account", systemImage: "plus").tag(SettingsPage.addAccount)
                }
                Section("You") {
                    Label("Profile", systemImage: "person").tag(SettingsPage.profile)
                    Label("Security", systemImage: "lock.shield").tag(SettingsPage.security)
                }
                Section("App") {
                    Label("Appearance", systemImage: "circle.lefthalf.filled").tag(SettingsPage.appearance)
                }
            }
            .navigationTitle("Settings")
            #if os(macOS)
            .navigationSplitViewColumnWidth(250)
            .toolbar(removing: .sidebarToggle)
            #else
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { mail.settingsOpen = false } }
            }
            #endif
        } detail: {
            if let page = mail.settings { detail(page).formStyle(.grouped) }
        }
        #if os(macOS)
        .frame(minWidth: 760, minHeight: 540)
        #endif
    }

    @ViewBuilder private func detail(_ page: SettingsPage) -> some View {
        switch page {
        case .reading: ReadingPage()
        case .writing: WritingPage()
        case .shortcuts: ShortcutsPage()
        case .account(let id):
            if let a = mail.accounts.first(where: { $0.id == id }) { AccountPage(account: a).id(id) }
        case .addAccount: AddAccountPage()
        case .profile: ProfilePage()
        case .security: SecurityPage()
        case .appearance: AppearancePage()
        }
    }
}

/// Opens Settings on a page, or where it was left when `page` is nil.
struct SettingsButton<Content: View>: View {
    @Environment(Mail.self) private var mail
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #endif
    var page: SettingsPage?
    /// Runs first, to close a popover the sheet can't come up over.
    var before: () -> Void = {}
    @ViewBuilder let label: () -> Content

    var body: some View {
        Button {
            before()
            #if os(macOS)
            if let page { mail.settings = page }
            openSettings()
            #else
            mail.settings = page ?? (Device.phone ? nil : .reading)
            // A popover still on its way out keeps the sheet from coming up.
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                mail.settingsOpen = true
            }
            #endif
        } label: { label() }
    }
}

// MARK: Mail

/// A preference with a few choices: side by side on the Mac when there are up to three, a menu otherwise.
private struct Choice<Value: Hashable>: View {
    @Environment(Mail.self) private var mail
    let label: String
    let hint: String
    let key: WritableKeyPath<Prefs, Value>
    let options: [(Value, String)]

    var body: some View {
        LabeledContent {
            let picker = Picker(label, selection: Binding(get: { mail.prefs[keyPath: key] }, set: { v in mail.set { $0[keyPath: key] = v } })) {
                ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
            }
            .labelsHidden()
            .fixedSize()
            #if os(macOS)
            if options.count <= 3 { picker.pickerStyle(.segmented) } else { picker.pickerStyle(.menu) }
            #else
            picker.pickerStyle(.menu)
            #endif
        } label: {
            Text(label)
            Text(hint)
        }
    }
}

private struct PrefToggle: View {
    @Environment(Mail.self) private var mail
    let label: String
    let hint: String
    let key: WritableKeyPath<Prefs, Bool>

    var body: some View {
        Toggle(isOn: Binding(get: { mail.prefs[keyPath: key] }, set: { v in mail.set { $0[keyPath: key] = v } })) {
            Text(label)
            Text(hint)
        }
    }
}

private struct ReadingPage: View {
    var body: some View {
        Form {
            Section {
                Choice(label: "Mark as read", hint: "When you open a conversation", key: \.markRead, options: [
                    ("instant", "Right away"), ("delay", "After 2 s"), ("never", "Never"),
                ])
                Choice(label: "Pictures in mail", hint: "They load through Nouvex, so senders don't see when or where you read", key: \.remoteImages, options: [
                    ("always", "Show"), ("ask", "Ask first"),
                ])
                PrefToggle(label: "Categories", hint: "Promotions, social networks, updates and newsletters get their own place under Inbox", key: \.categories)
                PrefToggle(label: "Replies to archived accounts", hint: "Answers to mail you sent from an archived account still show in All inboxes", key: \.archivedReplies)
                Choice(label: "After archiving or deleting", hint: "From an open conversation", key: \.afterArchive, options: [
                    ("next", "Next"), ("previous", "Previous"), ("list", "Back to list"),
                ])
                Choice(label: "Meetings in the sidebar", hint: "How long before they start, with a button to join", key: \.meetingLead, options: [
                    (5, "5 minutes"), (10, "10 minutes"), (15, "15 minutes"), (30, "30 minutes"), (60, "1 hour"),
                ])
                Choice(label: "Sign-in codes in the sidebar", hint: "How long after they arrive", key: \.codeLife, options: [
                    (1, "1 minute"), (5, "5 minutes"), (10, "10 minutes"), (15, "15 minutes"),
                ])
            }
        }
        .navigationTitle("Reading")
    }
}

private struct WritingPage: View {
    var body: some View {
        Form {
            Section {
                Choice(label: "Undo send", hint: "How long a sent message can still be taken back", key: \.undoSend, options: [
                    (0, "Off"), (5, "5 seconds"), (10, "10 seconds"), (20, "20 seconds"), (30, "30 seconds"),
                ])
                Choice(label: "R replies to", hint: "Reply all only when there is more than one other person", key: \.replyDefault, options: [
                    ("reply", "Sender"), ("all", "Everyone"),
                ])
            }
        }
        .navigationTitle("Writing")
    }
}

/// Every shortcut in the app, for Settings and the "?" sheet.
private let shortcuts: [(String, [(String, String)])] = [
    ("Anywhere", [("⌘F", "Search"), ("⌘N", "New message"), ("⌘,", "Settings"), ("?", "All shortcuts")]),
    ("List", [
        ("J", "Next conversation"), ("K", "Previous conversation"), ("↩", "Open"), ("X", "Select"), ("⇧X", "Select up to here"),
        ("⌘A", "Select all"), ("Esc", "Clear selection"),
    ]),
    ("Conversation", [
        ("R", "Reply"), ("A", "Reply all"), ("F", "Forward"), ("E", "Archive"), ("#", "Delete"), ("S", "Star"), ("⇧U", "Mark as unread"),
        ("H", "Snooze"),
    ]),
    ("Writing", [("⌘↩", "Send")]),
]

struct ShortcutsPage: View {
    var body: some View {
        Form {
            ForEach(shortcuts, id: \.0) { group in
                Section(group.0) {
                    ForEach(group.1, id: \.1) { keys, label in
                        LabeledContent(label) {
                            Text(keys).font(.sm.monospaced()).foregroundStyle(.ink)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.hover, in: .rect(cornerRadius: Radius.md))
                        }
                    }
                }
            }
        }
        .navigationTitle("Shortcuts")
    }
}

/// The "?" sheet in the main window.
struct ShortcutsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ShortcutsPage()
                .formStyle(.grouped)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(width: 420, height: 560)
        #endif
    }
}

/// On iOS a field in a form shows only its placeholder; the label goes in front of it, like in the Settings app.
private struct Labeled: ViewModifier {
    let label: String
    init(_ label: String) { self.label = label }

    func body(content: Content) -> some View {
        #if os(iOS)
        LabeledContent(label) { content.multilineTextAlignment(.trailing) }
        #else
        content
        #endif
    }
}

// MARK: Accounts

private struct AccountPage: View {
    @Environment(Mail.self) private var mail
    let account: Account
    @State private var name = ""
    @State private var signature = ""
    @State private var saved = false

    var body: some View {
        Form {
            if let error = account.syncError {
                Section {
                    Label {
                        Text("Couldn't sync")
                        Text(error)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.danger)
                    }
                }
            }
            Section("Sending") {
                TextField(text: $name, prompt: Text(account.email)) {
                    Text("Name")
                    Text("Shown next to your address")
                }
                .modifier(Labeled("Name"))
                VStack(alignment: .leading, spacing: 6) {
                    Text("Signature")
                    Text("Added below new messages and replies").font(.xs).foregroundStyle(.muted)
                    TextEditor(text: $signature)
                        .font(.md).frame(minHeight: 96).scrollContentBackground(.hidden)
                        .padding(6).background(.hover, in: .rect(cornerRadius: Radius.md))
                }
                HStack {
                    Spacer()
                    Button(saved ? "Saved" : "Save") { Task { await save() } }
                        .buttonStyle(.glassProminent)
                        .disabled(name == account.displayName && signature == account.signature)
                }
            }
            Section {
                Toggle(isOn: Binding(get: { account.archived }, set: { on in Task { await archive(on) } })) {
                    Text("Archive")
                    Text("Out of All inboxes and the account picker, checked for mail once a day. Still there under Archived.")
                }
                LabeledContent {
                    HoldButton(title: "Remove") {
                        mail.settings = .reading
                        Task { await mail.remove(account) }
                    }
                } label: {
                    Text("Remove account")
                    Text("Its mail is removed from Nouvex, the mailbox itself stays as it is")
                }
            }
        }
        .navigationTitle(account.email)
        .onAppear {
            name = account.displayName
            signature = account.signature
        }
        .onChange(of: name) { saved = false }
        .onChange(of: signature) { saved = false }
    }

    private func save() async {
        let change = Operations.updateAccount.Input.Body.jsonPayload(displayName: name, signature: signature)
        guard case .noContent = try? await API.client.updateAccount(path: .init(accountId: account.id), body: .json(change)) else {
            return mail.toast("Couldn't save \(account.email)")
        }
        try? await mail.loadAccounts()
        saved = true
    }

    private func archive(_ on: Bool) async {
        let change = Operations.updateAccount.Input.Body.jsonPayload(archived: on)
        guard case .noContent = try? await API.client.updateAccount(path: .init(accountId: account.id), body: .json(change)) else {
            return mail.toast("Couldn't change \(account.email)")
        }
        try? await mail.loadAccounts()
    }
}

private struct AddAccountPage: View {
    @Environment(Mail.self) private var mail
    @State private var email = ""
    @State private var password = ""
    @State private var username = ""
    @State private var imapHost = ""
    @State private var imapPort = 993
    @State private var smtpHost = ""
    @State private var smtpPort = 465
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            Section {
                TextField("Email", text: $email, prompt: Text(verbatim: "you@example.com")).textContentType(.emailAddress).modifier(Labeled("Email"))
                SecureField("Password", text: $password, prompt: Text("Required")).modifier(Labeled("Password"))
                TextField("Username", text: $username, prompt: Text("Leave empty to use the email address")).modifier(Labeled("Username"))
            }
            Section {
                TextField("IMAP server", text: $imapHost, prompt: Text("e.g. imap.example.com")).modifier(Labeled("IMAP server"))
                TextField("IMAP port", value: $imapPort, format: .number.grouping(.never)).modifier(Labeled("IMAP port"))
                TextField("SMTP server", text: $smtpHost, prompt: Text("e.g. smtp.example.com")).modifier(Labeled("SMTP server"))
                TextField("SMTP port", value: $smtpPort, format: .number.grouping(.never)).modifier(Labeled("SMTP port"))
            }
            Section {
                if let error { Text(error).foregroundStyle(.danger) }
                HStack {
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    Button("Add") { Task { await add() } }
                        .buttonStyle(.glassProminent)
                        .disabled(busy || email.isEmpty || password.isEmpty || imapHost.isEmpty || smtpHost.isEmpty)
                }
            }
        }
        #if os(iOS)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        #endif
        .navigationTitle("Add account")
    }

    private func add() async {
        busy = true
        defer { busy = false }
        let fields = Operations.createAccount.Input.Body.jsonPayload(
            email: email, imapHost: imapHost, imapPort: imapPort, smtpHost: smtpHost, smtpPort: smtpPort,
            username: username.isEmpty ? email : username, password: password
        )
        switch try? await API.client.createAccount(body: .json(fields)) {
        case .created(let created):
            error = nil
            try? await mail.loadAccounts()
            if let id = try? created.body.json.id { mail.settings = .account(id) }
            mail.resume()
        // The engine tried to sign in; its answer says what the server didn't like.
        case .unprocessableContent(let refused): error = (try? refused.body.json.error) ?? "The server said no."
        default: error = "Couldn't add the account. Check the fields and try again."
        }
    }
}

// MARK: You

/// Changes that could lock someone out ask for the password first.
private struct Confirm: View {
    let title: String
    let action: String
    var newPassword = false
    let run: (_ password: String, _ new: String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var new = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section(title) {
                    if newPassword { SecureField("New password", text: $new).textContentType(.newPassword).modifier(Labeled("New password")) }
                    SecureField("Your password", text: $password).textContentType(.password).modifier(Labeled("Your password"))
                    if let error { Text(error).foregroundStyle(.danger) }
                }
            }
            .formStyle(.grouped)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action) { Task { await confirm() } }
                        .disabled(busy || password.isEmpty || (newPassword && new.count < 8))
                }
            }
        }
        #if os(macOS)
        .frame(width: 380)
        #endif
    }

    private func confirm() async {
        busy = true
        defer { busy = false }
        do {
            try await run(password, new)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct ProfilePage: View {
    @Environment(Mail.self) private var mail
    @State private var name = ""
    @State private var ask: Ask?

    private enum Ask: Identifiable {
        case password, delete
        var id: Self { self }
    }

    var body: some View {
        Form {
            Section {
                TextField(text: $name) {
                    Text("Name")
                    Text("Shown to you in Nouvex, not to people you write to")
                }
                .modifier(Labeled("Name"))
                .onSubmit { Task { await rename() } }
                LabeledContent {
                    Text(mail.me.email)
                } label: {
                    Text("Email")
                    Text("What you sign in with")
                }
                LabeledContent {
                    Button("Change…") { ask = .password }
                } label: {
                    Text("Password")
                    Text("Changing it signs you out everywhere else")
                }
            }
            Section {
                LabeledContent {
                    Button("Delete…", role: .destructive) { ask = .delete }
                } label: {
                    Text("Delete your Nouvex account")
                    Text("Removes your accounts, settings and everything synced. Your mailboxes stay as they are.")
                }
            }
        }
        .navigationTitle("Profile")
        .onAppear { name = mail.me.name }
        .onDisappear { Task { await rename() } }
        .sheet(item: $ask) { ask in
            switch ask {
            case .password:
                Confirm(title: "Change password", action: "Change", newPassword: true) { password, new in
                    try await API.auth("change-password", ["currentPassword": password, "newPassword": new, "revokeOtherSessions": true])
                    mail.toast("Password changed")
                }
            case .delete:
                Confirm(title: "Delete your Nouvex account?", action: "Delete for good") { password, _ in
                    try await API.auth("delete-user", ["password": password])
                    mail.settingsOpen = false
                    await mail.signOut()
                }
            }
        }
    }

    private func rename() async {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != mail.me.name else { return }
        guard (try? await API.auth("update-user", ["name": name])) != nil else { return mail.toast("Couldn't save your name") }
        mail.me.name = name
        mail.toast("Name saved")
    }
}

private struct SecurityPage: View {
    @Environment(Mail.self) private var mail
    @State private var twoFactor = false
    @State private var current = ""
    @State private var sessions: [Session] = []
    @State private var setup: (uri: String, codes: [String])?
    @State private var fresh: [String]?
    @State private var code = ""
    @State private var codeError: String?
    @State private var ask: Ask?

    private enum Ask: Identifiable {
        case on, off, codes
        var id: Self { self }
    }

    struct Session: Identifiable {
        let id: String
        let token: String
        let agent: String
        let active: Date
    }

    var body: some View {
        Form {
            Section {
                LabeledContent {
                    if setup == nil {
                        if twoFactor {
                            HStack {
                                Button("New backup codes…") { ask = .codes }
                                Button("Turn off…") { ask = .off }
                            }
                        } else {
                            Button("Turn on…") { ask = .on }
                        }
                    }
                } label: {
                    Text("Two-factor authentication")
                    Text(twoFactor ? "On. Signing in also asks for a code from your authenticator app." : "Off")
                }
                if let setup { enroll(setup) }
                if let fresh { backupCodes(fresh) }
            }
            Section("Where you're signed in") {
                ForEach(sessions) { s in
                    LabeledContent {
                        if s.token != current {
                            Button("Sign out") { Task { await revoke(s.token) } }
                        }
                    } label: {
                        Text(device(s.agent))
                        Text(s.token == current ? "This device" : "Last active \(s.active.formatted(date: .abbreviated, time: .shortened))")
                    }
                }
                if sessions.count > 1 {
                    LabeledContent("Sign out everywhere else") {
                        Button("Sign out others") { Task { await revoke(nil) } }
                    }
                }
            }
        }
        .navigationTitle("Security")
        .task { await load() }
        .sheet(item: $ask) { ask in
            switch ask {
            case .on:
                Confirm(title: "Turn on two-factor", action: "Continue") { password, _ in
                    let res = try await API.auth("two-factor/enable", ["password": password])
                    if let uri = res["totpURI"] as? String { setup = (uri, res["backupCodes"] as? [String] ?? []) }
                }
            case .off:
                Confirm(title: "Turn off two-factor?", action: "Turn off") { password, _ in
                    try await API.auth("two-factor/disable", ["password": password])
                    fresh = nil
                    await load()
                }
            case .codes:
                Confirm(title: "New backup codes", action: "Continue") { password, _ in
                    fresh = try await API.auth("two-factor/generate-backup-codes", ["password": password])["backupCodes"] as? [String]
                }
            }
        }
    }

    private func enroll(_ setup: (uri: String, codes: [String])) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 20) {
                // Always dark on light: plenty of scanners can't read it the other way round.
                if let qr = qr(setup.uri) {
                    qr.interpolation(.none).resizable().frame(width: 160, height: 160).clipShape(.rect(cornerRadius: Radius.md))
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Scan this with your authenticator app, or enter the key by hand:")
                    Text(URLComponents(string: setup.uri)?.queryItems?.first { $0.name == "secret" }?.value ?? "")
                        .font(.sm.monospaced()).textSelection(.enabled)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.hover, in: .rect(cornerRadius: Radius.md))
                    Text("Then type the code it shows.").foregroundStyle(.muted)
                    HStack {
                        TextField("Code", text: $code, prompt: Text("123456"))
                            .labelsHidden().frame(width: 120)
                            #if os(iOS)
                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                            #endif
                            .onSubmit { Task { await verify() } }
                        Button("Verify") { Task { await verify() } }.disabled(code.count < 6)
                    }
                    if let codeError { Text(codeError).foregroundStyle(.danger) }
                }
                .font(.sm)
            }
            backupCodes(setup.codes)
        }
    }

    private func backupCodes(_ codes: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Backup codes, each works once when your phone isn't at hand:").font(.sm).foregroundStyle(.muted)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: Device.phone ? 2 : 5), alignment: .leading) {
                ForEach(codes, id: \.self) { Text($0) }
            }
            .font(.sm.monospaced()).textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.hover, in: .rect(cornerRadius: Radius.md))
        }
    }

    private func verify() async {
        do {
            try await API.auth("two-factor/verify-totp", ["code": code])
            setup = nil
            code = ""
            codeError = nil
            mail.toast("Two-factor is on", "Keep your backup codes somewhere safe.")
            await load()
        } catch {
            codeError = error.localizedDescription
        }
    }

    /// One session, or all but this one.
    private func revoke(_ token: String?) async {
        do {
            if let token { try await API.auth("revoke-session", ["token": token]) } else { try await API.auth("revoke-other-sessions", [:]) }
        } catch {
            mail.toast("Couldn't sign that out")
        }
        await load()
    }

    private func load() async {
        if let session = try? await API.auth("get-session", nil) {
            twoFactor = (session["user"] as? [String: Any])?["twoFactorEnabled"] as? Bool == true
            current = (session["session"] as? [String: Any])?["token"] as? String ?? ""
        }
        let list = (try? await API.authList("list-sessions")) ?? []
        sessions = list.compactMap { s in
            guard let id = s["id"] as? String, let token = s["token"] as? String else { return nil }
            let active = (s["updatedAt"] as? String).flatMap { try? ISODates().decode($0) } ?? .distantPast
            return Session(id: id, token: token, agent: s["userAgent"] as? String ?? "", active: active)
        }
        .sorted { ($0.token == current ? 1 : 0, $0.active) > ($1.token == current ? 1 : 0, $1.active) }
    }

    private func qr(_ text: String) -> Image? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let image = filter.outputImage, let cg = CIContext().createCGImage(image, from: image.extent) else { return nil }
        return Image(decorative: cg, scale: 1)
    }
}

// Enough to tell devices apart, like the web: the browser and the system it runs on. Edge says Chrome too, Chrome says
// Safari. This app says "Nouvex Mail (macOS)", before that it sent CFNetwork's.
private func device(_ agent: String) -> String {
    let browsers = [("Nouvex Mail", "Nouvex Mail"), ("CFNetwork", "Nouvex Mail"), ("Edg/", "Edge"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")]
    let systems = [("iPhone", "iOS"), ("iPad", "iOS"), ("(iOS)", "iOS"), ("Mac OS X", "macOS"), ("(macOS)", "macOS"), ("Android", "Android"), ("Windows", "Windows"), ("Linux", "Linux")]
    let browser = browsers.first { agent.contains($0.0) }?.1 ?? "Browser"
    return systems.first { agent.contains($0.0) }.map { "\(browser) on \($0.1)" } ?? browser
}

// MARK: Appearance

private struct AppearancePage: View {
    @AppStorage("appearance") private var appearance = "system"

    var body: some View {
        Form {
            Section {
                LabeledContent {
                    Picker("Mode", selection: $appearance) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .labelsHidden()
                    .fixedSize()
                    #if os(macOS)
                    .pickerStyle(.segmented)
                    #endif
                } label: {
                    Text("Mode")
                    Text("System follows your device")
                }
            }
        }
        .navigationTitle("Appearance")
    }
}

/// Light, dark or the system's, kept on this device.
struct Appearance: ViewModifier {
    @AppStorage("appearance") private var appearance = "system"

    func body(content: Content) -> some View {
        #if os(macOS)
        // App-wide, so search suggestions, menus and every window follow too.
        content.onChange(of: appearance, initial: true) {
            NSApp.appearance = appearance == "system" ? nil : NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
        }
        #else
        content.preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        #endif
    }
}
