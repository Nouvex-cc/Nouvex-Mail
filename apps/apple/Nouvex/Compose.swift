// SPDX-License-Identifier: AGPL-3.0-only
import OpenAPIRuntime
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Writing a message. A new one docks in the window's bottom right, leaves the inbox usable and folds down to its
/// title; a reply takes the reply bar's place in its conversation, starts in the text and keeps recipients and
/// subject on one line until clicked; a forward opens with its recipients, the original below as a card. On a phone
/// all of them come up as a sheet. Closing keeps a draft, sending leaves a short window to undo, discarding too.
struct Composer: View {
    enum Placement { case dock, reply, sheet }

    let placement: Placement
    @Environment(Mail.self) private var mail
    @State private var draft = Draft()
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    /// Cc, Bcc and From open, folded into one line otherwise.
    @State private var extras = false
    @State private var fields = false
    @State private var picking = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var picksPhotos = false
    @State private var shooting = false
    /// The format bar is open, and takes the bottom of the card.
    @State private var formatting = false
    @State private var scheduling = false
    @State private var folded = false
    @State private var showQuote = false
    @State private var error: String?
    @State private var phase = Phase.writing
    @State private var stored: [String] = []
    @State private var leaving = false
    /// The account the draft was last saved under; another one picked takes it out of that one's Drafts.
    @State private var savedUnder: String?
    /// Gone from the screen: what's left to say about sending goes into a toast.
    @State private var gone = false
    @State private var selection: TextSelection?
    /// The formatted editor's selection (an iOS 26 type, so held as Any), shared with its format bar.
    @State private var richSelection: Any?
    /// A new message goes out from the account last used with its first recipient, until one is picked.
    @State private var autoFrom = false
    /// A save on its way to the server; discarding waits for it, or the save would land after the discard.
    @State private var saving: Task<Void, Never>?
    @FocusState private var focus: Field?

    enum Field { case to, cc, bcc, subject, body }
    private enum Phase: Equatable { case writing, undo(Task<Void, Never>), sending }

    var body: some View {
        Group {
            if placement == .sheet { sheet } else { card }
        }
        .font(.md)
        .textFieldStyle(.plain)
        .dropDestination(for: URL.self) { urls, _ in
            attach(urls)
            return true
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { attach(urls) }
        }
        .photosPicker(isPresented: $picksPhotos, selection: $photos, matching: .any(of: [.images, .videos]))
        .onChange(of: photos) { _, items in attach(items) }
        #if os(iOS)
        .fullScreenCover(isPresented: $shooting) {
            Camera { add($0.jpegData(compressionQuality: 0.85), name: "Photo \(Date.now.formatted(.dateTime.hour().minute().second())).jpg", type: "image/jpeg") }
                .ignoresSafeArea()
        }
        #endif
        .onEscape { close() }
        .task { setUp() }
        .task(id: recipients(to).first) {
            guard autoFrom, let first = recipients(to).first,
                  let id = try? await Store.db.read({ try Draft.lastUsed($0, to: first) }), mail.accountList.contains(where: { $0.id == id })
            else { return }
            pick(id, auto: true)
        }
        // Saved as a draft two seconds after typing stops, and once more when it closes.
        .task(id: snapshot) {
            error = nil
            guard (try? await Task.sleep(for: .seconds(2))) != nil else { return }
            await save()
        }
        .onChange(of: focus) { _, now in mail.typing = now != nil }
        .onChange(of: mail.raise) { _, _ in
            folded = false
            focus = .body
        }
        .onDisappear {
            gone = true
            mail.typing = false
            Task { await save() }
        }
    }

    private var card: some View {
        VStack(spacing: 0) {
            header
            if !folded {
                if placement == .dock || fields || draft.kind == .forward {
                    addressing
                }
                if !draft.files.isEmpty { attachments }
                if !draft.quote.isEmpty { quote }
                editor
                if let f = draft.forwarded { forwarded(f) }
                if let error { failure(error) }
                Rectangle().fill(.line).frame(height: 1)
                actions
            }
        }
        .frame(width: placement == .dock ? 512 : nil, height: placement == .dock ? (folded ? 44 : 520) : nil)
        .frame(maxWidth: placement == .reply ? 760 : nil)
        .background(.raised)
        .clipShape(shape)
        .overlay(shape.stroke(.line))
        .shadow(color: Color.ink.opacity(0.1), radius: 16, y: 6)
    }

    // A phone writes full height: Close and Send in the bar, files and Send later next to Send.
    private var sheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    // The bar has no room for the title next to the buttons; what it is goes first.
                    if let symbol {
                        Label(draft.title, systemImage: symbol).font(.sm.weight(.medium)).foregroundStyle(.muted)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 8)
                    }
                    if let at = draft.scheduledFor { scheduled(at) }
                    addressing
                    if !draft.files.isEmpty { attachments }
                    if !draft.quote.isEmpty { quote }
                    editor.frame(minHeight: 240)
                    if let f = draft.forwarded { forwarded(f) }
                    if let error { failure(error) }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            // Room under the last line for the format button.
            .contentMargins(.bottom, focus == .body ? 68 : 0, for: .scrollContent)
            .overlay(alignment: .bottomTrailing) { formatButton }
            .overlay(alignment: .bottomLeading) { photoButton }
            .animation(.quick, value: focus == .body)
            .background(sheetBackground)
            #if os(iOS)
            .containerBackground(sheetBackground, for: .navigation)
            #endif
            .navigationTitle(draft.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") {
                        // A saved draft can be deleted from here, as well as kept.
                        if stored == snapshot && !draft.saved { close() } else { leaving = true }
                    }
                    .confirmationDialog("Keep this message as a draft?", isPresented: $leaving) {
                        Button("Delete draft", role: .destructive) { Task { await discard() } }
                        Button("Keep draft") { close() }
                    }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    attachMenu
                    Button("Send later", systemImage: "clock") { scheduling = true }.disabled(!sendable)
                    sendButton
                }
            }
            .sheet(isPresented: $scheduling) {
                WhenPicker(action: "Schedule", pick: schedule)
                    .presentationDetents([.medium])
            }
        }
        .interactiveDismissDisabled(phase != .writing)
    }

    @available(iOS 26, macOS 26, *)
    private var richSelectionBinding: Binding<AttributedTextSelection> {
        Binding(get: { richSelection as? AttributedTextSelection ?? AttributedTextSelection() }, set: { richSelection = $0 })
    }

    /// The format button, in the card's bottom corner while writing, so it sits right over the keyboard.
    @ViewBuilder private var formatButton: some View {
        if #available(iOS 26, macOS 26, *), focus == .body {
            FormatBar(draft: $draft, selection: richSelectionBinding, open: $formatting)
                .padding(10)
                .transition(.opacity)
        }
    }

    /// Photos while writing, across from the format button: the camera on a phone, or the library.
    @ViewBuilder private var photoButton: some View {
        if focus == .body, !formatting {
            Menu {
                #if os(iOS)
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Take Photo", systemImage: "camera") { shooting = true }
                }
                #endif
                Button("Photo Library", systemImage: "photo.on.rectangle") { picksPhotos = true }
            } label: {
                Image(systemName: "photo.on.rectangle").font(.lg).foregroundStyle(.ink)
                    .frame(width: 44, height: 44)
                    .contentShape(.circle)
                    .glass(in: Circle())
            }
            .accessibilityLabel("Add photo")
            .padding(10)
            .transition(.opacity)
        }
    }

    /// The card's glass shows through on iOS 26; paper before it.
    private var sheetBackground: Color {
        if #available(iOS 26, *) { .clear } else { .paper }
    }

    private var sendable: Bool { phase == .writing && !recipients(to + "," + cc + "," + bcc).isEmpty && Recipients.valid(to, cc, bcc) }

    private var sendButton: some View {
        SendButton(undoing: undoing, sending: phase == .sending, seconds: mail.prefs.undoSend) {
            if case .undo(let task) = phase {
                task.cancel()
                phase = .writing
            } else {
                send()
            }
        }
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(!sendable && !undoing)
    }

    private var attachMenu: some View {
        Menu {
            Button("Files…", systemImage: "folder") { picking = true }
            Button("Photos…", systemImage: "photo") { picksPhotos = true }
            #if os(iOS)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take Photo", systemImage: "camera") { shooting = true }
            }
            #endif
        } label: {
            Label("Attach", systemImage: "paperclip")
        }
    }

    // To first; Cc, Bcc and From fold into one line, like Mail, open with a tap and fold again once they're left empty.
    @ViewBuilder private var addressing: some View {
        row("To") { Recipients(label: "To", text: $to, focus: $focus, field: .to) { next(.to) } }
            // Suggestions open below a field, over the rows that follow.
            .zIndex(3)
        if extras {
            row("Cc") { Recipients(label: "Cc", text: $cc, focus: $focus, field: .cc) { next(.cc) } }
                .zIndex(2)
            row("Bcc") { Recipients(label: "Bcc", text: $bcc, focus: $focus, field: .bcc) { next(.bcc) } }
                .zIndex(1)
            if choosesFrom { from }
        } else {
            Button {
                withAnimation(.quick) { extras = true }
                Task { focus = .cc }
            } label: {
                row(nil) {
                    Text(choosesFrom ? "Cc/Bcc, From: \(sender)" : "Cc/Bcc").font(.md).foregroundStyle(.muted).lineLimit(1)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
        row(nil) {
            TextField("Subject", text: $draft.subject, prompt: Text("Subject").foregroundStyle(.muted))
                .font(.md.weight(.medium))
                .focused($focus, equals: .subject).submitLabel(.next)
                .onKeyPress(.tab) { next(.subject) }.onSubmit { _ = next(.subject) }
        }
        .onChange(of: focus) { _, now in
            guard extras, cc.isEmpty, bcc.isEmpty, now == .to || now == .subject || now == .body else { return }
            withAnimation(.quick) { extras = false }
        }
    }

    /// Several accounts to send from, or one that isn't active.
    private var choosesFrom: Bool { mail.accountList.count > 1 || !mail.accountList.contains(where: { $0.id == draft.accountId }) }
    private var sender: String { mail.accounts.first { $0.id == draft.accountId }?.email ?? "" }

    private func failure(_ error: String) -> some View {
        Label(error, systemImage: "exclamationmark.circle").font(.sm).foregroundStyle(.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.bottom, 8)
    }

    // Docked, it sits on the window's bottom edge.
    private var shape: UnevenRoundedRectangle {
        let bottom = placement == .dock ? 0 : Radius.lg
        return UnevenRoundedRectangle(topLeadingRadius: Radius.lg, bottomLeadingRadius: bottom, bottomTrailingRadius: bottom, topTrailingRadius: Radius.lg)
    }

    // What it is and to whom; a reply opens its fields from here.
    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.sm).foregroundStyle(.muted) }
                Text(draft.title).font(.md.weight(.medium)).lineLimit(1)
                if placement == .reply, draft.kind != .forward, !fields {
                    Text(to.isEmpty ? "Add recipients" : to).foregroundStyle(.muted).lineLimit(1)
                }
                Spacer()
                if placement == .dock {
                    IconButton(label: folded ? "Open" : "Fold down", symbol: "chevron.up.chevron.down") { withAnimation(.quick) { folded.toggle() } }
                } else if draft.kind != .forward {
                    IconButton(label: fields ? "Hide recipients" : "Recipients and subject", symbol: fields ? "chevron.up" : "chevron.down") {
                        withAnimation(.quick) { fields.toggle() }
                    }
                }
                IconButton(label: "Close, keeps a draft", symbol: "xmark", key: "Esc") { close() }
            }
            .padding(.leading, 12).padding(.trailing, 6)
            .frame(height: 44)
            .contentShape(.rect)
            .onTapGesture {
                if folded { withAnimation(.quick) { folded = false } }
                if placement == .reply, !fields { withAnimation(.quick) { fields = true } }
            }
            if !folded { Rectangle().fill(.line).frame(height: 1) }
        }
    }

    private var symbol: String? {
        switch draft.kind {
        case nil: nil
        case .reply: "arrowshape.turn.up.left"
        case .replyAll: "arrowshape.turn.up.left.2"
        case .forward: "arrowshape.turn.up.right"
        }
    }

    // The account it goes out from, as a pill that's plainly a choice.
    private var from: some View {
        row("From") {
            Menu {
                ForEach(mail.accountList, id: \.id) { a in
                    Button(a.email) { pick(a.id, auto: false) }
                }
            } label: {
                HStack(spacing: 6) {
                    if let hue = Color.label(hue: mail.accounts.first { $0.id == draft.accountId }?.color) {
                        Circle().fill(hue).frame(width: 8, height: 8)
                    }
                    Text(sender).font(.md).foregroundStyle(.ink).lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(.muted)
                }
                .padding(.horizontal, 10).frame(height: 30)
                .background(.hover, in: .capsule)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        }
    }

    private func row<Content: View>(_ label: String?, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8) {
            if let label { Text(label).font(.md).foregroundStyle(.muted).frame(minWidth: 42, alignment: .leading) }
            content()
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(height: placement == .sheet ? 46 : 40)
        .overlay(alignment: .bottom) { Rectangle().fill(.line).frame(height: 1) }
    }

    private var attachments: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(draft.files) { f in
                    HStack(spacing: 6) {
                        Image(systemName: "paperclip").font(.xs)
                        Text(f.name).lineLimit(1)
                        Text(f.size.formatted(.byteCount(style: .file))).foregroundStyle(.muted)
                        Button("Remove \(f.name)", systemImage: "xmark") { draft.files.removeAll { $0.id == f.id } }
                            .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(.muted)
                    }
                    .font(.sm)
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(.sunken, in: .rect(cornerRadius: Radius.md))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
    }

    private var editor: some View {
        Group {
            if #available(iOS 26, macOS 26, *) {
                RichEditor(draft: $draft, selection: richSelectionBinding, focus: $focus)
            } else {
                TextEditor(text: $draft.body, selection: $selection).focused($focus, equals: .body)
            }
        }
            .font(.md)
            .lineSpacing(3)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, 7).padding(.vertical, 10)
            .frame(height: placement == .reply ? 160 : nil)
            .frame(maxHeight: placement == .dock ? .infinity : nil)
            .overlay(alignment: .topLeading) {
                // Empty but for the signature.
                if draft.body.components(separatedBy: "\n\n-- \n").first?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                    // Where the first line starts: iOS's text view keeps 8 points above it, the Mac's none.
                    Text("Write something").font(.md).foregroundStyle(.muted).padding(.horizontal, 12).padding(.vertical, Device.platform == "iOS" ? 18 : 10)
                        .allowsHitTesting(false)
                }
            }
    }

    // It was scheduled: closing keeps it so, Send sends it now, and it can be taken off.
    private func scheduled(_ at: Date) -> some View {
        HStack(spacing: 8) {
            Label("Scheduled · \(at.when)", systemImage: "calendar.badge.clock")
                .font(.sm.weight(.medium)).foregroundStyle(.ink)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(.hover, in: .capsule)
            Spacer()
            Button("Unschedule") { withAnimation(.quick) { draft.scheduledFor = nil } }
                .font(.sm.weight(.medium)).foregroundStyle(.muted).buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 8)
    }

    // What's forwarded, as a card: who wrote it, about what, with how many files; the text opens on a click.
    private func forwarded(_ f: Draft.Forwarded) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.quick) { showQuote.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrowshape.turn.up.right").font(.sm).foregroundStyle(.muted)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(f.subject.isEmpty ? "(no subject)" : f.subject).font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                        Text("From \(f.from) · \(f.date)").font(.xs).foregroundStyle(.muted).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: showQuote ? "chevron.up" : "chevron.down").font(.xs).foregroundStyle(.muted)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if showQuote {
                ScrollView {
                    Text(f.text).font(.sm).foregroundStyle(.muted).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            }
        }
        .padding(10)
        .background(.sunken, in: .rect(cornerRadius: Radius.md))
        .padding(.horizontal, 12).padding(.bottom, 8)
    }

    // What's being answered, above where the answer is written: who said what, two lines of it, and with a tap the
    // whole history, one message at a time. It still goes out quoted below the answer.
    private var quote: some View {
        let history = Answering.history(draft.quote)
        return VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.quick) { showQuote.toggle() } } label: {
                HStack(spacing: 10) {
                    Avatar(name: history.first?.from ?? draft.person, size: 26)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(history.first?.from ?? draft.person).font(.sm.weight(.medium)).foregroundStyle(.ink).lineLimit(1)
                        Text(history.first?.date ?? "").font(.xs).foregroundStyle(.muted).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if history.count > 1, !showQuote {
                        Text("+\(history.count - 1) earlier").font(.xs).foregroundStyle(.muted)
                    }
                    Image(systemName: showQuote ? "chevron.up" : "chevron.down").font(.xs.weight(.semibold)).foregroundStyle(.muted)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(showQuote ? "Hides the conversation" : "Shows the conversation")
            if showQuote {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(Array(history.enumerated()), id: \.offset) { i, q in
                            VStack(alignment: .leading, spacing: 4) {
                                // The first one's sender and date are in the header already.
                                if i > 0 {
                                    Text("\(q.from) · \(q.date)").font(.xs.weight(.medium)).foregroundStyle(.muted).lineLimit(1)
                                }
                                Text(q.text).font(.sm).foregroundStyle(.ink).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if i < history.count - 1 { Rectangle().fill(.line).frame(height: 1) }
                        }
                    }
                }
                .frame(maxHeight: 280)
                .transition(.opacity)
            } else if let first = history.first {
                Text(first.text).font(.sm).foregroundStyle(.muted).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .background(.hover, in: .rect(cornerRadius: Radius.lg))
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private var actions: some View {
        HStack(spacing: 4) {
            sendButton
            IconButton(label: "Send later", symbol: "clock") { scheduling = true }
                .disabled(!sendable)
                .popover(isPresented: $scheduling) {
                    WhenPicker(action: "Schedule", pick: schedule)
                }
            attachMenu.menuStyle(.borderlessButton).menuIndicator(.hidden).labelStyle(.iconOnly).fixedSize().help("Attach files")
            Spacer()
            Button("Discard", role: .destructive) { Task { await discard() } }
                .buttonStyle(QuietButtonStyle())
                .disabled(phase != .writing)
        }
        .padding(.horizontal, 10)
        .frame(height: 52)
    }

    // Tab walks the fields of the composer and never leaves it for the list behind.
    private func next(_ field: Field) -> KeyPress.Result {
        let order = [Field.to] + (extras ? [.cc, .bcc] : []) + [.subject, .body]
        if let i = order.firstIndex(of: field), order.indices.contains(i + 1) { focus = order[i + 1] }
        return .handled
    }

    private var undoing: Bool {
        if case .undo = phase { true } else { false }
    }

    private var snapshot: [String] {
        [draft.accountId ?? "", to, cc, bcc, draft.subject, draft.body, draft.richHTML ?? ""] + draft.files.map(\.id.uuidString)
    }

    private func setUp() {
        let start = switch placement {
        case .dock: mail.compose
        case .reply: mail.reply
        case .sheet: mail.compose ?? mail.reply
        }
        guard stored.isEmpty, let start else { return }
        draft = start
        autoFrom = !start.saved && start.kind == nil && start.to.isEmpty
        if draft.accountId == nil { draft.accountId = mail.sender ?? mail.accountList.first?.id }
        if draft.saved { savedUnder = draft.accountId }
        // The signature goes above a quoted message, the way replies are written; the cursor before it.
        if !draft.saved, !draft.body.contains("\n-- \n"), let signature = signature(draft.accountId) { draft.body += "\n\n-- \n\(signature)" }
        // The editor needs the same text from the first keystroke on, or the first ones get lost.
        if draft.rich == nil { draft.rich = AttributedString(draft.body) }
        to = draft.to.joined(separator: ", ")
        cc = draft.cc.joined(separator: ", ")
        bcc = draft.bcc.joined(separator: ", ")
        extras = !cc.isEmpty || !bcc.isEmpty
        stored = snapshot
        // After the view is in the window, or the list keeps the focus. A forward starts with whom it goes to.
        Task {
            focus = draft.to.isEmpty ? .to : .body
            selection = TextSelection(insertionPoint: draft.body.startIndex)
        }
    }

    private func signature(_ accountId: String?) -> String? {
        mail.accounts.first { $0.id == accountId }.flatMap { $0.signature.isEmpty ? nil : $0.signature }
    }

    // Another account: its signature in place of the old one.
    private func pick(_ id: String, auto: Bool) {
        if !auto { autoFrom = false }
        guard id != draft.accountId else { return }
        if let old = signature(draft.accountId), let i = draft.body.range(of: "\n\n-- \n\(old)", options: .backwards) {
            draft.body.replaceSubrange(i, with: signature(id).map { "\n\n-- \n\($0)" } ?? "")
            // The formatted text follows, keeping what's formatted before the signature.
            if var rich = draft.rich, let r = rich.range(of: "\n\n-- \n\(old)", options: .backwards) {
                rich.replaceSubrange(r, with: AttributedString(signature(id).map { "\n\n-- \n\($0)" } ?? ""))
                draft.rich = rich
            }
        }
        draft.accountId = id
    }

    private func close() {
        // A scheduled one being changed goes back on its schedule rather than staying in Drafts.
        if let at = draft.scheduledFor, at > .now, sendable { return schedule(at) }
        Task { await save() }
        dismiss()
    }

    private func dismiss() {
        withAnimation(.quick) {
            switch placement {
            case .dock: mail.compose = nil
            case .reply: mail.reply = nil
            case .sheet:
                mail.compose = nil
                mail.reply = nil
            }
        }
    }

    // Files are read off the main thread; one that can't be read says so.
    private func attach(_ urls: [URL]) {
        Task {
            for url in urls {
                let read = await Task.detached { () -> Data? in
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    return try? Data(contentsOf: url)
                }.value
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                add(read, name: url.lastPathComponent, type: type)
            }
        }
    }

    private func attach(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photos = []
        Task {
            for (i, item) in items.enumerated() {
                let type = item.supportedContentTypes.first ?? .jpeg
                let name = "\(type.conforms(to: .movie) ? "Video" : "Photo")\(items.count > 1 ? " \(i + 1)" : "").\(type.preferredFilenameExtension ?? "jpg")"
                add(try? await item.loadTransferable(type: Data.self), name: name, type: type.preferredMIMEType ?? "image/jpeg")
            }
        }
    }

    private func add(_ data: Data?, name: String, type: String) {
        guard let data else { return error = "Couldn't read “\(name)”." }
        guard data.count + draft.files.map(\.size).reduce(0, +) <= 25 * 1024 * 1024 else {
            return error = "“\(name)” doesn't fit: files can be 25 MB together."
        }
        draft.files.append(Draft.Piece(name: name, type: type, size: data.count, data: data))
    }

    // Takes "Name <a@b.c>" and bare addresses, separated by commas, semicolons or line breaks.
    private func recipients(_ field: String) -> [String] {
        field.split(whereSeparator: { ",;\n".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.contains("@") }
    }

    /// The draft as it is on screen.
    private var current: Draft {
        var d = draft
        d.to = recipients(to)
        d.cc = recipients(cc)
        d.bcc = recipients(bcc)
        return d
    }

    private func save() async {
        guard phase == .writing, !stored.isEmpty, snapshot != stored, let accountId = draft.accountId else { return }
        stored = snapshot
        var d = current
        // Moved to another account: out of the old one's Drafts.
        if let old = savedUnder, old != accountId {
            _ = try? await API.client.discardDraft(path: .init(accountId: old, draftId: d.draftId))
        }
        let files = (try? await d.uploaded(accountId)) ?? []
        draft.files = d.files
        draft.saved = true
        savedUnder = accountId
        let task = Task { await Self.store(d, files: files) }
        saving = task
        await task.value
    }

    /// Stores a draft on the server, in its account's Drafts folder.
    static func store(_ d: Draft, files: [(id: String, name: String, type: String)]) async {
        guard let accountId = d.accountId else { return }
        let body = Operations.saveDraft.Input.Body.jsonPayload(
            to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text, html: d.html, inReplyTo: d.inReplyTo,
            rev: Int(Date.now.timeIntervalSince1970 * 1000),
            attachments: files.isEmpty ? nil : files.map { .init(id: $0.id, name: $0.name, _type: $0.type) }
        )
        _ = try? await API.client.saveDraft(path: .init(accountId: accountId, draftId: d.draftId), body: .json(body))
    }

    private func schedule(_ date: Date) {
        scheduling = false
        Task { await Background.keepAlive { await deliver(at: date) } }
    }

    // Sending waits out the undo window first, then goes; closing the composer meanwhile doesn't stop it.
    private func send() {
        #if os(iOS)
        if placement == .sheet { return sendAndClose() }
        #endif
        guard mail.prefs.undoSend > 0 else {
            Task { await Background.keepAlive { await deliver() } }
            return
        }
        let seconds = mail.prefs.undoSend
        phase = .undo(Task {
            await Background.keepAlive {
                guard (try? await Task.sleep(for: .seconds(seconds))) != nil else { return }
                await deliver()
            }
        })
    }

    #if os(iOS)
    /// On a phone the card goes at once; the status pill says it's going out, with Undo for as long as that's set,
    /// which brings the card back as it was.
    private func sendAndClose() {
        let d = current, mail = mail, seconds = mail.prefs.undoSend
        let task = Task {
            await Background.keepAlive {
                if seconds > 0, (try? await Task.sleep(for: .seconds(seconds))) == nil { return }
                await deliver()
            }
        }
        phase = .undo(task)
        if seconds > 0 {
            mail.toast("Sending…", id: d.draftId, icon: .progress, action: ("Undo", {
                task.cancel()
                mail.dismissToast(d.draftId)
                mail.write(d)
            }))
        }
        dismiss()
    }
    #endif

    private func deliver(at sendAt: Date? = nil) async {
        guard let accountId = draft.accountId else { return }
        phase = .sending
        var d = current
        if sendAt == nil { mail.toast("Sending…", id: d.draftId, icon: .progress) }
        let files: [(id: String, name: String, type: String)]
        do {
            files = try await d.uploaded(accountId)
        } catch {
            return fail(error.localizedDescription, d)
        }
        draft.files = d.files
        let res = try? await API.client.sendMessage(
            path: .init(accountId: accountId),
            body: .json(.init(
                to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text, html: d.html, inReplyTo: d.inReplyTo,
                references: d.references.isEmpty ? nil : d.references, draftId: d.draftId, sendAt: sendAt,
                attachments: files.isEmpty ? nil : files.map { .init(id: $0.id, name: $0.name, _type: $0.type) }
            ))
        )
        switch res {
        case .accepted:
            mail.outgoing[d.draftId] = d
            // In the server's hands now; if the engine can't get it out, it says so and it's back in Drafts.
            if let sendAt {
                mail.toast("Scheduled for \(sendAt.when)", "It waits in the Outbox.", id: d.draftId, icon: .done)
            } else {
                mail.confirmed.insert(d.draftId)
                mail.toast("Sent", id: d.draftId, icon: .done)
            }
            dismiss()
        case .contentTooLarge:
            fail("The files are over 25 MB together. Remove one and send again.", d)
        case .unprocessableContent:
            // The uploads expired; they go up again on the next try.
            for i in draft.files.indices where draft.files[i].data != nil || draft.files[i].source != nil { draft.files[i].upload = nil }
            fail("A file was gone from the server. Send again to attach it anew.", d)
        case .undocumented(statusCode: 400, _):
            fail("Check the recipients: one of them isn't an email address.", d)
        default:
            fail("Couldn't reach the server. Check the connection and send again.", d)
        }
    }

    // Said in the composer, or in a toast that opens it again when the composer is gone.
    private func fail(_ reason: String, _ d: Draft) {
        phase = .writing
        if gone {
            // The composer is gone by the time the toast is tapped: the app's state is held on to here.
            let mail = mail
            mail.toast("Couldn't send “\(d.subject.isEmpty ? "(no subject)" : d.subject)”", reason, id: d.draftId, action: ("Open", { mail.write(d) }))
        } else {
            mail.dismissToast(d.draftId)
            error = reason
        }
    }

    // Gone at once, back with Undo for a few seconds.
    private func discard() async {
        let d = current
        let was = draft.saved
        phase = .sending
        await saving?.value
        if let accountId = draft.accountId, was {
            _ = try? await API.client.discardDraft(path: .init(accountId: accountId, draftId: draft.draftId))
        }
        dismiss()
        // The composer is gone by the time Undo is tapped: the app's state is held on to here.
        let mail = mail
        mail.toast("Draft discarded", action: ("Undo", {
            Task {
                var back = d
                back.saved = true
                await Self.store(back, files: (try? await back.uploaded(back.accountId ?? "")) ?? [])
                mail.write(back)
            }
        }))
    }
}

/// Send, then for a few seconds Undo, its outline draining while the window to take it back runs out, then Sending
/// while the files go up.
private struct SendButton: View {
    let undoing: Bool
    let sending: Bool
    let seconds: Int
    let action: () -> Void
    @State private var left: CGFloat = 1

    var body: some View {
        Button(action: action) {
            Group {
                if sending {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Sending")
                    }
                } else {
                    Text(undoing ? "Undo" : "Send")
                }
            }
            .frame(width: 84)
        }
        .glassButton(prominent: true)
        .overlay {
            if undoing {
                Capsule().trim(from: 0, to: left).stroke(Color.onInk.opacity(0.6), lineWidth: 2)
                    .padding(2).allowsHitTesting(false)
            }
        }
        .onChange(of: undoing) { _, undoing in
            left = 1
            if undoing { withAnimation(.linear(duration: Double(seconds))) { left = 0 } }
        }
    }
}

extension View {
    /// Addresses: no capitals, no corrections, the keyboard with @.
    func address() -> some View {
        #if os(iOS)
        keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.next)
        #else
        self
        #endif
    }
}

/// Addresses as chips: Enter, a comma or leaving the field makes one, Backspace in an empty field takes the last one
/// back, and typing suggests people from mail that's already here. It all stays one comma-separated text, whatever is
/// being typed included, so sending and drafts see it too.
struct Recipients: View {
    let label: String
    @Binding var text: String
    var focus: FocusState<Composer.Field?>.Binding
    let field: Composer.Field
    let next: () -> KeyPress.Result
    @State private var people: [Person] = []
    @State private var highlighted = 0
    /// What's in the field, after an invisible mark: the text field keeps Backspace to itself, so an empty field
    /// losing the mark is how Backspace there shows. It becomes chips after the keystroke, which the field takes in.
    @State private var entry = Self.mark
    private static let mark = "\u{200B}"

    private var focused: Bool { focus.wrappedValue == field }
    private var parts: [String] { text.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
    // While typing, the last part is the text in the field; otherwise every part is a chip.
    private var chips: [String] { (focused ? parts.dropLast() : parts[...]).filter { !$0.isEmpty } }

    /// A bare address or "Name <address>".
    static func valid(_ chip: String) -> Bool {
        let address = chip.firstMatch(of: /<([^>]+)>/).map { String($0.1) } ?? chip
        return address.wholeMatch(of: /[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+/) != nil
    }

    /// Every chip in these fields is an address.
    static func valid(_ fields: String...) -> Bool {
        fields.allSatisfy { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.allSatisfy(valid) }
    }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(Array(chips.enumerated()), id: \.offset) { i, chip in
                    HStack(spacing: 4) {
                        Text(chip).font(.sm).foregroundStyle(Self.valid(chip) ? Color.ink : .danger)
                        Button("Remove \(chip)", systemImage: "xmark") { remove(i) }
                            .labelStyle(.iconOnly).buttonStyle(.plain).font(.system(size: 9, weight: .semibold)).foregroundStyle(.muted)
                    }
                    .padding(.horizontal, 8).frame(height: 24)
                    .background(Self.valid(chip) ? Color.hover : Color.danger.opacity(0.12), in: .capsule)
                }
                TextField(label, text: $entry, prompt: Text(""))
                    .focused(focus, equals: field)
                    .address()
                    .frame(minWidth: 140)
                    .onSubmit { commit(people.indices.contains(highlighted) ? people[highlighted] : nil) }
                    .onKeyPress(.tab) {
                        commit()
                        return next()
                    }
                    .onKeyPress(.downArrow) { move(1) }
                    .onKeyPress(.upArrow) { move(-1) }
                    .onKeyPress(.escape) {
                        guard !people.isEmpty else { return .ignored }
                        people = []
                        return .handled
                    }
            }
        }
        .scrollIndicators(.hidden)
        .task(id: focused ? typed : nil) { await suggest() }
        .onChange(of: entry) { old, new in
            let now = new.replacingOccurrences(of: Self.mark, with: "")
            if new.isEmpty, old == Self.mark, !chips.isEmpty {
                remove(chips.count - 1)
            } else if now.contains(",") || now.contains(";") {
                let parts = now.split(whereSeparator: { ",;".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                set(chips + parts, typing: "")
            } else {
                set(chips, typing: now)
            }
        }
        .onChange(of: focused) { _, now in
            // Coming in, what's there becomes chips; leaving, the last bit typed becomes one too.
            let filled = parts.filter { !$0.isEmpty }
            if now { set(filled, typing: "") } else { text = filled.joined(separator: ", ") }
        }
        .overlay(alignment: .topLeading) {
            if focused, !people.isEmpty { suggestions.offset(y: 34) }
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(people.enumerated()), id: \.element) { i, p in suggestion(p, lit: i == highlighted) }
        }
        .padding(4)
        .frame(width: 280)
        .background(.raised, in: .rect(cornerRadius: Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).stroke(.line))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    private func suggestion(_ p: Person, lit: Bool) -> some View {
        Button { commit(p) } label: {
            VStack(alignment: .leading, spacing: 1) {
                Text(p.name.isEmpty ? p.address : p.name).font(.sm).foregroundStyle(.ink)
                if !p.name.isEmpty { Text(p.address).font(.xs).foregroundStyle(.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(lit ? Color.hover : .clear, in: .rect(cornerRadius: Radius.md))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func move(_ step: Int) -> KeyPress.Result {
        guard !people.isEmpty else { return .ignored }
        highlighted = (highlighted + step + people.count) % people.count
        return .handled
    }

    private var typed: String { entry.replacingOccurrences(of: Self.mark, with: "") }

    private func set(_ chips: [String], typing: String) {
        text = (chips + [typing]).joined(separator: ", ")
        if entry != Self.mark + typing { entry = Self.mark + typing }
    }

    private func commit(_ person: Person? = nil) {
        let typed = typed.trimmingCharacters(in: .whitespaces)
        set(chips + [person?.address ?? typed].filter { !$0.isEmpty }, typing: "")
        people = []
    }

    private func remove(_ i: Int) {
        var rest = chips
        rest.remove(at: i)
        set(rest, typing: focused ? typed : "")
    }

    // Up to five, leaving out who's in already.
    private func suggest() async {
        let query = focused ? typed : ""
        guard !query.isEmpty, (try? await Task.sleep(for: .milliseconds(80))) != nil else { return people = [] }
        let taken = Set(chips.map { $0.lowercased() })
        let found = await Store.people(matching: query, limit: 10)
        people = Array(found.filter { !taken.contains($0.address.lowercased()) }.prefix(5))
        highlighted = 0
    }
}

/// The text with its formatting, where SwiftUI can edit that (iOS and macOS 26).
@available(iOS 26, macOS 26, *)
private struct RichEditor: View {
    @Binding var draft: Draft
    @Binding var selection: AttributedTextSelection
    var focus: FocusState<Composer.Field?>.Binding
    @Environment(\.fontResolutionContext) private var fonts

    var body: some View {
        TextEditor(text: $draft.richText, selection: $selection)
            .focused(focus, equals: .body)
            // Changed elsewhere (the signature), the plain text leads; the cursor starts before the signature.
            .onChange(of: draft.body, initial: true) { _, body in
                guard draft.rich.map({ String($0.characters) != body }) ?? true else { return }
                let fresh = draft.rich == nil
                draft.rich = AttributedString(body)
                if fresh, let rich = draft.rich { selection = AttributedTextSelection(insertionPoint: rich.startIndex) }
            }
            .onChange(of: draft.rich) { _, rich in draft.richHTML = rich.flatMap { Self.html($0, fonts) } }
    }

    /// The writing as HTML, when anything in it is formatted.
    static func html(_ text: AttributedString, _ fonts: Font.Context) -> String? {
        guard text.runs.contains(where: { $0.font != nil || $0.underlineStyle != nil || $0.strikethroughStyle != nil || $0.link != nil }) else {
            return nil
        }
        let base = Font.md.resolve(in: fonts).pointSize
        let escape = { (s: String) in
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
                .replacingOccurrences(of: "\"", with: "&quot;")
        }
        return text.runs.map { run in
            var s = escape(String(text[run.range].characters)).replacingOccurrences(of: "\n", with: "<br>")
            guard !s.isEmpty else { return "" }
            let font = run.font?.resolve(in: fonts)
            if font?.isBold == true { s = "<b>\(s)</b>" }
            if font?.isItalic == true { s = "<i>\(s)</i>" }
            if run.underlineStyle != nil { s = "<u>\(s)</u>" }
            if run.strikethroughStyle != nil { s = "<s>\(s)</s>" }
            if let size = font?.pointSize, size > base + 1 { s = "<span style=\"font-size:1.3em\">\(s)</span>" }
            if let url = run.link { s = "<a href=\"\(escape(url.absoluteString))\">\(s)</a>" }
            return s
        }
        .joined()
    }
}

extension Binding where Value == Draft {
    /// The formatted text, the plain one kept in step.
    var richText: Binding<AttributedString> {
        Binding<AttributedString>(
            get: { wrappedValue.rich ?? AttributedString(wrappedValue.body) },
            set: { wrappedValue.rich = $0; wrappedValue.body = String($0.characters) }
        )
    }
}

/// A round format button in the card's corner, right over the keyboard, that opens into a bar of tools to its left.
@available(iOS 26, macOS 26, *)
private struct FormatBar: View {
    @Binding var draft: Draft
    @Binding var selection: AttributedTextSelection
    @Binding var open: Bool
    @State private var linking = false
    @State private var link = ""
    @Environment(\.fontResolutionContext) private var fonts

    private var text: Binding<AttributedString> { $draft.richText }
    private var at: AttributeContainer { selection.typingAttributes(in: text.wrappedValue) }
    private var resolved: Font.Resolved { (at.font ?? .md).resolve(in: fonts) }
    private var heading: Bool { resolved.pointSize > Font.md.resolve(in: fonts).pointSize + 1 }

    var body: some View {
        GlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                if open {
                    HStack(spacing: 2) {
                        tool("Bold", "bold", on: resolved.isBold) { restyle(bold: !resolved.isBold) }
                        tool("Italic", "italic", on: resolved.isItalic) { restyle(italic: !resolved.isItalic) }
                        tool("Underline", "underline", on: at.underlineStyle != nil) { change { $0.underlineStyle = at.underlineStyle == nil ? .single : nil } }
                        tool("Strikethrough", "strikethrough", on: at.strikethroughStyle != nil) {
                            change { $0.strikethroughStyle = at.strikethroughStyle == nil ? .single : nil }
                        }
                        tool("Heading", "textformat.size.larger", on: heading) { restyle(heading: !heading) }
                        tool("Bulleted list", "list.bullet", on: false) { list(numbered: false) }
                        tool("Numbered list", "list.number", on: false) { list(numbered: true) }
                        tool("Link", "link", on: at.link != nil) {
                            link = at.link?.absoluteString ?? ""
                            linking = true
                        }
                        tool("Clear formatting", "textformat.alt", on: false) {
                            change {
                                $0.font = nil
                                $0.underlineStyle = nil
                                $0.strikethroughStyle = nil
                                $0.link = nil
                            }
                        }
                    }
                    .padding(.horizontal, 4).frame(height: 44)
                    .glass(in: Capsule())
                    .transition(AnyTransition.scale(scale: 0.6, anchor: .trailing).combined(with: .opacity))
                }
                Button(open ? "Done formatting" : "Format", systemImage: open ? "xmark" : "textformat") {
                    withAnimation(.smooth(duration: 0.3)) { open.toggle() }
                }
                .labelStyle(.iconOnly).font(.lg).foregroundStyle(.ink)
                .frame(width: 44, height: 44)
                .contentShape(.circle)
                .glass(in: Circle())
            }
        }
        .buttonStyle(.plain)
        .alert("Link", isPresented: $linking) {
            TextField("https://", text: $link)
            Button("Add") { addLink() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func tool(_ label: String, _ symbol: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(label, systemImage: symbol, action: action)
            .labelStyle(.iconOnly).font(.md.weight(on ? .bold : .regular))
            .foregroundStyle(on ? Color.onInk : .ink)
            .frame(width: 32, height: 32)
            .background(on ? Color.ink : .clear, in: .circle)
            .contentShape(.circle)
            .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func change(_ edit: (inout AttributeContainer) -> Void) {
        var t = text.wrappedValue
        // With nothing selected it's for what's typed next: the cursor carries it.
        if case .insertionPoint(let i) = selection.indices(in: t) {
            var next = at
            edit(&next)
            selection = AttributedTextSelection(insertionPoint: i, typingAttributes: next)
            return
        }
        t.transformAttributes(in: &selection, body: edit)
        text.wrappedValue = t
    }

    /// Bold, italic and heading make one font, so each keeps the others as they are.
    private func restyle(bold: Bool? = nil, italic: Bool? = nil, heading: Bool? = nil) {
        let base = Font.md.resolve(in: fonts).pointSize
        change { c in
            let now = (c.font ?? .md).resolve(in: fonts)
            var font: Font = heading ?? (now.pointSize > base + 1) ? .xl : .md
            if bold ?? now.isBold { font = font.bold() }
            if italic ?? now.isItalic { font = font.italic() }
            c.font = font == .md ? nil : font
        }
    }
    /// "• " or "1. " in front of each line in the selection, or off again where the first line has it.
    private func list(numbered: Bool) {
        var t = text.wrappedValue
        let (lo, hi): (AttributedString.Index, AttributedString.Index) = switch selection.indices(in: t) {
        case .insertionPoint(let i): (i, i)
        case .ranges(let r): (r.ranges.first?.lowerBound ?? t.startIndex, r.ranges.last?.upperBound ?? t.endIndex)
        }
        var starts: [AttributedString.Index] = []
        var i = lo
        while i > t.startIndex, t.characters[t.characters.index(before: i)] != "\n" { i = t.characters.index(before: i) }
        starts.append(i)
        while let next = t.characters[i..<hi].firstIndex(of: "\n") {
            i = t.characters.index(after: next)
            starts.append(i)
        }
        let firstLine = String(t.characters[starts[0]...].prefix { $0 != "\n" })
        let off = numbered ? firstLine.wholeMatch(of: /\d+\. .*/) != nil : firstLine.hasPrefix("• ")
        for (n, start) in starts.enumerated().reversed() {
            let line = String(t.characters[start...].prefix { $0 != "\n" })
            if off {
                let mark = numbered ? line.prefixMatch(of: #/\d+\. /#).map { $0.output.count } ?? 0 : line.hasPrefix("• ") ? 2 : 0
                let end = t.characters.index(start, offsetBy: mark)
                t.removeSubrange(start..<end)
            } else {
                t.insert(AttributedString(numbered ? "\(n + 1). " : "• "), at: start)
            }
        }
        let end = t.characters[starts.last!...].firstIndex(of: "\n") ?? t.endIndex
        text.wrappedValue = t
        selection = AttributedTextSelection(insertionPoint: end)
    }

    /// On selected words they become the link; with nothing selected the address is written in as one.
    private func addLink() {
        guard let url = URL(string: link.contains("://") ? link : "https://\(link)"), !link.isEmpty else { return }
        if case .insertionPoint(let i) = selection.indices(in: text.wrappedValue) {
            var t = text.wrappedValue
            var piece = AttributedString(link)
            piece.link = url
            t.insert(piece, at: i)
            text.wrappedValue = t
            selection = AttributedTextSelection(insertionPoint: t.characters.index(i, offsetBy: link.count))
        } else {
            change { $0.link = url }
        }
    }
}

#if os(iOS)
/// The camera, for a photo to attach.
struct Camera: UIViewControllerRepresentable {
    let take: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let camera: Camera
        init(_ camera: Camera) { self.camera = camera }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { camera.take(image) }
            camera.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { camera.dismiss() }
    }
}
#endif
