// SPDX-License-Identifier: AGPL-3.0-only
import { Dexie, type EntityTable } from "dexie";

export interface Message {
	id: string;
	accountId: string;
	subject: string;
	receivedAt: number;
}

// Local copy of what the delta sync has delivered so far; `cursor` stores the last change_log version per account.
export const db = new Dexie("nouvex") as Dexie & {
	messages: EntityTable<Message, "id">;
	cursor: EntityTable<{ accountId: string; version: number }, "accountId">;
};

db.version(1).stores({
	messages: "id, accountId, receivedAt",
	cursor: "accountId",
});
