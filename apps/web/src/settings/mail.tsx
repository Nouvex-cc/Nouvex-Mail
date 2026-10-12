// SPDX-License-Identifier: AGPL-3.0-only
import { Kbd, keyLabel, Select, Settings, Toggle, ToggleGroup } from "@nouvex/ui";
import { BookOpen, Keyboard, PenLine } from "@nouvex/ui/icons";
import { type Prefs, usePref } from "../prefs";
import { shortcuts } from "../shortcuts";
import type { Module, Page } from "./registry";

type Pref = {
	[K in keyof Prefs]: { key: K; label: string; hint?: string; keywords?: string; options: [Prefs[K], string][] };
}[keyof Prefs];

// Up to three short choices sit side by side, longer lists open as a select.
function PrefRow<K extends keyof Prefs>({ pref }: { pref: Pref & { key: K } }) {
	const [value, set] = usePref(pref.key);
	const options = pref.options as [Prefs[K], string][];
	return (
		<Settings.Row id={pref.key} label={pref.label} hint={pref.hint}>
			{options.length <= 3 ? (
				<ToggleGroup
					value={[String(value)]}
					onValueChange={(v) => {
						const picked = options.find(([o]) => String(o) === v[0]);
						if (picked) set(picked[0]);
					}}
				>
					{options.map(([o, label]) => (
						<Toggle key={String(o)} value={String(o)}>
							{label}
						</Toggle>
					))}
				</ToggleGroup>
			) : (
				<Select.Root
					value={value}
					onValueChange={(v) => set(v as Prefs[K])}
					items={options.map(([o, label]) => ({ value: o, label }))}
				>
					<Select.Trigger className="w-40" />
					<Select.Popup>
						{options.map(([o, label]) => (
							<Select.Item key={String(o)} value={o}>
								{label}
							</Select.Item>
						))}
					</Select.Popup>
				</Select.Root>
			)}
		</Settings.Row>
	);
}

// A page made only of preferences: search finds each of them, and each one links by its key.
const prefsPage = (page: Omit<Page, "render" | "entries">, prefs: Pref[]): Page => ({
	...page,
	entries: prefs.map((p) => ({ id: p.key, label: p.label, keywords: p.keywords })),
	render: () => (
		<Settings.Page title={page.title}>
			<Settings.Section>
				{prefs.map((p) => (
					<PrefRow key={p.key} pref={p} />
				))}
			</Settings.Section>
		</Settings.Page>
	),
});

const reading = prefsPage({ id: "reading", title: "Reading", icon: <BookOpen strokeWidth={1.75} /> }, [
	{
		key: "markRead",
		label: "Mark as read",
		hint: "When you open a conversation",
		keywords: "seen unread",
		options: [
			["instant", "Right away"],
			["delay", "After 2 s"],
			["never", "Never"],
		],
	},
	{
		key: "remoteImages",
		label: "Pictures in mail",
		hint: "They load through Nouvex, so senders don't see when or where you read",
		keywords: "images remote load tracking privacy",
		options: [
			["always", "Show"],
			["ask", "Ask first"],
		],
	},
	{
		key: "afterArchive",
		label: "After archiving or deleting",
		hint: "From an open conversation",
		keywords: "next previous archive delete",
		options: [
			["next", "Next"],
			["previous", "Previous"],
			["list", "Back to list"],
		],
	},
]);

const writing = prefsPage({ id: "writing", title: "Writing", icon: <PenLine strokeWidth={1.75} /> }, [
	{
		key: "undoSend",
		label: "Undo send",
		hint: "How long a sent message can still be taken back",
		keywords: "cancel delay",
		options: [
			[0, "Off"],
			[5, "5 seconds"],
			[10, "10 seconds"],
			[20, "20 seconds"],
			[30, "30 seconds"],
		],
	},
	{
		key: "replyDefault",
		label: "R replies to",
		hint: "Reply all only when there is more than one other person",
		keywords: "reply all default",
		options: [
			["reply", "Sender"],
			["all", "Everyone"],
		],
	},
]);

const slug = (label: string) => label.toLowerCase().replaceAll(" ", "-");

const keys: Page = {
	id: "shortcuts",
	title: "Shortcuts",
	icon: <Keyboard strokeWidth={1.75} />,
	entries: shortcuts.flatMap((g) =>
		g.items.map((i) => ({ id: slug(i.label), label: i.label, keywords: `shortcut key ${i.keys}` })),
	),
	render: () => (
		<Settings.Page title="Shortcuts">
			{shortcuts.map((g) => (
				<Settings.Section key={g.title} title={g.title}>
					{g.items.map((i) => (
						<Settings.Row key={i.keys} id={slug(i.label)} label={i.label}>
							<Kbd>{keyLabel(i.keys)}</Kbd>
						</Settings.Row>
					))}
				</Settings.Section>
			))}
		</Settings.Page>
	),
};

export const mail: Module = { title: "Mail", usePages: () => [reading, writing, keys] };
