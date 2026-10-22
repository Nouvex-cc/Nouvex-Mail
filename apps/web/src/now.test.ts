// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import type { Action, Message } from "./db";
import { due } from "./now";

const at = (iso: string) => Date.parse(iso);
const mail = (id: string, sentAt: string, ...actions: Action[]): Message => ({
	id,
	accountId: "a",
	key: "",
	mailboxId: "b",
	messageId: id,
	threadId: id,
	subject: "s",
	snippet: "",
	fromName: "GitHub",
	fromAddr: "noreply@github.example",
	to: [],
	cc: [],
	sentAt,
	flags: [],
	size: 1,
	attachments: [],
	category: "updates",
	actions,
	seen: 0,
	starred: 0,
});
const shown = (messages: Message[], now: string) => due(messages, at(now), 15, 5).map((d) => d.message.id);

test("codes stay for their life after they arrive", () => {
	const code = mail("c", "2026-10-14T12:00:00Z", { kind: "code", code: "483920" });
	expect(shown([code], "2026-10-14T12:04:59Z")).toEqual(["c"]);
	expect(shown([code], "2026-10-14T12:05:00Z")).toEqual([]);
});

test("meetings show from the lead before they start until they end", () => {
	const meeting = { kind: "meeting", event: "e", start: "2026-10-14T15:00:00Z", end: "2026-10-14T15:30:00Z" } as const;
	const invite = mail("m", "2026-10-01T09:00:00Z", meeting);
	expect(shown([invite], "2026-10-14T14:44:59Z")).toEqual([]);
	expect(shown([invite], "2026-10-14T14:45:00Z")).toEqual(["m"]);
	expect(shown([invite], "2026-10-14T15:29:00Z")).toEqual(["m"]);
	expect(shown([invite], "2026-10-14T15:30:00Z")).toEqual([]);
	// The newest invitation wins: moved to later, then cancelled.
	const moved = mail("m2", "2026-10-02T09:00:00Z", { ...meeting, start: "2026-10-14T16:00:00Z", end: undefined });
	expect(shown([invite, moved], "2026-10-14T14:50:00Z")).toEqual([]);
	expect(shown([invite, moved], "2026-10-14T15:50:00Z")).toEqual(["m2"]);
	const cancel = mail("m3", "2026-10-03T09:00:00Z", { ...meeting, cancelled: true });
	expect(shown([invite, moved, cancel], "2026-10-14T14:50:00Z")).toEqual([]);
});

test("at most three, the most urgent last", () => {
	const meeting = mail("m", "2026-10-01T09:00:00Z", { kind: "meeting", start: "2026-10-14T12:10:00Z" });
	const codes = ["1", "2", "3"].map((n) => mail(n, `2026-10-14T12:0${n}:00Z`, { kind: "code", code: n }));
	expect(shown([meeting, ...codes], "2026-10-14T12:04:00Z")).toEqual(["1", "2", "3"]);
	expect(shown([meeting, codes[0] as Message], "2026-10-14T12:04:00Z")).toEqual(["m", "1"]);
});
