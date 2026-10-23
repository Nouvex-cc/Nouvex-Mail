// SPDX-License-Identifier: AGPL-3.0-only
import type { Keys } from "@nouvex/sdk/crypto";
import { Dexie, type EntityTable } from "dexie";

// A message as GET /accounts/{id}/changes delivers it, with what was sealed in it opened (sync.ts).
export interface Message {
	id: string;
	/** The message's own key, sealed to the user: it opens the body and the attachments too (keys.ts). */
	key: string;
	accountId: string;
	mailboxId: string;
	messageId: string;
	// The conversation; replies and the messages they answer share it, across folders.
	threadId: string;
	subject: string;
	snippet: string;
	fromName: string;
	fromAddr: string;
	to: string[];
	cc: string[];
	sentAt: string;
	flags: string[];
	size: number;
	attachments: { name: string; type: string; size: number }[];
	/** The inbox tab, sorted by the engine. */
	category: Category;
	/** A sign-in code or a meeting the engine found in it. */
	actions: Action[];
	/** A rich mail with a designed version (docs/rich-mail.md). */
	rich?: boolean;
	/** Put into the inbox by Nouvex itself, so its nx-actions may open places in the app. */
	seeded?: boolean;
	// 1 when actions isn't empty, so the sidebar finds them through an index.
	acts?: 0 | 1;
	// 1 when flags has \Seen. Only here so unread mail can be found through an index; IndexedDB can't index booleans.
	seen: 0 | 1;
	// 1 when flags has \Flagged, for the Starred view.
	starred: 0 | 1;
}

export type Category = "primary" | "promotions" | "social" | "updates" | "newsletters";

export type Action = {
	kind: "code" | "meeting";
	code?: string;
	title?: string;
	start?: string;
	end?: string;
	url?: string;
	provider?: string;
	/** Updates and cancellations of one meeting share it. */
	event?: string;
	cancelled?: boolean;
};

export const seen = (flags: string[]): 0 | 1 => (flags.includes("\\Seen") ? 1 : 0);
export const starred = (flags: string[]): 0 | 1 => (flags.includes("\\Flagged") ? 1 : 0);
/** What the app derives from flags, for storing a message as the server describes it. */
export const local = (flags: string[]) => ({ flags, seen: seen(flags), starred: starred(flags) });

// The same mail can sit in several places, e.g. your copy in Sent and the one another of your accounts received. It
// counts once, as the copy prefer picks where there is one.
export const once = (thread: Message[], prefer: (m: Message) => boolean = () => false) => {
	const kept = new Map<string, Message>();
	for (const m of thread) {
		const id = m.messageId || m.id;
		const had = kept.get(id);
		if (!had || (prefer(m) && !prefer(had))) kept.set(id, m);
	}
	return [...kept.values()];
};

export interface Mailbox {
	id: string;
	accountId: string;
	name: string;
	role: "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "snoozed" | "";
}

/** The private key sealed with a key of this device's that the page can use but not read back (keys.ts). */
export type Device = { publicKey: Uint8Array<ArrayBuffer>; deviceKey: CryptoKey; sealed: Uint8Array<ArrayBuffer> };

// Local copy of what the delta sync has delivered so far; `cursor` stores the last change_log version per account.
export const db = new Dexie("nouvex") as Dexie & {
	messages: EntityTable<Message, "id">;
	mailboxes: EntityTable<Mailbox, "id">;
	cursor: EntityTable<{ accountId: string; version: number }, "accountId">;
	/** This device's copy of the user's keys, unlocked with the password (keys.ts). */
	keys: EntityTable<(Keys | Device) & { id: "me" }, "id">;
};

db.version(1).stores({
	messages: "id, [accountId+sentAt], sentAt",
	cursor: "accountId",
});
// Folders and attachments came later; start over so they arrive with the next pull.
db.version(3)
	.stores({ messages: "id, mailboxId, sentAt", mailboxes: "id, accountId" })
	.upgrade((tx) =>
		Promise.all([tx.table("messages").clear(), tx.table("mailboxes").clear(), tx.table("cursor").clear()]),
	);
// Indexes that let a folder be read newest first, a page at a time, and its unread mail be counted.
db.version(4)
	.stores({ messages: "id, mailboxId, sentAt, [mailboxId+sentAt], [mailboxId+seen]" })
	.upgrade((tx) =>
		tx
			.table("messages")
			.toCollection()
			.modify((m: Message) => {
				m.seen = seen(m.flags);
			}),
	);
// Conversations; the threadId of stored messages arrives with the next pull.
db.version(5).stores({ messages: "id, mailboxId, sentAt, threadId, [mailboxId+sentAt], [mailboxId+seen]" });
// Starred messages, newest first.
db.version(6)
	.stores({ messages: "id, mailboxId, sentAt, threadId, [mailboxId+sentAt], [mailboxId+seen], [starred+sentAt]" })
	.upgrade((tx) =>
		tx
			.table("messages")
			.toCollection()
			.modify((m: Message) => {
				m.starred = starred(m.flags);
			}),
	);
// Messages with a code or a meeting; theirs arrive with the next pull.
db.version(7).stores({
	messages: "id, mailboxId, sentAt, threadId, acts, [mailboxId+sentAt], [mailboxId+seen], [starred+sentAt]",
});
// Inbox tabs, newest first and with their unread mail. Stored messages start in Primary; those the engine sorts elsewhere arrive with the next
// pull.
db.version(8)
	.stores({
		messages:
			"id, mailboxId, sentAt, threadId, acts, [mailboxId+sentAt], [mailboxId+category+sentAt], [mailboxId+category+seen], [mailboxId+seen], [starred+sentAt]",
	})
	.upgrade((tx) =>
		tx
			.table("messages")
			.toCollection()
			.modify((m: Message) => {
				m.category ??= "primary";
			}),
	);
// The user's keys, once this device is unlocked. Mail comes sealed for the user now; what was stored before is fetched
// again.
db.version(9)
	.stores({ keys: "id" })
	.upgrade((tx) =>
		Promise.all([tx.table("messages").clear(), tx.table("mailboxes").clear(), tx.table("cursor").clear()]),
	);
