// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, test } from "vitest";
import { addresses, references, subject, text } from "./answering";

const lena = {
	fromAddr: "lena@x.example",
	to: ["me@nouvex.cc", "jonas@x.example"],
	cc: ["max@x.example", "ME@nouvex.cc"],
};
const mine = new Set(["me@nouvex.cc", "work@nouvex.cc"]);

test("subjects get one prefix", () => {
	expect(subject("reply", "Plan")).toBe("Re: Plan");
	expect(subject("reply", "Re: Plan")).toBe("Re: Plan");
	expect(subject("reply", "AW: Plan")).toBe("AW: Plan");
	expect(subject("reply", "Sv: Plan")).toBe("Sv: Plan");
	expect(subject("forward", "Re: Plan")).toBe("Fwd: Re: Plan");
	expect(subject("forward", "WG: Plan")).toBe("WG: Plan");
	expect(subject("reply", "Retro: Plan")).toBe("Re: Retro: Plan");
});

test("a reply goes to Reply-To, else the sender", () => {
	expect(addresses("reply", lena, mine)).toEqual({ to: ["lena@x.example"], cc: [] });
	expect(addresses("reply", { ...lena, replyTo: "team@lists.example" }, mine).to).toEqual(["team@lists.example"]);
	expect(addresses("forward", lena, mine)).toEqual({ to: [], cc: [] });
});

test("reply all keeps To and Cc apart, without our own addresses", () => {
	expect(addresses("replyAll", lena, mine)).toEqual({
		to: ["lena@x.example"],
		cc: ["jonas@x.example", "max@x.example"],
	});
});

test("answering our own message goes to whoever it went to", () => {
	const sent = { fromAddr: "Me@nouvex.cc", to: ["lena@x.example"], cc: ["max@x.example"] };
	expect(addresses("reply", sent, mine)).toEqual({ to: ["lena@x.example"], cc: [] });
	expect(addresses("replyAll", sent, mine)).toEqual({ to: ["lena@x.example"], cc: ["max@x.example"] });
});

test("references keep the newest 20", () => {
	const ids = Array.from({ length: 25 }, (_, i) => `<${i}@x>`);
	expect(references(ids)).toEqual(ids.slice(-20));
	expect(references(["", "<a@x>"])).toEqual(["<a@x>"]);
});

test("quoting HTML keeps its lines", () => {
	expect(text("<style>p{}</style><p>Hi,</p><p>see you<br>Friday</p><ul><li>one</li><li>two</li></ul>")).toBe(
		"Hi,\nsee you\nFriday\none\ntwo",
	);
});
