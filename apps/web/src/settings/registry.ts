// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentType, ReactNode } from "react";
import { accounts } from "./accounts";
import { app } from "./appearance";
import { mail } from "./mail";
import { you } from "./you";

/** A setting search can find; `id` is the id of its row on the page, so /settings/<page>#<id> lands on it. */
export type Entry = { id: string; label: string; keywords?: string };

export type Page = { id: string; title: string; icon: ReactNode; entries?: Entry[]; render: () => ReactNode };

/**
 * A group in the settings sidebar. A new part of the app (chat, calendar) adds its own module here; the frame,
 * search and deep links pick it up. `usePages` is a hook so pages can come from data, like one per mail account.
 */
export type Module = { title: string; usePages: () => Page[]; action?: ComponentType };

export const modules: Module[] = [mail, accounts, you, app];

export function useSections() {
	// biome-ignore lint/correctness/useHookAtTopLevel: modules is a fixed list, so the hooks run in the same order every render
	return modules.map((module) => ({ module, pages: module.usePages() }));
}

export type Hit = { page: Page; entry?: Entry };

/** Every word has to show up in the setting's label, keywords or page title. Pages come before their settings. */
export function find(pages: Page[], query: string): Hit[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const fits = (text: string) => words.every((w) => text.toLowerCase().includes(w));
	return pages
		.flatMap((page): Hit[] => [{ page }, ...(page.entries ?? []).map((entry) => ({ page, entry }))])
		.filter(({ page, entry }) => fits(`${entry ? `${entry.label} ${entry.keywords ?? ""} ` : ""}${page.title}`))
		.slice(0, 8);
}
