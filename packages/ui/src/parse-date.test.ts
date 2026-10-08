// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { parseDate } from "./parse-date";

// Thursday, 8 October 2026. Runs with an en-US locale, so plain numbers read month first.
const now = new Date(2026, 9, 8);
const ymd = (text: string) => {
	const d = parseDate(text, now);
	return d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

test("numbers in any common order and separator", () => {
	expect(ymd("10/15/2026")).toBe("2026-10-15");
	expect(ymd("15.10.2026")).toBe("2026-10-15");
	expect(ymd("15-10-26")).toBe("2026-10-15");
	expect(ymd("2026-10-15")).toBe("2026-10-15");
	expect(ymd("2026/10/15")).toBe("2026-10-15");
	expect(ymd("10 15 2026")).toBe("2026-10-15");
	expect(ymd("10/15")).toBe("2026-10-15");
});

test("digits only", () => {
	expect(ymd("10152026")).toBe("2026-10-15");
	expect(ymd("101526")).toBe("2026-10-15");
	expect(ymd("20261015")).toBe("2026-10-15");
	expect(ymd("1015")).toBe("2026-10-15");
});

test("month names in English and German", () => {
	expect(ymd("Oct 15 2026")).toBe("2026-10-15");
	expect(ymd("October 15, 2026")).toBe("2026-10-15");
	expect(ymd("15th October")).toBe("2026-10-15");
	expect(ymd("15. Oktober 2026")).toBe("2026-10-15");
	expect(ymd("3 März")).toBe("2026-3-3");
	expect(ymd("sept 1 27")).toBe("2027-9-1");
});

test("relative words and weekdays", () => {
	expect(ymd("today")).toBe("2026-10-8");
	expect(ymd("morgen")).toBe("2026-10-9");
	expect(ymd("übermorgen")).toBe("2026-10-10");
	expect(ymd("in 3 days")).toBe("2026-10-11");
	expect(ymd("in 2 Wochen")).toBe("2026-10-22");
	expect(ymd("+5")).toBe("2026-10-13");
	expect(ymd("friday")).toBe("2026-10-9");
	expect(ymd("Donnerstag")).toBe("2026-10-15");
	expect(ymd("next mon")).toBe("2026-10-12");
});

test("rejects what isn't a date", () => {
	expect(ymd("2/31/2026")).toBeNull();
	expect(ymd("13/13/2026")).toBeNull();
	expect(ymd("hello")).toBeNull();
	expect(ymd("15")).toBeNull();
	expect(ymd("")).toBeNull();
});
