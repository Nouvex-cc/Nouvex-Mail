// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";

export type Account = { id: string; email: string; displayName: string; signature: string; syncError: string | null };

export const useAccounts = () =>
	useQuery({ queryKey: ["accounts"], queryFn: async () => (await fetch("/accounts")).json() as Promise<Account[]> });
