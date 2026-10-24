// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI

// The type scale from docs/design.md, in SF Pro. On iOS the same steps follow the text size the reader picked.
extension Font {
    #if os(macOS)
    static let xs = Font.system(size: 12)
    static let sm = Font.system(size: 13)
    static let md = Font.system(size: 14)
    static let lg = Font.system(size: 16)
    static let xl = Font.system(size: 18, weight: .semibold)
    #else
    static let xs = Font.caption
    static let sm = Font.footnote
    static let md = Font.subheadline
    static let lg = Font.body
    static let xl = Font.title3.weight(.semibold)
    #endif
}

/// The smallest a button gets: the pointer is precise, a finger isn't.
#if os(macOS)
let tapSize: CGFloat = 28
#else
let tapSize: CGFloat = 44
#endif

extension Date {
    /// "Fri 09:00": when something is snoozed until or scheduled for.
    var when: String { formatted(.dateTime.weekday(.abbreviated).hour().minute()) }
}

enum Device {
    #if os(macOS)
    static let platform = "macOS"
    #else
    static let platform = "iOS"
    #endif

    /// Phones write in a sheet; iPad and Mac dock the composer next to the mail.
    @MainActor static var phone: Bool {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .phone
        #else
        false
        #endif
    }
}

extension EnvironmentValues {
    /// Narrow enough for the phone layout: an iPhone, a folded iPhone Duo, an iPad in Slide Over.
    @Entry var compact = false
}

/// A destructive action that has to be held, not clicked: the fill shows how long is left.
struct HoldButton: View {
    let title: String
    var duration = 1.2
    let action: () -> Void
    @State private var progress: CGFloat = 0

    var body: some View {
        Text(title)
            .font(.sm.weight(.medium))
            .foregroundStyle(.danger)
            .padding(.horizontal, 10)
            .frame(minHeight: tapSize)
            .background(alignment: .leading) {
                GeometryReader { g in Color.danger.opacity(0.16).frame(width: g.size.width * progress) }
            }
            .background(.hover)
            .clipShape(.rect(cornerRadius: Radius.md))
            .contentShape(.rect)
            .onLongPressGesture(minimumDuration: duration) {
                progress = 0
                action()
            } onPressingChanged: { pressing in
                withAnimation(pressing ? .linear(duration: duration) : .quick) { progress = pressing ? 1 : 0 }
            }
            .help("Hold to \(title.lowercased())")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { action() }
    }
}

/// Small notes at the bottom of the window: sent, snoozed, scheduled, or what went wrong.
struct Toasts: View {
    @Environment(Mail.self) private var mail

    var body: some View {
        VStack(spacing: 6) {
            ForEach(mail.toasts) { t in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.title).font(.sm.weight(.medium)).foregroundStyle(.ink)
                        if let detail = t.detail { Text(detail).font(.xs).foregroundStyle(.muted).lineLimit(2) }
                    }
                    if let action = t.action {
                        Spacer(minLength: 0)
                        Button(action.label) { action.run() }.font(.sm.weight(.medium)).buttonStyle(.plain).foregroundStyle(.ink)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .frame(maxWidth: 420, alignment: .leading)
                .glass(in: RoundedRectangle(cornerRadius: Radius.lg))
                .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
            }
        }
        // Only a toast with something to do takes taps; the rest lets them through to what's under it.
        .allowsHitTesting(mail.toasts.contains { $0.action != nil })
    }
}

enum Clipboard {
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

/// Keeps the app running for a while after it leaves the screen, so a send or a change that started still reaches the
/// server.
enum Background {
    @MainActor static func keepAlive<T>(_ work: () async -> T) async -> T {
        #if os(iOS)
        let id = UIApplication.shared.beginBackgroundTask()
        defer { UIApplication.shared.endBackgroundTask(id) }
        #endif
        return await work()
    }
}

enum Radius {
    static let md: CGFloat = 8
    static let lg: CGFloat = 12
    static let xl: CGFloat = 20
}

/// 120 to 200 ms, ease-out, as everywhere in Nouvex.
extension Animation {
    static let quick = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.16)
}

/// Unread: a small ink dot, nothing louder.
struct Dot: View {
    var on = true
    var color = Color.ink

    var body: some View {
        Circle().fill(color).frame(width: 6, height: 6).opacity(on ? 1 : 0)
    }
}

extension Color {
    /// One of the label hues, by its name in styles.css.
    static func label(hue name: String?) -> Color? {
        switch name {
        case "gray": .labelGray
        case "red": .labelRed
        case "orange": .labelOrange
        case "green": .labelGreen
        case "blue": .labelBlue
        case "purple": .labelPurple
        default: nil
        }
    }

    /// A label hue as text, as dark as a chip's (label-text in styles.css).
    static func label(_ name: String?) -> Color? { label(hue: name)?.mix(with: .ink, by: 0.3, in: .perceptual) }
}

/// Initials in a quiet circle, for people and accounts.
struct Avatar: View {
    let name: String
    var size: CGFloat = 32
    /// An account's label hue, if it has one.
    var color: String?

    var body: some View {
        let letters = name.split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." }).prefix(2).compactMap(\.first)
        let hue = Color.label(hue: color)
        Text(String(letters).uppercased())
            .font(.system(size: size * 0.38, weight: .medium))
            .foregroundStyle(Color.label(color) ?? .muted)
            .frame(width: size, height: size)
            .background(hue.map { $0.mix(with: .paper, by: 0.78, in: .perceptual) } ?? .line, in: .circle)
    }
}

/// Text or an icon with a hover fill, for everything that isn't the main action.
struct QuietButtonStyle: ButtonStyle {
    var square = false
    @State private var hovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.md)
            .foregroundStyle(hovered ? .ink : .muted)
            .padding(.horizontal, square ? 0 : 8)
            .frame(minWidth: square ? tapSize : nil, minHeight: tapSize)
            .background(hovered || configuration.isPressed ? Color.hover : .clear, in: .rect(cornerRadius: Radius.md))
            .contentShape(.rect)
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .onHover { hovered = $0 }
            .animation(.quick, value: configuration.isPressed)
    }
}

/// An icon that stands for a word, with the word and its key in the tooltip.
struct IconButton: View {
    let label: String
    let symbol: String
    var key: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15))
        }
        .buttonStyle(QuietButtonStyle(square: true))
        .help(key.map { "\(label) (\($0))" } ?? label)
        .accessibilityLabel(label)
    }
}

/// A text field with the input border; the border turns ink while typing in it.
struct Field: ViewModifier {
    var focused: Bool

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(.md)
            .padding(.horizontal, 10)
            .frame(height: 36)
            .background(.paper, in: .rect(cornerRadius: Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).stroke(focused ? Color.ink : .lineStrong))
    }
}

extension Date {
    /// The time today, the weekday this week, the date before.
    var mailDate: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if let week = cal.date(byAdding: .day, value: -6, to: .now), self > week { return formatted(.dateTime.weekday(.abbreviated)) }
        return formatted(.dateTime.day().month(.abbreviated))
    }
}

extension View {
    /// Esc on the Mac; elsewhere there's no such key.
    func onEscape(perform action: @escaping () -> Void) -> some View {
        #if os(macOS)
        onExitCommand(perform: action)
        #else
        self
        #endif
    }
}

// Liquid Glass came with iOS 26; on iOS 18 the closest material stands in.
extension View {
    @ViewBuilder func glass(in shape: some Shape, interactive: Bool = false) -> some View {
        if #available(iOS 26, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
        }
    }

    @ViewBuilder func glassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26, *) {
            if prominent { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
        } else {
            if prominent { buttonStyle(.borderedProminent) } else { buttonStyle(.bordered) }
        }
    }
}

/// Lets glass shapes next to each other blend, where there's glass.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        if #available(iOS 26, *) { GlassEffectContainer(spacing: spacing) { content } } else { content }
    }
}
