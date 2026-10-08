// SPDX-License-Identifier: AGPL-3.0-only
import { AccountSwitcher, AppShell, SearchField, Sidebar, useShortcutsDialog } from "@nouvex/ui";
import { Archive, Clock, File, Inbox, Send, Star, Trash2 } from "lucide-react";
import { useState } from "react";

const accounts = [
	{ id: "work", name: "Mateo Coerdts", email: "mateo@nouvex.cc", unread: true },
	{ id: "private", name: "Mateo", email: "mateo@icloud.com" },
	{ id: "shop", name: "Aquila Clothing", email: "info@aquilaclothing.com", unread: true },
];

const contacts = [
	{ name: "Lena Hartmann", email: "lena@hartmann.example" },
	{ name: "Jonas Weber", email: "jonas@weber.example" },
	{ name: "Mira Okafor", email: "mira@okafor.example" },
];

const folders = [
	{ id: "inbox", label: "Inbox", icon: <Inbox strokeWidth={1.75} />, unread: true, shortcut: "G I" },
	{ id: "starred", label: "Starred", icon: <Star strokeWidth={1.75} />, shortcut: "G S" },
	{ id: "snoozed", label: "Snoozed", icon: <Clock strokeWidth={1.75} /> },
	{ id: "sent", label: "Sent", icon: <Send strokeWidth={1.75} />, shortcut: "G T" },
	{ id: "drafts", label: "Drafts", icon: <File strokeWidth={1.75} />, count: 3, shortcut: "G D" },
	{ id: "archive", label: "Archive", icon: <Archive strokeWidth={1.75} /> },
	{ id: "trash", label: "Trash", icon: <Trash2 strokeWidth={1.75} /> },
];

const labels = [
	{ id: "receipts", label: "Receipts", color: "green" },
	{ id: "travel", label: "Travel", color: "blue" },
	{ id: "family", label: "Family", color: "orange" },
	{ id: "newsletters", label: "Newsletters", color: "purple" },
] as const;

const shortcutGroups = [
	{
		title: "Navigation",
		items: [
			{ keys: "g i", label: "Go to inbox" },
			{ keys: "g s", label: "Go to starred" },
			{ keys: "g d", label: "Go to drafts" },
			{ keys: "/", label: "Search" },
			{ keys: "mod+k", label: "Command palette" },
		],
	},
	{
		title: "Actions",
		items: [
			{ keys: "e", label: "Archive" },
			{ keys: "h", label: "Snooze" },
			{ keys: "#", label: "Delete" },
			{ keys: "s", label: "Star" },
			{ keys: "shift+u", label: "Mark as unread" },
		],
	},
	{
		title: "Compose",
		items: [
			{ keys: "c", label: "New message" },
			{ keys: "r", label: "Reply" },
			{ keys: "a", label: "Reply all" },
			{ keys: "f", label: "Forward" },
			{ keys: "mod+enter", label: "Send" },
		],
	},
];

export function NavigationDemo() {
	const [account, setAccount] = useState<string>("all");
	const [active, setActive] = useState("inbox");
	const [query, setQuery] = useState("");
	const shortcuts = useShortcutsDialog(shortcutGroups);

	return (
		<div className="grid w-full gap-3">
			<div className="h-120 w-full overflow-hidden rounded-lg border border-line">
				<AppShell
					className="h-full"
					sidebar={
						<Sidebar.Root>
							<AccountSwitcher accounts={accounts} current={account} onChange={setAccount} onAddAccount={() => {}} />
							<Sidebar.Section>
								{folders.map((f) => (
									<Sidebar.Item key={f.id} {...f} active={active === f.id} onSelect={() => setActive(f.id)} />
								))}
							</Sidebar.Section>
							<Sidebar.Section title="Labels" collapsible>
								{labels.map((l) => (
									<Sidebar.Label key={l.id} {...l} active={active === l.id} onSelect={() => setActive(l.id)} />
								))}
							</Sidebar.Section>
						</Sidebar.Root>
					}
					header={
						<SearchField
							className="w-full max-w-xl"
							contacts={contacts}
							onSearch={(q) =>
								setQuery([q.text, ...q.filters.map((f) => `${f.key}:${f.value}`)].filter(Boolean).join(" "))
							}
						/>
					}
				>
					<p className="p-4 text-sm text-muted">
						{query
							? `Searching: ${query}`
							: "Try lena, from jonas, since friday, unread. Press / to focus, ? for shortcuts."}
					</p>
				</AppShell>
			</div>
			{shortcuts.dialog}
		</div>
	);
}
