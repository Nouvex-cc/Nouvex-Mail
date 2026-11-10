// SPDX-License-Identifier: AGPL-3.0-only
import Foundation

/// How typed words fit the words of a mail. The web ranks the same way, in apps/web/src/search.ts; a change here
/// belongs there too.
enum Search {
    /// A folded word as bytes, and which letters it has, so tens of thousands can be compared while someone types.
    struct Term: Sendable {
        let text: String
        let bytes: [UInt8]
        let letters: UInt32

        init(_ folded: String) {
            text = folded
            bytes = Array(folded.utf8)
            letters = bytes.reduce(0) { $0 | 1 << ($1 & 31) }
        }
    }

    /// The words of a text, lowercase and without accents, so "muller" finds "Müller" and "lena@x" finds "lena".
    /// SQLite's unicode61 tokenizer splits and folds the index the same way. Plain ASCII words skip the slow folding.
    static func words(_ s: String) -> [String] {
        var out: [String] = [], word: [UInt8] = [], plain = true
        func end() {
            if !word.isEmpty {
                let w = String(decoding: word, as: UTF8.self)
                if plain { out.append(w) } else {
                    out += w.folding(options: .diacriticInsensitive, locale: nil).lowercased()
                        .split { !$0.isLetter && !$0.isNumber }.map(String.init)
                }
            }
            word.removeAll(keepingCapacity: true)
            plain = true
        }
        for b in s.utf8 {
            switch b {
            case 97...122, 48...57: word.append(b)
            case 65...90: word.append(b + 32)
            case 128...: word.append(b); plain = false
            default: end()
            }
        }
        end()
        return out
    }

    static func terms(_ s: String) -> [Term] { words(s).map(Term.init) }

    /// How well a typed word fits a word of the mail: 4 the same, 3 how it starts or the same word with an ending
    /// ("rechnungen" for "Rechnung"), 2 inside it ("rechnung" in "stromrechnung"), 1 a typo away (two in long words,
    /// also while the word is still being typed), 0 not at all.
    static func likeness(_ t: Term, _ w: Term) -> Int {
        let a = t.bytes, b = w.bytes
        if a == b { return 4 }
        if b.starts(with: a) { return 3 }
        if b.count >= 5, a.count > b.count, a.count - b.count <= 3, a.starts(with: b) { return 3 }
        if a.count >= 3, b.count > a.count, contains(b, a) { return 2 }
        if a.count < 4 { return 0 }
        let allowed = a.count < 8 ? 1 : 2
        // Every edit explains at most one letter the word doesn't have.
        if b.count < a.count - allowed || (t.letters & ~w.letters).nonzeroBitCount > allowed { return 0 }
        return edits(a, b, allowed) <= allowed || edits(a, Array(b.prefix(a.count)), allowed) <= allowed ? 1 : 0
    }

    private static func contains(_ word: [UInt8], _ part: [UInt8]) -> Bool {
        word.withUnsafeBytes { w in part.withUnsafeBytes { memmem(w.baseAddress, w.count, $0.baseAddress, $0.count) != nil } }
    }

    /// Letters added, dropped, changed or two swapped to turn a into b; anything above limit counts as limit + 1.
    static func edits(_ a: [UInt8], _ b: [UInt8], _ limit: Int) -> Int {
        if abs(a.count - b.count) > limit { return limit + 1 }
        if a.isEmpty || b.isEmpty { return max(a.count, b.count) }
        var before: [Int] = [], prev = Array(0...b.count)
        for i in 1...a.count {
            var row = [i]
            row.reserveCapacity(b.count + 1)
            for j in 1...b.count {
                var d = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
                if i > 1, j > 1, a[i - 1] == b[j - 2], a[i - 2] == b[j - 1] { d = min(d, before[j - 2] + 1) }
                row.append(d)
            }
            if row.min()! > limit { return limit + 1 }
            (before, prev) = (prev, row)
        }
        return prev[b.count]
    }

    // The word itself beats a word it's only part of, and that beats a typo, wherever in the mail each one is: a
    // Kündigung in the preview comes before a Paketankündigung in the subject.
    private static let tier = [0, 0, 1, 2, 2]
    private static func value(_ likeness: Int, _ weight: Int) -> Int { tier[likeness] * 1000 + likeness * weight }

    /// How well a message fits every typed word, 0 when one of them isn't there. Within a tier a word in the sender
    /// counts most, then the subject, then the preview.
    static func score(_ typed: [Term], sender: String, subject: String, snippet: String) -> Int {
        let fields = [(terms(sender), 3), (terms(subject), 2), (terms(snippet), 1)]
        var total = 0
        for t in typed {
            var best = 0
            for (list, weight) in fields {
                for w in list {
                    let l = likeness(t, w)
                    if l > 0 { best = max(best, value(l, weight)) }
                }
            }
            if best == 0 { return 0 }
            total += best
        }
        return total
    }
}
