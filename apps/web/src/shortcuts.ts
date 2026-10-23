// SPDX-License-Identifier: AGPL-3.0-only
import type { ShortcutGroup } from "@nouvex/ui";

// Every shortcut in the app, for the "?" dialog and Settings › Shortcuts. Keys follow useShortcut ("mod+,").
export const shortcuts: ShortcutGroup[] = [
	{
		title: "Anywhere",
		items: [
			{ keys: "/", label: "Search" },
			{ keys: "mod+,", label: "Settings" },
			{ keys: "?", label: "All shortcuts" },
			{ keys: "1", label: "All inboxes" },
			{ keys: "2", label: "Next groups and accounts, up to 9" },
		],
	},
	{
		title: "List",
		items: [
			{ keys: "j", label: "Next conversation" },
			{ keys: "k", label: "Previous conversation" },
			{ keys: "x", label: "Select" },
			{ keys: "mod+a", label: "Select all" },
			{ keys: "Esc", label: "Clear selection" },
		],
	},
	{
		title: "Conversation",
		items: [
			{ keys: "r", label: "Reply" },
			{ keys: "a", label: "Reply all" },
			{ keys: "f", label: "Forward" },
			{ keys: "Esc", label: "Back to the list" },
		],
	},
	{ title: "Writing", items: [{ keys: "mod+enter", label: "Send" }] },
];
