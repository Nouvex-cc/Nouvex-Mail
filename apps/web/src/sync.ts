// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxSynced, MailboxSyncing, MessageSent } from "@nouvex/schema";
import { decrypt } from "@nouvex/sdk/crypto";
import { type Category, db, local, type Mailbox, type Message } from "./db";
import { messageKey, reload } from "./keys";

type Meta = Pick<
	Message,
	| "messageId"
	| "subject"
	| "snippet"
	| "fromName"
	| "fromAddr"
	| "to"
	| "cc"
	| "attachments"
	| "actions"
	| "rich"
	| "seeded"
	| "unsubscribe"
>;
type Sealed = Omit<Message, "accountId" | "seen" | "starred" | "spam" | keyof Meta> & { sealed: string; spam: boolean };

type Changes = {
	version: number;
	more: boolean;
	mailboxes: { upserted: Omit<Mailbox, "accountId">[]; deleted: string[] };
	messages: { upserted: Sealed[]; deleted: string[] };
};

// The server keeps what only this user can read sealed; opened here, it's stored on this device like any message.
async function open({ sealed, ...m }: Sealed) {
	const meta = await decrypt(await messageKey(m), "meta", Uint8Array.fromBase64(sealed));
	return { ...m, ...(JSON.parse(new TextDecoder().decode(meta)) as Meta) };
}

// When each message this device hadn't seen yet came in, so the list can mark it.
export const arrived = new Map<string, number>();

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
				// Before the transaction: IndexedDB ends one that waits for anything else. If one doesn't open, the cursor
				// stays, or the message would be lost here for good. Most likely this tab holds the key from before a reset.
				const upserted = await Promise.all(messages.upserted.map(open)).catch((e) => {
					reload();
					throw e;
				});
				await db.transaction("rw", db.messages, db.mailboxes, db.cursor, async () => {
					const known = await db.messages.bulkGet(upserted.map((m) => m.id));
					for (const [i, m] of upserted.entries()) if (!known[i]) arrived.set(m.id, Date.now());
					await db.mailboxes.bulkPut(mailboxes.upserted.map((b) => ({ ...b, accountId })));
					await db.mailboxes.bulkDelete(mailboxes.deleted);
					await db.messages.bulkPut(
						upserted.map((m) => ({
							...m,
							accountId,
							...local(m.flags),
							acts: m.actions.length ? 1 : 0,
							spam: m.spam ? 1 : 0,
						})),
					);
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
	| { subject: "evt.mailbox.syncing"; data: MailboxSyncing }
	| { subject: "evt.mailbox.synced"; data: MailboxSynced }
	| { subject: "evt.message.sent"; data: MessageSent };

// The engine announces running, saved and failed syncs and sends over the socket; only events for our accounts count.
export function listen(
	accountIds: string[],
	onSent: (e: MessageSent) => void,
	onSynced: (e: MailboxSynced) => void,
	onSyncing: (accountId: string, running: boolean) => void,
) {
	const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
	ws.onmessage = (e) => {
		const ev = JSON.parse(e.data) as Event;
		if (!accountIds.includes(ev.data.accountId)) return;
		if (ev.subject === "evt.mailbox.syncing") {
			if (ev.data.version !== undefined) void pull(ev.data.accountId);
			onSyncing(ev.data.accountId, true);
		}
		if (ev.subject === "evt.mailbox.synced") {
			if (!ev.data.error) void pull(ev.data.accountId);
			onSyncing(ev.data.accountId, false);
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
	change: {
		seen?: boolean;
		flagged?: boolean;
		trash?: boolean;
		archive?: boolean;
		snoozeUntil?: string;
		category?: Category;
		spam?: boolean;
	},
) {
	if (change.trash || change.archive || change.snoozeUntil) await db.messages.delete(m.id);
	else if (change.category || change.spam !== undefined)
		await db.messages.update(m.id, {
			...(change.category && { category: change.category }),
			...(change.spam !== undefined && { spam: change.spam ? 1 : 0 }),
		});
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

// How the server knows a sender without being told the address: SHA-256 of it, lowercased (engine/internal/mail/sort.go).
const hashed = async (s: string) =>
	new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.toLowerCase()))).toHex();

/**
 * Puts a sender's mail somewhere for good: a tab, or spam or not. What of it is here moves right away, the server's
 * copy follows. Returns how to take it back.
 */
export async function sortSender(addr: string, change: { category?: Category; spam?: boolean }) {
	const theirs = await db.messages.filter((m) => m.fromAddr.toLowerCase() === addr.toLowerCase()).toArray();
	const sender = await hashed(addr);
	await db.messages.bulkUpdate(
		theirs.map((m) => ({
			key: m.id,
			changes: {
				...(change.category && { category: change.category }),
				...(change.spam !== undefined && { spam: change.spam ? 1 : 0 }),
			},
		})),
	);
	const rule = (category: Category | null, spam: boolean | null, messages: Message[]) =>
		fetch("/rules", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sender,
				category,
				spam,
				messages: messages.map((m) => ({ accountId: m.accountId, id: m.id })),
			}),
		});
	await rule(change.category ?? null, change.spam ?? null, theirs);
	return async () => {
		await rule(null, null, []);
		for (const m of theirs)
			void update(m, {
				...(change.category && { category: m.category }),
				...(change.spam !== undefined && { spam: m.spam === 1 }),
			});
	};
}

/** Leaves the list a message came from: with one click through the server, by mail, or on the sender's page. */
export async function unsubscribe(m: Message) {
	const { url, mailto, oneClick } = m.unsubscribe ?? {};
	if (url && oneClick) {
		return (
			await fetch("/unsubscribe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url }),
			})
		).ok;
	}
	if (mailto) {
		const to = new URL(mailto);
		return (
			await fetch(`/accounts/${m.accountId}/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: [decodeURIComponent(to.pathname)],
					subject: to.searchParams.get("subject") ?? "unsubscribe",
					text: to.searchParams.get("body") ?? "unsubscribe",
				}),
			})
		).ok;
	}
	if (url) window.open(url, "_blank", "noopener");
	return !!url;
}

// Removes an account, then everything synced from it.
export async function forget(accountId: string) {
	await fetch(`/accounts/${accountId}`, { method: "DELETE" });
	await db.transaction("rw", db.messages, db.mailboxes, db.cursor, async () => {
		const boxes = await db.mailboxes.where("accountId").equals(accountId).primaryKeys();
		await db.messages.where("mailboxId").anyOf(boxes).delete();
		await db.mailboxes.bulkDelete(boxes);
		await db.cursor.delete(accountId);
	});
}
