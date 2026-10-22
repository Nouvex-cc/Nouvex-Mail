// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";

export type Account = {
	id: string;
	email: string;
	displayName: string;
	signature: string;
	syncError: string | null;
	archivedAt: string | null;
};

export const useAccounts = () =>
	useQuery({ queryKey: ["accounts"], queryFn: async () => (await fetch("/accounts")).json() as Promise<Account[]> });

// An archived account opened in the last day stays in the account picker, on this device only.
const day = 864e5;

function woken(): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem("woken") ?? "{}");
	} catch {
		return {};
	}
}

export function wake(id: string) {
	try {
		localStorage.setItem("woken", JSON.stringify({ ...woken(), [id]: Date.now() }));
	} catch {}
	// It has no watcher, so it's checked now.
	void fetch(`/accounts/${id}/sync`, { method: "POST" });
}

export const asleep = (a: Account) => !!a.archivedAt && !((woken()[a.id] ?? 0) > Date.now() - day);
