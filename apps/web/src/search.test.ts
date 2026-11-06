// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import type { Message } from "./db";
import { find, index, likeness, passes } from "./search";

const m: Message = {
	id: "1",
	accountId: "a",
	key: "",
	mailboxId: "b",
	messageId: "x",
	threadId: "x",
	subject: "Keys for the new flat",
	snippet: "When can you pick them up?",
	fromName: "Lena Hartmann",
	fromAddr: "lena@hartmann.example",
	to: ["mateo@nouvex.cc"],
	cc: [],
	sentAt: "2026-10-08T09:12:00",
	flags: [],
	size: 10,
	attachments: [{ name: "plan.pdf", type: "application/pdf", size: 5 }],
	category: "primary",
	actions: [],
	seen: 0,
	starred: 0,
};
const q = (text: string, ...filters: [string, string][]) => ({
	text,
	filters: filters.map(([key, value]) => ({ key, value })),
});

const box = new Set(["b"]);
const hit = (text: string, msg = m) => find(index([msg]), q(text), box).length === 1;

test("words match subject, snippet and sender, all of them", () => {
	expect(hit("lena keys")).toBe(true);
	expect(hit("pick")).toBe(true);
	expect(hit("lena invoice")).toBe(false);
});

test("typos, accents, word starts and compounds still find it", () => {
	expect(hit("hartman")).toBe(true);
	expect(hit("lnea")).toBe(true);
	expect(hit("kesy flta")).toBe(true);
	expect(hit("hartmnan keys")).toBe(true);
	expect(hit("kys")).toBe(false);
	expect(hit("har")).toBe(true);
	expect(hit("muller", { ...m, fromName: "Jonas Müller" })).toBe(true);
	expect(hit("rechnung", { ...m, subject: "Ihre Stromrechnung" })).toBe(true);
	expect(hit("rechung", { ...m, subject: "Ihre Rechnung" })).toBe(true);
	expect(hit("xyzzy")).toBe(false);
	expect(find(index([{ ...m, mailboxId: "other" }]), q("lena"), box)).toEqual([]);
});

test("likeness", () => {
	expect(likeness("lena", "lena")).toBe(4);
	expect(likeness("le", "lena")).toBe(3);
	expect(likeness("rechnung", "stromrechnung")).toBe(2);
	expect(likeness("rehcnung", "rechnung")).toBe(1);
	expect(likeness("rehcn", "rechnung")).toBe(1);
	expect(likeness("abc", "abd")).toBe(0);
	expect(likeness("lena", "paul")).toBe(0);
});

test("the best fit comes first, newer first among equals", () => {
	const old = { ...m, id: "2", sentAt: "2025-01-01T00:00:00" };
	const typo = {
		...m,
		id: "3",
		fromName: "Lean Hart",
		fromAddr: "lean@x",
		subject: "",
		snippet: "",
		sentAt: "2026-11-01T00:00:00",
	};
	const subject = {
		...m,
		id: "4",
		fromName: "Paul",
		fromAddr: "paul@x",
		subject: "Lena's keys",
		sentAt: "2026-11-02T00:00:00",
	};
	expect(find(index([old, typo, m, subject]), q("lena"), box).map((x) => x.id)).toEqual(["1", "2", "4", "3"]);
});

test("filters", () => {
	const matches = (msg: Message, query: ReturnType<typeof q>) => passes(msg, query.filters);
	expect(matches(m, q("", ["from", "hartmann"], ["is", "unread"], ["has", "attachment"]))).toBe(true);
	expect(matches(m, q("", ["after", "2026-10-08"], ["before", "2026-10-09"]))).toBe(true);
	expect(matches(m, q("", ["after", "2026-10-09"]))).toBe(false);
	expect(matches({ ...m, flags: ["\\Seen"] }, q("", ["is", "unread"]))).toBe(false);
	expect(matches(m, q("", ["is", "starred"]))).toBe(false);
	expect(matches(m, q("", ["to", "mateo"]))).toBe(true);
	expect(matches(m, q("", ["to", "lena@hartmann.example"]))).toBe(false);
});
