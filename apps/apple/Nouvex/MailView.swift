// SPDX-License-Identifier: AGPL-3.0-only
import CryptoKit
import SwiftUI

struct MailView: View {
    @Environment(Mail.self) private var mail

    var body: some View {
        switch mail.state {
        case .loading: Color.sunken.ignoresSafeArea()
        case .signedOut: SignInView()
        case .signedIn: if mail.unlocked { Shell() } else { UnlockView() }
        }
    }
}

/// A quiet landing with the app on a phone and a glass panel at the bottom: the ways in, then the form in the same
/// panel, which takes the size of each step. The server is ours unless someone hosts their own.
struct SignInView: View {
    @Environment(Mail.self) private var mail
    @State private var server = Server.url.absoluteString
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var askCode = false
    /// Kept from the password until the code is in, to unlock the key then.
    @State private var encKey: SymmetricKey?
    @State private var error: String?
    @State private var busy = false
    @State private var open = false
    @State private var editingServer = false
    @FocusState private var focus: String?

    var body: some View {
        ZStack(alignment: .bottom) {
            Landing().ignoresSafeArea(.keyboard)
            // One glass panel on the bottom edge: the ways in first, then the form in its place, at each step's size.
            VStack(spacing: 12) {
                if open { form.transition(.opacity) } else { start.transition(.opacity) }
            }
            .padding(.horizontal, 24).padding(.top, open ? 20 : 24).padding(.bottom, 32)
            .frame(maxWidth: 440)
            .glass(in: .rect(cornerRadius: 44))
            .padding(8)
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .animation(.smooth(duration: 0.3), value: open)
        .animation(.smooth(duration: 0.3), value: askCode)
        .animation(.smooth(duration: 0.3), value: editingServer)
        .animation(.smooth(duration: 0.3), value: error)
    }

    private var start: some View {
        VStack(spacing: 12) {
            Button { show(true) } label: { Text("Sign in").frame(maxWidth: .infinity) }
                .glassButton(prominent: true)
                .controlSize(.extraLarge)
                .keyboardShortcut(.defaultAction)
            if Passkeys.available(on: URL(string: server)) {
                Button { Task { await passkey() } } label: {
                    Label("Use a passkey", systemImage: "person.badge.key").frame(maxWidth: .infinity)
                }
                .glassButton()
                .controlSize(.extraLarge)
                .disabled(busy)
            }
            Button("Use your own server") {
                editingServer = true
                show(true)
            }
            .font(.md.weight(.medium)).foregroundStyle(.muted).buttonStyle(.plain)
            .padding(.top, 4)
            if let error { Text(error).font(.sm).foregroundStyle(.danger) }
        }
    }

    private var form: some View {
        VStack(spacing: 12) {
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 6) {
                    if askCode {
                        Text("Two-factor code").font(.title2.weight(.semibold)).foregroundStyle(.ink)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text("Sign in to").font(.title2.weight(.semibold))
                            // The wordmark's letters sit on the text's baseline.
                            Image(.logo).resizable().scaledToFit().frame(height: 15)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
                                .accessibilityLabel("Nouvex")
                        }
                        .foregroundStyle(.ink)
                    }
                    if askCode {
                        Text("Enter the code from your authenticator app.").font(.md).foregroundStyle(.muted)
                    } else {
                        // Where this signs in; people who host their own server change it here.
                        Button { editingServer.toggle() } label: {
                            Label(URL(string: server)?.host() ?? server, systemImage: "link").font(.md)
                        }
                        .buttonStyle(.plain).foregroundStyle(.muted)
                        .help("Change server")
                    }
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, 28)
                Button("Close", systemImage: "xmark") { show(false) }
                    .labelStyle(.iconOnly).glassButton().buttonBorderShape(.circle).controlSize(.large)
            }
            .padding(.bottom, 8)
            if askCode {
                field("Code", text: $code)
                    #if os(iOS)
                    .keyboardType(.numberPad).textContentType(.oneTimeCode)
                    #endif
            } else {
                if editingServer {
                    VStack(alignment: .leading, spacing: 6) {
                        field("Server", text: $server)
                            #if os(iOS)
                            .keyboardType(.URL).textContentType(.URL)
                            #endif
                        Text("The address of your own Nouvex server, if you host one.").font(.xs).foregroundStyle(.muted)
                    }
                    .transition(.opacity)
                }
                field("Email", text: $email)
                    #if os(iOS)
                    .keyboardType(.emailAddress).textContentType(.username)
                    #endif
                SecureField("Password", text: $password, prompt: Text("Password").foregroundStyle(.faint))
                    .focused($focus, equals: "Password").modifier(Field(focused: focus == "Password", large: true))
                    #if os(iOS)
                    .textContentType(.password)
                    #endif
            }
            if let error { Text(error).font(.sm).foregroundStyle(.danger).frame(maxWidth: .infinity, alignment: .leading) }
            Button { Task { await submit() } } label: { Text(askCode ? "Verify" : "Continue").frame(maxWidth: .infinity) }
                .glassButton(prominent: true)
                .controlSize(.extraLarge)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || (askCode ? code.isEmpty : email.isEmpty || password.isEmpty))
                .padding(.top, 4)
        }
        .onSubmit { if !busy, !email.isEmpty, !password.isEmpty { Task { await submit() } } }
    }

    private func show(_ on: Bool) {
        open = on
        error = nil
        if on {
            focus = editingServer ? "Server" : "Email"
        } else {
            askCode = false
            editingServer = false
            code = ""
            focus = nil
        }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        TextField(label, text: text, prompt: Text(label).foregroundStyle(.faint))
            .focused($focus, equals: label)
            .modifier(Field(focused: focus == label, large: true))
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            #endif
    }

    private func passkey() async {
        busy = true
        defer { busy = false }
        do {
            Server.url = URL(string: server)!
            try await Passkeys.signIn()
            mail.signedIn()
        } catch {
            if !Passkeys.cancelled(error) { self.error = error.localizedDescription }
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            if askCode {
                try await API.verify(code: code)
                if let encKey { try await Keys.open(encKey) }
            } else {
                guard let url = URL(string: server), url.scheme?.lowercased().hasPrefix("http") == true else {
                    editingServer = true
                    error = "Enter the server's address, like https://mail.example.com."
                    return
                }
                Server.url = url
                let (authKey, encKey) = await Keys.derive(password, email)
                if try await API.signIn(email: email, password: authKey) {
                    self.encKey = encKey
                    askCode = true
                    error = nil
                    focus = "Code"
                    return
                }
                try await Keys.open(encKey)
            }
            mail.signedIn()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// What Nouvex is, with the app on a phone over soft color. Nothing here moves.
private struct Landing: View {
    var body: some View {
        VStack(spacing: 0) {
            Image(.logo).resizable().scaledToFit().frame(height: 22).foregroundStyle(.ink)
                .accessibilityLabel("Nouvex Mail")
                .padding(.top, 20)
            Text("Your mail, on every device").font(.largeTitle.weight(.semibold)).foregroundStyle(.ink)
                .multilineTextAlignment(.center).padding(.top, 28)
            Text("Every account in one inbox, stored so only you can read it.").font(.lg).foregroundStyle(.muted)
                .multilineTextAlignment(.center).padding(.top, 10)
            // The phone only takes the room left and runs out under the sign-in button, so the page never overflows.
            Color.clear
                .overlay(alignment: .top) { Phone { DemoInbox() } }
                .clipped()
                .mask(LinearGradient(stops: [.init(color: .black, location: 0.6), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
                .padding(.top, 36)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
        .background {
            ZStack {
                Color.sunken
                blob("blue", x: -140, y: -260)
                blob("purple", x: 150, y: -40)
                blob("orange", x: -60, y: 260)
            }
            .drawingGroup()
            .ignoresSafeArea()
        }
    }

    private func blob(_ hue: String, x: CGFloat, y: CGFloat) -> some View {
        Circle().fill(Color.label(hue: hue) ?? .muted).frame(width: 320, height: 320).blur(radius: 100).opacity(0.45).offset(x: x, y: y)
    }
}

/// An iPhone drawn at its real size and scaled down, so the screen inside lays out like the real one.
private struct Phone<Screen: View>: View {
    @ViewBuilder let screen: Screen
    private let scale = 0.66

    var body: some View {
        screen
            .frame(width: 402, height: 874)
            .background(.paper)
            .clipShape(.rect(cornerRadius: 56))
            .overlay(alignment: .top) {
                // The Dynamic Island.
                Capsule().fill(.black).frame(width: 124, height: 36).padding(.top, 11)
            }
            .padding(12)
            // The device itself is black in either appearance.
            .background(.black, in: .rect(cornerRadius: 68))
            .overlay(RoundedRectangle(cornerRadius: 68).strokeBorder(.lineStrong, lineWidth: 3))
            .scaleEffect(scale, anchor: .top)
            .frame(width: 426 * scale, height: 898 * scale, alignment: .top)
    }
}

/// A few made-up conversations in the phone's rows, the way the inbox lays them out.
private struct DemoInbox: View {
    private let rows = [
        ("Lena Fischer", "9:41", "Dinner on Friday?", "I found a place by the river, they have a table for us at eight.", true),
        ("Jonas Weber", "9:12", "Slides for Monday", "Here's the latest version with your notes worked in.", true),
        ("Mara Schulz", "8:30", "Photos from the weekend", "The good ones are in the shared album now.", false),
        ("Tom Becker", "Yesterday", "Flat viewing", "Saturday at 11 works for the landlord, see you there.", false),
        ("Anna Klein", "Yesterday", "Re: Book club", "Chapter six was the best one so far, no question.", false),
        ("Paul Wagner", "Tue", "Invoice 2026-114", "Attached is the invoice for October, due in two weeks.", false),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("9:41").font(.system(size: 17, weight: .semibold))
                Spacer()
                Image(systemName: "cellularbars")
                Image(systemName: "wifi")
                Image(systemName: "battery.100percent")
            }
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.ink)
            .padding(.horizontal, 34).padding(.top, 18).frame(height: 54)
            Text("Inbox").font(.system(size: 34, weight: .bold)).foregroundStyle(.ink).padding(.horizontal, 20).padding(.top, 44).padding(.bottom, 8)
            ForEach(rows, id: \.0) { sender, time, subject, snippet, unread in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Dot(on: unread).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(sender).font(.system(size: 17, weight: unread ? .semibold : .regular))
                            Spacer()
                            Text(time).font(.system(size: 15)).foregroundStyle(unread ? .ink : .muted)
                        }
                        Text(subject).font(.system(size: 15, weight: unread ? .medium : .regular))
                        Text(snippet).font(.system(size: 15)).foregroundStyle(.muted).lineLimit(2)
                    }
                    .foregroundStyle(.ink)
                }
                .padding(.leading, 14).padding(.trailing, 20).padding(.vertical, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(.line).frame(height: 1).padding(.leading, 34) }
            }
            Spacer(minLength: 0)
        }
    }
}

/// After a passkey, or on a device that hasn't seen the password yet: mail is stored encrypted, and only the password
/// opens the key to it.
struct UnlockView: View {
    @Environment(Mail.self) private var mail
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(.logo).resizable().scaledToFit().frame(height: 20).foregroundStyle(.ink).padding(.bottom, 12)
            Text("Unlock your mail").font(.system(size: 22, weight: .semibold)).foregroundStyle(.ink)
            Text("It's stored encrypted. Enter the password for \(mail.me.email) once to open it on this device.")
                .font(.sm).foregroundStyle(.muted)
            SecureField("Password", text: $password, prompt: Text("Password").foregroundStyle(.faint))
                .modifier(Field(focused: true))
                #if os(iOS)
                .textContentType(.password)
                #endif
                .onSubmit { Task { await unlock() } }
            if let error { Text(error).font(.sm).foregroundStyle(.danger) }
            HStack {
                Button("Unlock") { Task { await unlock() } }
                    .glassButton(prominent: true)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || password.isEmpty)
                Button("Sign Out") { Task { await mail.signOut() } }.glassButton()
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: 320)
        .padding(32)
        .background(.paper, in: .rect(cornerRadius: Radius.xl))
        .overlay(RoundedRectangle(cornerRadius: Radius.xl).stroke(.line))
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.sunken)
    }

    private func unlock() async {
        busy = true
        defer { busy = false }
        do {
            try await Keys.open(await Keys.derive(password, mail.me.email).encKey)
            mail.unlocked = true
        } catch {
            self.error = error is DecodingError || error is CryptoKitError ? "That's not your password." : error.localizedDescription
        }
    }
}

/// Later today, tomorrow, the weekend, next week, or a day and time of one's own: when to snooze until or send.
struct WhenPicker: View {
    let action: String
    let pick: (Date) -> Void
    @State private var custom = Calendar.current.date(byAdding: .hour, value: 1, to: .now)!

    // The same choices as on the web.
    static func options(_ now: Date = .now) -> [(String, Date)] {
        let cal = Calendar.current
        let at = { (days: Int, hour: Int) in
            cal.date(bySettingHour: hour, minute: 0, second: 0, of: cal.date(byAdding: .day, value: days, to: now)!)!
        }
        let weekday = cal.component(.weekday, from: now) - 1
        let hour = cal.component(.hour, from: now)
        var options: [(String, Date)] = []
        if hour < 18 { options.append(("Later today", at(0, hour + 3 + (cal.component(.minute, from: now) > 0 ? 1 : 0)))) }
        options.append(("Tomorrow", at(1, 8)))
        if weekday != 0 && weekday != 6 { options.append(("This weekend", at(6 - weekday, 9))) }
        options.append(("Next week", at((8 - weekday) % 7 == 0 ? 7 : (8 - weekday) % 7, 8)))
        return options
    }

    var body: some View {
        if Device.phone { sheet } else { popover }
    }

    private static let icons = ["Later today": "sun.max", "Tomorrow": "sunrise", "This weekend": "sofa", "Next week": "calendar"]

    // A phone's sheet: a title, the choices as rows to tap, a day and time of one's own, and the button for that.
    private var sheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(action == "Schedule" ? "Send later" : "\(action) until").font(.xl).foregroundStyle(.ink)
                .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 12)
            ForEach(Self.options(), id: \.0) { label, date in
                Button { pick(date) } label: {
                    HStack(spacing: 14) {
                        Image(systemName: Self.icons[label] ?? "clock").font(.lg).foregroundStyle(.muted).frame(width: 24)
                        Text(label).font(.lg).foregroundStyle(.ink)
                        Spacer()
                        Text(date.when).font(.md).foregroundStyle(.muted)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 52)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            Rectangle().fill(.line).frame(height: 1).padding(.vertical, 8)
            HStack(spacing: 14) {
                Image(systemName: "calendar.badge.clock").font(.lg).foregroundStyle(.muted).frame(width: 24)
                Text("Pick a date").font(.lg).foregroundStyle(.ink)
                Spacer()
                DatePicker("Pick a date", selection: $custom, in: Date.now..., displayedComponents: [.date, .hourAndMinute]).labelsHidden()
            }
            .padding(.horizontal, 8)
            .frame(height: 52)
            Button { pick(custom) } label: { Text("\(action) for \(custom.when)").frame(maxWidth: .infinity) }
                .glassButton(prominent: true)
                .controlSize(.extraLarge)
                .padding(.top, 16)
        }
        .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 12)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var popover: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Self.options(), id: \.0) { label, date in
                Button { pick(date) } label: {
                    HStack {
                        Text(label).foregroundStyle(.ink)
                        Spacer()
                        Text(date.when).foregroundStyle(.muted)
                    }
                    .font(.md)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(QuietButtonStyle())
            }
            Rectangle().fill(.line).frame(height: 1).padding(.vertical, 6)
            HStack {
                DatePicker("Pick a time", selection: $custom, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                    .labelsHidden()
                Spacer()
                Button(action) { pick(custom) }.glassButton(prominent: true).fixedSize()
            }
            .padding(.horizontal, 8)
        }
        .padding(8)
        .frame(maxWidth: 300)
    }
}
