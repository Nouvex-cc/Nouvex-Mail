// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI

struct MailView: View {
    @Environment(Mail.self) private var mail

    var body: some View {
        switch mail.state {
        case .loading: Color.sunken.ignoresSafeArea()
        case .signedOut: SignInView()
        case .signedIn: Shell()
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
            Button(askCode ? "Verify" : "Sign in") { Task { await submit() } }
                .buttonStyle(.glassProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || email.isEmpty || password.isEmpty)
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

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            if askCode {
                try await API.verify(code: code)
            } else {
                guard let url = URL(string: server), url.scheme?.lowercased().hasPrefix("http") == true else {
                    error = "Enter the server's address, like https://mail.example.com."
                    return
                }
                Server.url = url
                if try await API.signIn(email: email, password: password) {
                    askCode = true
                    error = nil
                    return
                }
            }
            mail.signedIn()
        } catch {
            self.error = error.localizedDescription
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
                        Text(date.formatted(.dateTime.weekday(.abbreviated).hour().minute())).foregroundStyle(.muted)
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
                Button(action) { pick(custom) }.buttonStyle(.glassProminent).fixedSize()
            }
            .padding(.horizontal, 8)
        }
        // A popover on the Mac and iPad, a sheet as wide as the phone.
        .padding(Device.phone ? 16 : 8)
        .frame(maxWidth: Device.phone ? .infinity : 300)
    }
}
