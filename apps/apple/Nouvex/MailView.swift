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
    @FocusState private var focus: String?

    var body: some View {
        ScrollView {
            form
                .frame(maxWidth: .infinity)
                .containerRelativeFrame(.vertical)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(.sunken)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(.logo).resizable().scaledToFit().frame(height: 20).foregroundStyle(.ink).padding(.bottom, 12)
            Text("Sign in").font(.system(size: 22, weight: .semibold)).foregroundStyle(.ink)
            field("Server", text: $server)
                #if os(iOS)
                .keyboardType(.URL).textContentType(.URL)
                #endif
            field("Email", text: $email)
                #if os(iOS)
                .keyboardType(.emailAddress).textContentType(.username)
                #endif
            SecureField("Password", text: $password, prompt: Text("Password").foregroundStyle(.faint))
                .focused($focus, equals: "Password").modifier(Field(focused: focus == "Password"))
                #if os(iOS)
                .textContentType(.password)
                #endif
            if askCode {
                field("Two-factor code", text: $code)
                    #if os(iOS)
                    .keyboardType(.numberPad).textContentType(.oneTimeCode)
                    #endif
            }
            if let error { Text(error).font(.sm).foregroundStyle(.danger) }
            HStack {
                Button(askCode ? "Verify" : "Sign in") { Task { await submit() } }
                    .glassButton(prominent: true)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || email.isEmpty || password.isEmpty)
                if !askCode, Passkeys.available(on: URL(string: server)) {
                    Button("Use a passkey", systemImage: "person.badge.key") { Task { await passkey() } }
                        .glassButton()
                        .disabled(busy)
                }
            }
            .padding(.top, 4)
        }
        .onSubmit { if !busy, !email.isEmpty, !password.isEmpty { Task { await submit() } } }
        .frame(maxWidth: 320)
        .padding(32)
        .background(.paper, in: .rect(cornerRadius: Radius.xl))
        .overlay(RoundedRectangle(cornerRadius: Radius.xl).stroke(.line))
        .padding(16)
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        TextField(label, text: text, prompt: Text(label).foregroundStyle(.faint))
            .focused($focus, equals: label)
            .modifier(Field(focused: focus == label))
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
                    error = "Enter the server's address, like https://mail.example.com."
                    return
                }
                Server.url = url
                let (authKey, encKey) = await Keys.derive(password, email)
                if try await API.signIn(email: email, password: authKey) {
                    self.encKey = encKey
                    askCode = true
                    error = nil
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
        // A popover on the Mac and iPad, a sheet as wide as the phone.
        .padding(Device.phone ? 16 : 8)
        .frame(maxWidth: Device.phone ? .infinity : 300)
    }
}
