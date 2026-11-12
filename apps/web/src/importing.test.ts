// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { folders, suggest } from "./importing";

test("special folders keep their role, own folders go flat, the rest stays behind", () => {
	const plans = suggest([
		{ name: "INBOX", role: "inbox", count: 12 },
		{ name: "INBOX.Work", role: "", count: 3 },
		{ name: "Projects/2026/Clients", role: "", count: 5 },
		{ name: "Old", role: "", count: 0 },
		{ name: "Sent", role: "sent", count: 4 },
		{ name: "Trash", role: "trash", count: 9 },
		{ name: "[Gmail]/Important", role: "", count: 7 },
	]);
	expect(plans.map((p) => [p.from, p.to, p.name])).toEqual([
		["INBOX", "inbox", "INBOX"],
		["Sent", "sent", "Sent"],
		["Projects/2026/Clients", "folder", "Clients"],
		["INBOX.Work", "folder", "Work"],
		["[Gmail]/Important", "skip", "Important"],
		["Old", "skip", "Old"],
		["Trash", "skip", "Trash"],
	]);
	expect(folders(plans)).toEqual([
		{ from: "INBOX", role: "inbox", name: "" },
		{ from: "Sent", role: "sent", name: "" },
		{ from: "Projects/2026/Clients", role: "", name: "Clients" },
		{ from: "INBOX.Work", role: "", name: "Work" },
	]);
});
