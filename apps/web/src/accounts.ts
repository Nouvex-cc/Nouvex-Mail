// SPDX-License-Identifier: AGPL-3.0-only
import { type Focus, within } from "@nouvex/sdk/focus";
import type { LabelColor } from "@nouvex/ui";
import { useQuery } from "@tanstack/react-query";

export type Account = {
	id: string;
	email: string;
	displayName: string;
	signature: string;
	syncError: string | null;
	archivedAt: string | null;
	nickname: string;
	color: LabelColor | null;
	muted: boolean;
};

export type { Focus };

export type Group = { id: string; name: string; accountIds: string[]; muted: boolean; focus: Focus | null };

export const useAccounts = () =>
	useQuery({ queryKey: ["accounts"], queryFn: async () => (await fetch("/accounts")).json() as Promise<Account[]> });

export const useGroups = () =>
	useQuery({ queryKey: ["groups"], queryFn: async () => (await fetch("/groups")).json() as Promise<Group[]> });

export const named = (a: Account) => a.nickname || a.email;

// An archived account has no watcher, so opening it checks it now.
export function wake(id: string) {
	void fetch(`/accounts/${id}/sync`, { method: "POST" });
}

export const asleep = (a: Account) => !!a.archivedAt;

/** Outside its focus times a group rests: its mail waits out of All inboxes and makes no noise. */
export const resting = (g: Group, at = new Date()) =>
	!!g.focus && !within(g.focus, at.getDay(), at.getHours() * 60 + at.getMinutes());

/** When a resting group's focus time starts again. */
export function wakes(f: Focus, at = new Date()) {
	for (let d = 0; d <= 7; d++) {
		const t = new Date(at);
		t.setDate(at.getDate() + d);
		t.setHours(Number(f.from.slice(0, 2)), Number(f.from.slice(3, 5)), 0, 0);
		if (t > at && f.days.includes(t.getDay())) return t;
	}
}

/** The account a new message to `to` goes out from: the one last used to write to them, newest first in `sent`. */
export const lastUsed = (sent: { accountId: string; to: string[] }[], to: string) =>
	sent.find((m) => m.to.some((a) => a.toLowerCase() === to.toLowerCase()))?.accountId;
