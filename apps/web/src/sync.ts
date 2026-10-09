// SPDX-License-Identifier: AGPL-3.0-only
import { db, type Message } from "./db";

type Changes = {
	version: number;
	more: boolean;
	messages: { upserted: Omit<Message, "accountId">[]; deleted: string[] };
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
				const { version, more, messages }: Changes = await res.json();
				await db.transaction("rw", db.messages, db.cursor, async () => {
					await db.messages.bulkPut(messages.upserted.map((m) => ({ ...m, accountId })));
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

// The engine announces finished syncs over the socket; pull for the accounts we know.
export function listen(accountIds: string[]) {
	const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
	ws.onmessage = (e) => {
		const { accountId } = JSON.parse(e.data) as { accountId?: string };
		if (accountId && accountIds.includes(accountId)) void pull(accountId);
	};
	return () => ws.close();
}
