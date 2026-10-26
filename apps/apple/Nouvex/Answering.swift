// SPDX-License-Identifier: AGPL-3.0-only
import Foundation

/// How a reply or forward is addressed and titled, apart from the app so it can be tested.
enum Answering {
    enum Kind { case reply, replyAll, forward }

    /// What the message being answered says about itself.
    struct Original {
        var from: String
        var replyTo: String?
        var to: [String]
        var cc: [String]
    }

    // Prefixes other mail apps put in front, in English, German and Nordic ones; one is enough.
    private static let replies = ["re", "aw", "antw", "sv", "vs"]
    private static let forwards = ["fwd", "fw", "wg", "vb", "tr"]

    /// "Re: Plan" for a reply, "Fwd: Plan" for a forward, without stacking "Re: Aw: Plan".
    static func subject(_ kind: Kind, _ subject: String) -> String {
        let trimmed = subject.trimmingCharacters(in: .whitespaces)
        let head = trimmed.prefix { $0 != ":" }.lowercased()
        let known = trimmed.contains(":") && (kind == .forward ? forwards : replies).contains(head)
        if known { return trimmed }
        return (kind == .forward ? "Fwd: " : "Re: ") + trimmed
    }

    /// Who an answer goes to. A reply goes to Reply-To where there is one, else to the sender, and to whoever one of
    /// our own messages went to; Reply all keeps the others in Cc, as they were, without our own addresses.
    static func addresses(_ kind: Kind, _ m: Original, mine: Set<String>) -> (to: [String], cc: [String]) {
        guard kind != .forward else { return ([], []) }
        let ours = mine.contains(m.from.lowercased())
        let to = ours ? m.to : [m.replyTo ?? m.from]
        guard kind == .replyAll else { return (to, []) }
        var seen = Set((to + Array(mine)).map { $0.lowercased() })
        let cc = ((ours ? [] : m.to) + m.cc).filter { seen.insert($0.lowercased()).inserted }
        return (to.filter { !mine.contains($0.lowercased()) }, cc)
    }

    /// The References of an answer: the conversation's Message-IDs, oldest first, the newest 20.
    static func references(_ thread: [String]) -> [String] {
        Array(thread.filter { !$0.isEmpty }.suffix(20))
    }
}
