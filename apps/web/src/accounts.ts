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

// An archived account has no watcher, so opening it checks it now.
export function wake(id: string) {
	void fetch(`/accounts/${id}/sync`, { method: "POST" });
}

export const asleep = (a: Account) => !!a.archivedAt;
