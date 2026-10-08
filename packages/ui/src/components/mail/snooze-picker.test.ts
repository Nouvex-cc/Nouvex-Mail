// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { parseSnooze } from "./snooze-picker";

// Thursday, 8 October 2026, 15:00. Runs with an en-US locale.
const now = new Date(2026, 9, 8, 15, 0);
const at = (text: string) => {
	const d = parseSnooze(text, now);
	return d && `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

test("date with a time", () => {
	expect(at("tomorrow 3pm")).toBe("10/9 15:00");
	expect(at("fri 15:00")).toBe("10/9 15:00");
	expect(at("10/15 at 9")).toBe("10/15 9:00");
	expect(at("monday 9:30am")).toBe("10/12 9:30");
});

test("a time alone means today, a date alone means 8:00", () => {
	expect(at("18:30")).toBe("10/8 18:30");
	expect(at("tomorrow")).toBe("10/9 8:00");
});

test("rejects nonsense", () => {
	expect(at("13pm")).toBeNull();
	expect(at("soon")).toBeNull();
});
