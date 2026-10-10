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
}

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
// Folders came later; start over so they arrive with the next pull.
db.version(2)
	.stores({ messages: "id, mailboxId, sentAt", mailboxes: "id, accountId" })
	.upgrade((tx) => Promise.all([tx.table("messages").clear(), tx.table("cursor").clear()]));
// Same for attachments.
db.version(3).upgrade((tx) =>
	Promise.all([tx.table("messages").clear(), tx.table("mailboxes").clear(), tx.table("cursor").clear()]),
);
