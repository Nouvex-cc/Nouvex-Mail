// SPDX-License-Identifier: AGPL-3.0-only
import { Dexie, type EntityTable } from "dexie";

// A message as GET /accounts/{id}/changes delivers it.
export interface Message {
	id: string;
	accountId: string;
	mailboxId: string;
	messageId: string;
	// The conversation; replies and the messages they answer share it, across folders.
	threadId: string;
	subject: string;
	snippet: string;
	fromName: string;
	fromAddr: string;
	sentAt: string;
	flags: string[];
	size: number;
	attachments: { name: string; type: string; size: number }[];
	// 1 when flags has \Seen. Only here so unread mail can be found through an index; IndexedDB can't index booleans.
	seen: 0 | 1;
	// 1 when flags has \Flagged, for the Starred view.
	starred: 0 | 1;
}

export const seen = (flags: string[]): 0 | 1 => (flags.includes("\\Seen") ? 1 : 0);
export const starred = (flags: string[]): 0 | 1 => (flags.includes("\\Flagged") ? 1 : 0);
/** What the app derives from flags, for storing a message as the server describes it. */
export const local = (flags: string[]) => ({ flags, seen: seen(flags), starred: starred(flags) });

export interface Mailbox {
	id: string;
	accountId: string;
	name: string;
	role: "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "";
}

// Local copy of what the delta sync has delivered so far; `cursor` stores the last change_log version per account.
export const db = new Dexie("nouvex") as Dexie & {
	messages: EntityTable<Message, "id">;
	mailboxes: EntityTable<Mailbox, "id">;
	cursor: EntityTable<{ accountId: string; version: number }, "accountId">;
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
