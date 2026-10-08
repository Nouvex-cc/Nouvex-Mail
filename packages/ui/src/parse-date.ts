// SPDX-License-Identifier: Apache-2.0

// Turns whatever someone types into a date: numbers in any common order and separator, digits only, month names
// (the user's language, English, German), relative words and weekdays. Returns null when it isn't a date.

type Part = "day" | "month" | "year";

const clean = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();

const locales = () => [...new Set([typeof navigator === "undefined" ? "en" : navigator.language, "en", "de"])];

// Every spelling of each month / weekday we know, long and short, without dots or accents.
function names(kind: "month" | "weekday") {
	const map = new Map<string, number>();
	for (const locale of locales())
		for (const style of ["long", "short"] as const) {
			const format = new Intl.DateTimeFormat(locale, kind === "month" ? { month: style } : { weekday: style });
			const count = kind === "month" ? 12 : 7;
			for (let i = 0; i < count; i++) {
				// 2023-01-01 was a Sunday, so day i + 1 of January is weekday i.
				const date = kind === "month" ? new Date(2023, i, 1) : new Date(2023, 0, 1 + i);
				map.set(clean(format.format(date)).replace(/\./g, ""), i);
			}
		}
	return map;
}

// Matches full names and any prefix of at least three letters ("sept", "okt", "frei").
function lookup(token: string, map: Map<string, number>) {
	if (token.length < 3) return undefined;
	for (const [name, i] of map) if (name === token || name.startsWith(token)) return i;
	return undefined;
}

function localeOrder(): Part[] {
	return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
		.formatToParts(new Date(2000, 10, 22))
		.map((p) => p.type)
		.filter((t): t is Part => t === "day" || t === "month" || t === "year");
}

const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

function make(year: number, month: number, day: number) {
	const date = new Date(year, month, day);
	return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
}

const addDays = (from: Date, days: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);

// Day and month from two numbers in the locale's order; if that order can't be right (a "month" above 12), swap.
function dayMonth(a: number, b: number) {
	const dayFirst = localeOrder().indexOf("day") < localeOrder().indexOf("month");
	let [day, month] = dayFirst ? [a, b] : [b, a];
	if (month > 12 && day <= 12) [day, month] = [month, day];
	return { day, month: month - 1 };
}

const relative: Record<string, number> = {
	today: 0,
	heute: 0,
	tomorrow: 1,
	morgen: 1,
	yesterday: -1,
	gestern: -1,
	"day after tomorrow": 2,
	ubermorgen: 2,
};

export function parseDate(input: string, now = new Date()): Date | null {
	const text = clean(input).replace(/\s+/g, " ");
	if (!text) return null;
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

	if (text in relative) return addDays(today, relative[text] ?? 0);

	// "+3", "in 3 days", "in 2 Wochen", "3 months"
	const offset = text.match(/^(?:\+|in )?(\d+) ?(d|days?|tage?n?|w|weeks?|wochen?|m|months?|monate?n?)?$/);
	if (offset && (text.startsWith("+") || text.startsWith("in ") || offset[2])) {
		const n = Number(offset[1]);
		const unit = offset[2] ?? "d";
		if (unit.startsWith("w")) return addDays(today, n * 7);
		if (unit.startsWith("m")) return make(today.getFullYear(), today.getMonth() + n, today.getDate()) ?? null;
		return addDays(today, n);
	}

	// Weekday: the next one, never today ("friday" on a Friday means next week).
	const weekday = lookup(text.replace(/^(next|nachsten?) /, ""), names("weekday"));
	if (weekday !== undefined && !/\d/.test(text)) return addDays(today, ((weekday - today.getDay() + 6) % 7) + 1);

	const tokens = text.split(/[\s.,/-]+/).filter(Boolean);
	const numbers = tokens.map((t) => t.replace(/(st|nd|rd|th)$/, "")).filter((t) => /^\d+$/.test(t));
	const words = tokens.filter((t) => !/^\d+(st|nd|rd|th)?$/.test(t));

	// A month name somewhere: the remaining numbers are day and year.
	if (words.length) {
		const month = words.length === 1 ? lookup(words[0] ?? "", names("month")) : undefined;
		if (month === undefined || numbers.length < 1 || numbers.length > 2) return null;
		const nums = numbers.map(Number);
		const yearAt = nums.findIndex((n, i) => (numbers[i] ?? "").length === 4 || n > 31);
		const year = yearAt >= 0 ? (nums[yearAt] ?? 0) : nums.length === 2 ? fullYear(nums[1] ?? 0) : today.getFullYear();
		const day = nums.find((_, i) => i !== (yearAt >= 0 ? yearAt : nums.length === 2 ? 1 : -1)) ?? 0;
		return make(year, month, day);
	}

	// Digits only: 15102026, 151026, 20261015, 1510 (no year).
	if (numbers.length === 1) {
		const d = numbers[0] ?? "";
		if (d.length === 8 && /^(19|20)/.test(d)) {
			const iso = make(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6)));
			if (iso) return iso;
		}
		if (d.length === 8 || d.length === 6 || d.length === 4) {
			const { day, month } = dayMonth(Number(d.slice(0, 2)), Number(d.slice(2, 4)));
			const year = d.length === 4 ? today.getFullYear() : fullYear(Number(d.slice(4)));
			return make(year, month, day);
		}
		return null;
	}

	const nums = numbers.map(Number);
	if (numbers.length === 2) {
		const { day, month } = dayMonth(nums[0] ?? 0, nums[1] ?? 0);
		return make(today.getFullYear(), month, day);
	}
	if (numbers.length === 3) {
		const [a = 0, b = 0, c = 0] = nums;
		// Year first when the first number has four digits (2026-10-15).
		if ((numbers[0] ?? "").length === 4) return make(a, b - 1, c);
		const { day, month } = dayMonth(a, b);
		return make(fullYear(c), month, day);
	}
	return null;
}
