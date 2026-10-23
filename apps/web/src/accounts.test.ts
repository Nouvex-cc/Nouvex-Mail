// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { type Group, lastUsed, resting, wakes } from "./accounts";

const work: Group = {
	id: "w",
	name: "Work",
	accountIds: [],
	muted: false,
	focus: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
};
// 2026-10-23 is a Friday.
const at = (day: number, time: string) => new Date(`2026-10-${day}T${time}:00`);

test("a group rests outside its focus times", () => {
	expect(resting(work, at(23, "08:59"))).toBe(true);
	expect(resting(work, at(23, "09:00"))).toBe(false);
	expect(resting(work, at(23, "18:00"))).toBe(true);
	expect(resting(work, at(24, "12:00"))).toBe(true);
	expect(resting({ ...work, focus: null }, at(24, "12:00"))).toBe(false);
	expect(work.focus && wakes(work.focus, at(23, "19:00"))).toEqual(at(26, "09:00"));
});

test("focus times can run past midnight", () => {
	const night = { ...work, focus: { days: [5], from: "22:00", to: "02:00" } };
	expect(resting(night, at(23, "23:00"))).toBe(false);
	expect(resting(night, at(24, "01:59"))).toBe(false);
	expect(resting(night, at(24, "02:00"))).toBe(true);
	expect(resting(night, at(24, "23:00"))).toBe(true);
});

test("new mail goes out from the account last used with that person", () => {
	const sent = [
		{ accountId: "home", to: ["Lena@example.com"] },
		{ accountId: "work", to: ["lena@example.com", "jonas@example.com"] },
	];
	expect(lastUsed(sent, "lena@example.com")).toBe("home");
	expect(lastUsed(sent, "jonas@example.com")).toBe("work");
	expect(lastUsed(sent, "mira@example.com")).toBeUndefined();
});
