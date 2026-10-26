// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI
import UserNotifications
#if os(macOS)
import ServiceManagement
#endif

@main
struct NouvexApp: App {
    @State private var mail: Mail
    @Environment(\.scenePhase) private var phase
    private let notifications: Notifications
    #if os(iOS)
    @UIApplicationDelegateAdaptor(Pushes.self) private var pushes
    #endif

    init() {
        #if os(iOS)
        Keys.share()
        #endif
        let mail = Mail()
        _mail = State(initialValue: mail)
        notifications = Notifications(mail: mail)
        UNUserNotificationCenter.current().delegate = notifications
        // Syncing starts with the app, not with a window: at login it may open without one.
        mail.start()
    }

    var body: some Scene {
        WindowGroup("Nouvex Mail", id: "mail") {
            MailView()
                .environment(mail)
                .modifier(Appearance())
        }
        .onChange(of: phase) { _, phase in if phase == .active { mail.resume() } }
        .defaultSize(width: 1280, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) { NewMessage().environment(mail) }
            CommandGroup(after: .sidebar) { Choices().environment(mail) }
            #if os(iOS)
            CommandGroup(replacing: .appSettings) {
                SettingsButton { Text("Settings…") }.keyboardShortcut(",").environment(mail)
            }
            #endif
        }
        #if os(macOS)
        Settings {
            SettingsView()
                .environment(mail)
                .modifier(Appearance())
        }
        .windowResizability(.contentMinSize)
        // Closing the window keeps the app running here, so new mail still shows up.
        MenuBarExtra {
            MenuBarContent().environment(mail)
        } label: {
            Image(systemName: mail.inboxUnread > 0 ? "envelope.badge" : "envelope")
        }
        #endif
    }
}

/// Tapping a notification about new mail opens its conversation.
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    let mail: Mail

    init(mail: Mail) { self.mail = mail }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let thread = response.notification.request.content.threadIdentifier
        guard !thread.isEmpty else { return }
        let mail = mail
        await MainActor.run {
            mail.folder = .inbox
            mail.thread = thread
        }
    }
}

#if os(iOS)
/// Hands this iPhone's push token to the server, which pushes new mail while the app isn't running (NouvexNotify).
final class Pushes: NSObject, UIApplicationDelegate {
    static let tokenKey = "push token"

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        Task {
            let body = Operations.registerDevice.Input.Body.jsonPayload(token: hex, sandbox: sandbox, timeZone: TimeZone.current.identifier)
            if case .noContent = try await API.client.registerDevice(body: .json(body)) {
                UserDefaults.standard.set(hex, forKey: Self.tokenKey)
            }
        }
    }
}
#endif

/// A new message docks in the main window, which opens for it if it's closed.
struct NewMessage: View {
    @Environment(Mail.self) private var mail
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("New Message", systemImage: "square.and.pencil") {
            mail.compose = mail.compose ?? Draft(accountId: mail.sender)
            openWindow(id: "mail")
        }
        .keyboardShortcut("n")
    }
}

/// All inboxes, the groups and the accounts in the picker's order, as ⌘1 to ⌘9.
struct Choices: View {
    @Environment(Mail.self) private var mail

    var body: some View {
        let choices = Array(mail.choices.prefix(9).enumerated())
        ForEach(choices, id: \.offset) { i, choice in
            Button(mail.title(choice)) { mail.scope = choice }
                .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")))
        }
    }
}

#if os(macOS)
struct MenuBarContent: View {
    @Environment(Mail.self) private var mail
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if mail.state == .signedIn {
            Text(mail.inboxUnread == 0 ? "No unread mail" : "\(mail.inboxUnread) unread")
            ForEach(mail.recent) { m in
                Button("\(m.sender): \(m.subject)") { show(m.threadId) }
            }
            Divider()
        }
        Button("Open Nouvex Mail") { show(nil) }.keyboardShortcut("o")
        NewMessage()
        LoginToggle()
        if mail.state == .signedIn { Button("Sign Out") { Task { await mail.signOut() } } }
        Divider()
        Button("Quit Nouvex Mail") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private func show(_ thread: String?) {
        if let thread {
            mail.folder = .inbox
            mail.thread = thread
        }
        openWindow(id: "mail")
        NSApp.activate()
    }
}

/// Starts the app when the Mac does, so new mail shows up without opening it.
struct LoginToggle: View {
    var body: some View {
        Toggle("Open at Login", isOn: Binding(
            get: { SMAppService.mainApp.status == .enabled },
            set: { on in try? on ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister() }
        ))
    }
}
#endif
