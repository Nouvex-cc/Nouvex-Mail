// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient } from "@tanstack/react-query";

/** Settings that follow the user to every device (stored by the API, see Prefs in apps/api/src/app.ts). */
export type Prefs = {
	markRead: "instant" | "delay" | "never";
	remoteImages: "always" | "ask";
	afterArchive: "next" | "previous" | "list";
	undoSend: 0 | 5 | 10 | 20 | 30;
	replyDefault: "reply" | "all";
};

export const defaults: Prefs = {
	markRead: "instant",
	remoteImages: "always",
	afterArchive: "list",
	undoSend: 5,
	replyDefault: "reply",
};

// The last answer is kept in the browser, so the first paint already has the user's choices.
const cached = () => {
	try {
		return JSON.parse(localStorage.getItem("prefs") ?? "{}") as Partial<Prefs>;
	} catch {
		return {};
	}
};

const usePrefsQuery = () =>
	useQuery({
		queryKey: ["prefs"],
		queryFn: async () => {
			const res = await fetch("/prefs");
			if (!res.ok) throw new Error(`prefs: ${res.status}`);
			const prefs = (await res.json()) as Partial<Prefs>;
			try {
				localStorage.setItem("prefs", JSON.stringify(prefs));
			} catch {}
			return prefs;
		},
		placeholderData: cached,
	});

export function usePref<K extends keyof Prefs>(key: K) {
	const client = useQueryClient();
	const value = usePrefsQuery().data?.[key] ?? defaults[key];
	const set = (next: Prefs[K]) => {
		// ponytail: last write wins per key; a failed save shows the old value again after the refetch.
		client.setQueryData<Partial<Prefs>>(["prefs"], (old) => ({ ...old, [key]: next }));
		void fetch("/prefs", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ [key]: next }),
		}).finally(() => client.invalidateQueries({ queryKey: ["prefs"] }));
	};
	return [value, set] as const;
}
