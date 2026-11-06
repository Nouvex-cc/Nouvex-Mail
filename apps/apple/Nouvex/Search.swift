// SPDX-License-Identifier: AGPL-3.0-only
import Foundation

/// How typed words fit the words of a mail. The web ranks the same way, in apps/web/src/search.ts; a change here
/// belongs there too.
enum Search {
    /// The words of a text, lowercase and without accents, so "muller" finds "Müller" and "lena@x" finds "lena".
    /// SQLite's unicode61 tokenizer splits and folds the index the same way.
    static func words(_ s: String) -> [String] {
        s.folding(options: .diacriticInsensitive, locale: nil).lowercased()
            .split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    /// How well a typed word fits a word of the mail: 4 the same, 3 how it starts, 2 inside it ("rechnung" in
    /// "stromrechnung"), 1 a typo away (two in long words, also while the word is still being typed), 0 not at all.
    static func likeness(_ typed: String, _ word: String) -> Int {
        if word == typed { return 4 }
        if word.hasPrefix(typed) { return 3 }
        if typed.count >= 3, word.contains(typed) { return 2 }
        if typed.count < 4 { return 0 }
        let a = Array(typed), b = Array(word), max = a.count < 8 ? 1 : 2
        return edits(a, b, max) <= max || edits(a, Array(b.prefix(a.count)), max) <= max ? 1 : 0
    }

    /// Letters added, dropped, changed or two swapped to turn a into b; anything above max counts as max + 1.
    static func edits(_ a: [Character], _ b: [Character], _ max: Int) -> Int {
        if abs(a.count - b.count) > max { return max + 1 }
        if a.isEmpty || b.isEmpty { return Swift.max(a.count, b.count) }
        var before: [Int] = [], prev = Array(0...b.count)
        for i in 1...a.count {
            var row = [i]
            for j in 1...b.count {
                var d = Swift.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
                if i > 1, j > 1, a[i - 1] == b[j - 2], a[i - 2] == b[j - 1] { d = Swift.min(d, before[j - 2] + 1) }
                row.append(d)
            }
            if row.min()! > max { return max + 1 }
            (before, prev) = (prev, row)
        }
        return prev[b.count]
    }

    /// How well a message fits every typed word, 0 when one of them isn't there. A word in the sender counts most,
    /// then the subject, then the preview.
    static func score(_ typed: [String], sender: String, subject: String, snippet: String) -> Int {
        let fields = [(words(sender), 3), (words(subject), 2), (words(snippet), 1)]
        var total = 0
        for t in typed {
            let best = fields.map { list, weight in (list.map { likeness(t, $0) }.max() ?? 0) * weight }.max() ?? 0
            if best == 0 { return 0 }
            total += best
        }
        return total
    }
}
