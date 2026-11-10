// SPDX-License-Identifier: AGPL-3.0-only
import Testing

struct SearchTests {
    private func fit(_ typed: String, _ word: String) -> Int {
        Search.likeness(Search.Term(Search.words(typed)[0]), Search.Term(Search.words(word)[0]))
    }

    @Test func likeness() {
        #expect(fit("kündigung", "Kuendigung") == 1)
        #expect(fit("kundigung", "Kündigung") == 4)
        #expect(fit("künd", "Kündigung") == 3)
        #expect(fit("rechnungen", "Rechnung") == 3)
        #expect(fit("rechnung", "Stromrechnung") == 2)
        #expect(fit("hartman", "Hartmann") == 3)
        #expect(fit("lnea", "Lena") == 1)
        #expect(fit("pubilc", "Public") == 1)
        #expect(fit("kys", "Keys") == 0)
    }

    @Test func theWordComesBeforeAWordItIsPartOf() {
        let typed = Search.terms("kündigung")
        let word = Search.score(typed, sender: "A", subject: "Hallo", snippet: "Ihre Kündigung ist da")
        let part = Search.score(typed, sender: "A", subject: "Ihre Paketankündigung", snippet: "")
        #expect(word > part)
        #expect(part > 0)
        #expect(Search.score(typed + Search.terms("strom"), sender: "A", subject: "Kündigung", snippet: "") == 0)
    }
}
