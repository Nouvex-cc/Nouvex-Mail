// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { formatMailDate } from "./mail-date";

const now = new Date(2026, 9, 8, 15, 0); // Thursday

test("time today, weekday this week, date before that", () => {
	expect(formatMailDate(new Date(2026, 9, 8, 9, 42), now)).toMatch(/9:42/);
	expect(formatMailDate(new Date(2026, 9, 6, 18, 0), now)).toBe("Tue");
	expect(formatMailDate(new Date(2026, 8, 20), now)).toBe("Sep 20");
	expect(formatMailDate(new Date(2025, 11, 24), now)).toBe("Dec 24, 2025");
});
