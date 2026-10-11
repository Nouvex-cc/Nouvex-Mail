// SPDX-License-Identifier: AGPL-3.0-only
import { Dexie, type EntityTable } from "dexie";

// A message as GET /accounts/{id}/changes delivers it.
export interface Message {
	id: string;
	accountId: string;
	mailboxId: string;
	messageId: string;
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
}

export const seen = (flags: string[]) => (flags.includes("\\Seen") ? 1 : 0);

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
