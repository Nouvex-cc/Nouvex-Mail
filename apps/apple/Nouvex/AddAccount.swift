// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI

/// Gmail and iCloud only take an app password over IMAP, so their servers are known and only the password needs
/// explaining. Anything else asks for the servers, like on the web.
struct AddAccount: View {
    enum Provider: String, CaseIterable {
        case gmail = "Gmail", icloud = "iCloud", other = "Other"

        var servers: (imap: String, imapPort: String, smtp: String, smtpPort: String)? {
            switch self {
            case .gmail: ("imap.gmail.com", "993", "smtp.gmail.com", "465")
            case .icloud: ("imap.mail.me.com", "993", "smtp.mail.me.com", "587")
            case .other: nil
            }
        }

        var passwordHint: (String, String, URL)? {
            switch self {
            case .gmail:
                ("Turn on two-step verification, then", "create an app password", URL(string: "https://myaccount.google.com/apppasswords")!)
            case .icloud:
                ("Under Sign-in and security,", "create an app-specific password", URL(string: "https://account.apple.com/account/manage")!)
            case .other: nil
            }
        }
    }

    let added: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var provider = Provider.gmail
    @State private var email = ""
    @State private var password = ""
    @State private var username = ""
    @State private var imapHost = ""
    @State private var imapPort = ""
    @State private var smtpHost = ""
    @State private var smtpPort = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focus: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Add account").font(.xl).foregroundStyle(.ink)
                Picker("Provider", selection: $provider) {
                    ForEach(Provider.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                field("Email", text: $email)
                    #if os(iOS)
                    .keyboardType(.emailAddress).textContentType(.username)
                    #endif
                let label = provider == .other ? "Password" : "App password"
                SecureField(label, text: $password, prompt: Text(label).foregroundStyle(.faint))
                    .focused($focus, equals: "Password").modifier(Field(focused: focus == "Password"))
                if let (before, link, url) = provider.passwordHint {
                    Text(LocalizedStringKey("Your normal password won't work. \(before) [\(link)](\(url.absoluteString))."))
                        .font(.sm).foregroundStyle(.muted).tint(.ink)
                }
                if provider == .other {
                    field("Username (leave empty to use the email)", text: $username)
                    field("IMAP server", text: $imapHost)
                    field("IMAP port, usually 993", text: $imapPort)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    field("SMTP server", text: $smtpHost)
                    field("SMTP port, usually 465", text: $smtpPort)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                }
                if let error { Text(error).font(.sm).foregroundStyle(.danger) }
                HStack {
                    Spacer()
                    Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                    Button("Add") { Task { await submit() } }
                        .buttonStyle(.glassProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy || !ready)
                }
                .padding(.top, 4)
            }
            .padding(24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(.paper)
        #if os(macOS)
        .frame(width: 400)
        .fixedSize(horizontal: false, vertical: true)
        #endif
        .onSubmit { if !busy, ready { Task { await submit() } } }
    }

    private var ready: Bool {
        !email.isEmpty && !password.isEmpty && (provider != .other || (!imapHost.isEmpty && !smtpHost.isEmpty))
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
        let s = provider.servers ?? (imapHost, imapPort.isEmpty ? "993" : imapPort, smtpHost, smtpPort.isEmpty ? "465" : smtpPort)
        guard let imap = Int(s.imapPort), let smtp = Int(s.smtpPort) else {
            error = "Ports are numbers, like 993 and 465."
            return
        }
        busy = true
        defer { busy = false }
        let body = Operations.createAccount.Input.Body.jsonPayload(
            email: email, imapHost: s.imap, imapPort: imap, smtpHost: s.smtp, smtpPort: smtp,
            username: username.isEmpty ? email : username, password: password
        )
        // The engine tries both logins first; its answer says what the server didn't like.
        switch try? await API.client.createAccount(body: .json(body)) {
        case .created:
            added()
            dismiss()
        case .unprocessableContent(let res):
            error = (try? res.body.json.error) ?? "The mail server didn't accept these settings."
        default:
            error = "Couldn't add the account. Check the fields and try again."
        }
    }
}
