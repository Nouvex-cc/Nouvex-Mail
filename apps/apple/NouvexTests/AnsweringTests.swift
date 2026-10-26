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

    @Test func references() {
        let ids = (1...25).map { "<\($0)@x>" }
        #expect(Answering.references(ids) == Array(ids.suffix(20)))
        #expect(Answering.references(["", "<a@x>"]) == ["<a@x>"])
    }
}
