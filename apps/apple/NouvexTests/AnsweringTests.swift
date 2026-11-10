// SPDX-License-Identifier: AGPL-3.0-only
import Testing

struct AnsweringTests {
    let lena = Answering.Original(
        from: "lena@x.example", replyTo: nil, to: ["me@nouvex.cc", "jonas@x.example"], cc: ["max@x.example", "ME@nouvex.cc"]
    )
    let mine: Set<String> = ["me@nouvex.cc", "work@nouvex.cc"]

    @Test func subjects() {
        #expect(Answering.subject(.reply, "Plan") == "Re: Plan")
        #expect(Answering.subject(.reply, "Re: Plan") == "Re: Plan")
        #expect(Answering.subject(.reply, "AW: Plan") == "AW: Plan")
        #expect(Answering.subject(.reply, "Sv: Plan") == "Sv: Plan")
        #expect(Answering.subject(.forward, "Re: Plan") == "Fwd: Re: Plan")
        #expect(Answering.subject(.forward, "WG: Plan") == "WG: Plan")
        #expect(Answering.subject(.forward, "Fw: Plan") == "Fw: Plan")
        #expect(Answering.subject(.reply, "Retro: Plan") == "Re: Retro: Plan")
    }

    @Test func reply() {
        #expect(Answering.addresses(.reply, lena, mine: mine) == (["lena@x.example"], []))
        var list = lena
        list.replyTo = "team@lists.example"
        #expect(Answering.addresses(.reply, list, mine: mine).to == ["team@lists.example"])
        #expect(Answering.addresses(.forward, lena, mine: mine) == ([], []))
    }

    /// Reply all keeps To and Cc apart, and leaves our own addresses out, whatever their case.
    @Test func replyAll() {
        let (to, cc) = Answering.addresses(.replyAll, lena, mine: mine)
        #expect(to == ["lena@x.example"])
        #expect(cc == ["jonas@x.example", "max@x.example"])
    }

    /// Answering one of our own messages goes to whoever it went to.
    @Test func ourOwn() {
        let sent = Answering.Original(from: "Me@nouvex.cc", replyTo: nil, to: ["lena@x.example"], cc: ["max@x.example"])
        #expect(Answering.addresses(.reply, sent, mine: mine) == (["lena@x.example"], []))
        #expect(Answering.addresses(.replyAll, sent, mine: mine) == (["lena@x.example"], ["max@x.example"]))
    }

    /// A saved reply comes back as one text; what's written and the quote come apart again.
    @Test func split() {
        let saved = "Sure, Friday works.\n\n-- \nMateo\n\nOn 6 Nov 2026 at 15:00, Lena wrote:\n> Dinner?\n> On Mon, Max wrote:"
        let (body, quote) = Answering.split(saved)
        #expect(body == "Sure, Friday works.\n\n-- \nMateo")
        #expect(quote == "\n\nOn 6 Nov 2026 at 15:00, Lena wrote:\n> Dinner?\n> On Mon, Max wrote:")
        #expect(Answering.split("On 6 Nov, Lena wrote:\n> Hi") == ("", "\n\nOn 6 Nov, Lena wrote:\n> Hi"))
        #expect(Answering.split("No quote here") == ("No quote here", ""))
    }

    /// A quote comes apart into its messages, newest first, each without its ">".
    @Test func history() {
        let quote = "\n\nOn 6 Nov 2026 at 15:00, Lena wrote:\n> Dinner?\n>\n> On Thu, 6 Nov, Max wrote:\n> > Sure\n> > soon"
        #expect(Answering.history(quote) == [
            .init(from: "Lena", date: "6 Nov 2026 at 15:00", text: "Dinner?"),
            .init(from: "Max", date: "Thu, 6 Nov", text: "Sure\nsoon"),
        ])
        #expect(Answering.history("On 6 Nov, Lena wrote:\n> > Dinner?").first?.text == "Dinner?")
        #expect(Answering.history("On 6 Nov, Lena wrote:\n \u{00A0}>\u{00A0}Dinner?").first?.text == "Dinner?")
        #expect(Answering.history("no quote").isEmpty)
    }

    @Test func references() {
        let ids = (1...25).map { "<\($0)@x>" }
        #expect(Answering.references(ids) == Array(ids.suffix(20)))
        #expect(Answering.references(["", "<a@x>"]) == ["<a@x>"])
    }
}
