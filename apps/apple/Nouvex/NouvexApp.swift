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

    init() {
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
        }
        .onChange(of: phase) { _, phase in if phase == .active { mail.resume() } }
        .defaultSize(width: 1280, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) { NewMessage().environment(mail) }
        }
        #if os(macOS)
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

/// A new message docks in the main window, which opens for it if it's closed.
struct NewMessage: View {
    @Environment(Mail.self) private var mail
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("New Message", systemImage: "square.and.pencil") {
            mail.compose = mail.compose ?? Draft(accountId: mail.account)
            openWindow(id: "mail")
        }
        .keyboardShortcut("n")
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
