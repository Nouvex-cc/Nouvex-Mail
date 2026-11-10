// SPDX-License-Identifier: AGPL-3.0-only
import type { SearchFilter, SearchQuery } from "@nouvex/ui";
import type { Message } from "./db";

// The Apple app ranks the same way, in apps/apple/Nouvex/Search.swift; a change here belongs there too.

/** The words of a text, lowercase and without accents, so "muller" finds "Müller" and "lena@x" finds "lena". */
export const words = (s: string) =>
	s
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

// Letters added, dropped, changed or two swapped to turn a into b; anything above max counts as max + 1.
function edits(a: string, b: string, max: number) {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const at = (row: number[], j: number) => row[j] ?? max + 1;
	let before: number[] = [];
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			let d = Math.min(at(prev, j) + 1, at(row, j - 1) + 1, at(prev, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, at(before, j - 2) + 1);
			row.push(d);
		}
		if (Math.min(...row) > max) return max + 1;
		before = prev;
		prev = row;
	}
	return at(prev, b.length);
}

/** How well a typed word fits a word of the mail: 4 the same, 3 how it starts or the same word with an ending
 * ("rechnungen" for "Rechnung"), 2 inside it ("rechnung" in "stromrechnung"), 1 a typo away (two in long words, also
 * while the word is still being typed), 0 not at all. */
export function likeness(typed: string, word: string) {
	if (word === typed) return 4;
	if (word.startsWith(typed)) return 3;
	if (word.length >= 5 && typed.length > word.length && typed.length - word.length <= 3 && typed.startsWith(word))
		return 3;
	if (typed.length >= 3 && word.includes(typed)) return 2;
	if (typed.length < 4) return 0;
	const max = typed.length < 8 ? 1 : 2;
	return edits(typed, word, max) <= max || edits(typed, word.slice(0, typed.length), max) <= max ? 1 : 0;
}

// Within a tier a word in the sender counts most, then the subject, then the preview.
const weight = [3, 2, 1] as const;

// The word itself beats a word it's only part of, and that beats a typo, wherever in the mail each one is: a Kündigung
// in the preview comes before a Paketankündigung in the subject.
const tier = [0, 0, 1, 2, 2] as const;

// Each message's words per field, split again only when its text changes, so syncing while searching stays cheap.
let split = new Map<string, { key: string; fields: string[][] }>();

/** Every word of the mail and where it appears, built when a search starts and again when mail changes. */
export function index(all: Message[]) {
	// A word's places are message * 3 + field.
	const places = new Map<string, number[]>();
	const next: typeof split = new Map();
	for (const [d, m] of all.entries()) {
		const key = `${m.fromName}\n${m.fromAddr}\n${m.subject}\n${m.snippet}`;
		let had = split.get(m.id);
		if (had?.key !== key)
			had = { key, fields: [`${m.fromName} ${m.fromAddr}`, m.subject, m.snippet].map((t) => [...new Set(words(t))]) };
		next.set(m.id, had);
		for (const [f, list] of had.fields.entries()) {
			for (const w of list) {
				const list = places.get(w);
				if (list) list.push(d * 3 + f);
				else places.set(w, [d * 3 + f]);
			}
		}
	}
	split = next;
	return { all, places };
}

/** The messages in view that have every typed word and pass every filter, best fit first, then newest. */
export function find({ all, places }: ReturnType<typeof index>, q: SearchQuery, inView: Set<string>) {
	const typed = words(q.text);
	// Each word of the mail is compared with what was typed once; only the messages it's in are visited.
	let score: Int32Array | undefined;
	for (const t of typed) {
		const best = new Int32Array(all.length);
		for (const [w, list] of places) {
			const s = likeness(t, w);
			if (!s) continue;
			for (const p of list) {
				const d = (p / 3) | 0;
				best[d] = Math.max(best[d] ?? 0, (tier[s] ?? 0) * 1000 + s * (weight[p % 3] ?? 1));
			}
		}
		// Every typed word has to be there.
		if (score) for (const [d, b] of best.entries()) score[d] = b && (score[d] ?? 0) && (score[d] ?? 0) + b;
		else score = best;
	}
	const found: { m: Message; score: number }[] = [];
	for (const [d, m] of all.entries()) {
		if ((!score || score[d]) && inView.has(m.mailboxId) && passes(m, q.filters))
			found.push({ m, score: score?.[d] ?? 0 });
	}
	return found.sort((a, b) => b.score - a.score || b.m.sentAt.localeCompare(a.m.sentAt)).map((f) => f.m);
}

// Whether a message passes the filter chips. Dates are YYYY-MM-DD in local time.
export function passes(m: Message, filters: SearchFilter[]) {
	const day = new Date(m.sentAt).toLocaleDateString("sv");
	return filters.every(({ key, value }) => {
		if (key === "from") return m.fromAddr.toLowerCase().includes(value.toLowerCase());
		if (key === "to") return [...m.to, ...m.cc].some((a) => a.toLowerCase().includes(value.toLowerCase()));
		if (key === "after") return day >= value;
		if (key === "before") return day < value;
		if (key === "is" && value === "unread") return !m.flags.includes("\\Seen");
		if (key === "is" && value === "starred") return m.flags.includes("\\Flagged");
		if (key === "has" && value === "attachment") return m.attachments.length > 0;
		// Which accounts are searched, not something about the message.
		if (key === "in") return true;
		return false;
	});
}
