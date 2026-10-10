// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import type { Message } from "./db";
import { matches } from "./search";

const m: Message = {
	id: "1",
	accountId: "a",
	mailboxId: "b",
	messageId: "x",
	subject: "Keys for the new flat",
	snippet: "When can you pick them up?",
	fromName: "Lena Hartmann",
	fromAddr: "lena@hartmann.example",
	sentAt: "2026-10-08T09:12:00",
	flags: [],
	size: 10,
	attachments: [{ name: "plan.pdf", type: "application/pdf", size: 5 }],
};
const q = (text: string, ...filters: [string, string][]) => ({
	text,
	filters: filters.map(([key, value]) => ({ key, value })),
});

test("words match subject, snippet and sender, all of them", () => {
	expect(matches(m, q("lena keys"))).toBe(true);
	expect(matches(m, q("pick"))).toBe(true);
	expect(matches(m, q("lena invoice"))).toBe(false);
});

test("filters", () => {
	expect(matches(m, q("", ["from", "hartmann"], ["is", "unread"], ["has", "attachment"]))).toBe(true);
	expect(matches(m, q("", ["after", "2026-10-08"], ["before", "2026-10-09"]))).toBe(true);
	expect(matches(m, q("", ["after", "2026-10-09"]))).toBe(false);
	expect(matches({ ...m, flags: ["\\Seen"] }, q("", ["is", "unread"]))).toBe(false);
	expect(matches(m, q("", ["is", "starred"]))).toBe(false);
	expect(matches(m, q("", ["to", "lena@hartmann.example"]))).toBe(false);
});
