// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxSynced, MessageSent } from "@nouvex/schema";
import { db, local, type Mailbox, type Message } from "./db";

type Changes = {
	version: number;
	more: boolean;
	mailboxes: { upserted: Omit<Mailbox, "accountId">[]; deleted: string[] };
	messages: { upserted: Omit<Message, "accountId" | "seen" | "starred">[]; deleted: string[] };
};

// Pulls everything after the stored cursor, page by page. Concurrent calls for the same account share one run.
const running = new Map<string, Promise<void>>();
export function pull(accountId: string) {
	let run = running.get(accountId);
	if (!run) {
		run = (async () => {
			for (;;) {
				const since = (await db.cursor.get(accountId))?.version ?? 0;
				const res = await fetch(`/accounts/${accountId}/changes?since=${since}`);
				if (!res.ok) throw new Error(`changes: ${res.status}`);
				const { version, more, mailboxes, messages }: Changes = await res.json();
				await db.transaction("rw", db.messages, db.mailboxes, db.cursor, async () => {
					await db.mailboxes.bulkPut(mailboxes.upserted.map((b) => ({ ...b, accountId })));
					await db.mailboxes.bulkDelete(mailboxes.deleted);
					await db.messages.bulkPut(messages.upserted.map((m) => ({ ...m, accountId, ...local(m.flags) })));
					await db.messages.bulkDelete(messages.deleted);
					await db.cursor.put({ accountId, version });
				});
				if (!more) return;
			}
		})().finally(() => running.delete(accountId));
		running.set(accountId, run);
	}
	return run;
}

type Event =
	| { subject: "evt.mailbox.synced"; data: MailboxSynced }
	| { subject: "evt.message.sent"; data: MessageSent };

// The engine announces saved syncs, failed syncs and sends over the socket; only events for our accounts count.
export function listen(accountIds: string[], onSent: (e: MessageSent) => void, onSynced: (e: MailboxSynced) => void) {
	const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
	ws.onmessage = (e) => {
		const ev = JSON.parse(e.data) as Event;
		if (!accountIds.includes(ev.data.accountId)) return;
		if (ev.subject === "evt.mailbox.synced") {
			if (!ev.data.error) void pull(ev.data.accountId);
			onSynced(ev.data);
		}
		if (ev.subject === "evt.message.sent") onSent(ev.data);
	};
	return () => ws.close();
}

// Applies the change locally right away; the server's version arrives through pull. A failed request puts the
// message back as it was. Moved messages come back with a new id in their new folder.
export async function update(
	m: Message,
	change: { seen?: boolean; flagged?: boolean; trash?: boolean; archive?: boolean; snoozeUntil?: string },
) {
	if (change.trash || change.archive || change.snoozeUntil) await db.messages.delete(m.id);
	else {
		let flags = m.flags;
		for (const [flag, on] of [
			["\\Seen", change.seen],
			["\\Flagged", change.flagged],
		] as const) {
			if (on !== undefined) flags = on ? [...flags.filter((f) => f !== flag), flag] : flags.filter((f) => f !== flag);
		}
		await db.messages.update(m.id, local(flags));
	}
	const res = await fetch(`/accounts/${m.accountId}/messages/${m.id}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(change),
	});
	if (!res.ok) await db.messages.put(m);
}

// Forgets everything synced from an account, after it was removed.
export const forget = (accountId: string) =>
	db.transaction("rw", db.messages, db.mailboxes, db.cursor, async () => {
		const boxes = await db.mailboxes.where("accountId").equals(accountId).primaryKeys();
		await db.messages.where("mailboxId").anyOf(boxes).delete();
		await db.mailboxes.bulkDelete(boxes);
		await db.cursor.delete(accountId);
	});
