// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Checkbox, Input, Settings, Sidebar, Switch, Toggle, ToggleGroup } from "@nouvex/ui";
import { ChevronsUpDown, Folder, Plus } from "@nouvex/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type Focus, type Group, named, useAccounts, useGroups } from "../accounts";
import type { Module, Page } from "./registry";

const days: [number, string][] = [
	[1, "Mo"],
	[2, "Tu"],
	[3, "We"],
	[4, "Th"],
	[5, "Fr"],
	[6, "Sa"],
	[0, "Su"],
];
const workdays: Focus = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" };

function useSave() {
	const client = useQueryClient();
	return async (path: string, method: string, body?: unknown) => {
		const res = await fetch(path, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		await client.invalidateQueries({ queryKey: ["groups"] });
		await client.invalidateQueries({ queryKey: ["accounts"] });
		return res;
	};
}

function GroupPage({ group: g }: { group: Group }) {
	const accounts = useAccounts().data ?? [];
	const save = useSave();
	const navigate = useNavigate();
	const patch = (change: Partial<Group>) => save(`/groups/${g.id}`, "PATCH", change);
	const toggle = (id: string, on: boolean) =>
		patch({ accountIds: on ? [...g.accountIds, id] : g.accountIds.filter((a) => a !== id) });

	return (
		<Settings.Page title={g.name}>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					const name = String(new FormData(e.currentTarget).get("name")).trim();
					if (name) void patch({ name });
				}}
			>
				<Settings.Row id="name" label="Name">
					<div className="w-64">
						<Input
							name="name"
							aria-label="Name"
							defaultValue={g.name}
							onBlur={(e) => e.currentTarget.form?.requestSubmit()}
						/>
					</div>
				</Settings.Row>
			</form>
			<Settings.Section title="Accounts">
				{accounts.map((a) => (
					<Settings.Row key={a.id} label={named(a)} hint={a.nickname ? a.email : undefined}>
						<Checkbox
							aria-label={`${named(a)} in ${g.name}`}
							checked={g.accountIds.includes(a.id)}
							onCheckedChange={(on) => void toggle(a.id, on)}
						/>
					</Settings.Row>
				))}
			</Settings.Section>
			<Settings.Section>
				<Settings.Row
					id="focus"
					label="Focus times"
					hint="Outside them the group rests: its mail waits out of All inboxes, without unread dots"
				>
					<Switch
						aria-label="Focus times"
						checked={!!g.focus}
						onCheckedChange={(on) => void patch({ focus: on ? workdays : null })}
					/>
				</Settings.Row>
				{g.focus && <FocusTimes focus={g.focus} onChange={(focus) => void patch({ focus })} />}
				<Settings.Row id="mute" label="Mute" hint="Its mail stays in All inboxes, without an unread dot">
					<Switch aria-label="Mute" checked={g.muted} onCheckedChange={(muted) => void patch({ muted })} />
				</Settings.Row>
				<Settings.Row id="remove" label="Remove group" hint="Its accounts stay as they are">
					<Button
						variant="danger"
						hold={1200}
						onHoldComplete={async () => {
							await save(`/groups/${g.id}`, "DELETE");
							navigate({ to: "/settings/$page", params: { page: "order" } });
						}}
					>
						Hold to remove
					</Button>
				</Settings.Row>
			</Settings.Section>
		</Settings.Page>
	);
}

function FocusTimes({ focus, onChange }: { focus: Focus; onChange: (f: Focus) => void }) {
	return (
		<Settings.Row label="When" stack>
			<div className="flex flex-wrap items-center gap-3">
				<ToggleGroup
					multiple
					aria-label="Days"
					value={focus.days.map(String)}
					onValueChange={(v) => onChange({ ...focus, days: v.map(Number) })}
				>
					{days.map(([d, label]) => (
						<Toggle key={d} value={String(d)}>
							{label}
						</Toggle>
					))}
				</ToggleGroup>
				<div className="flex items-center gap-2">
					<div className="w-28">
						<Input
							type="time"
							aria-label="From"
							defaultValue={focus.from}
							onBlur={(e) => e.currentTarget.value && onChange({ ...focus, from: e.currentTarget.value })}
						/>
					</div>
					<span className="text-muted">to</span>
					<div className="w-28">
						<Input
							type="time"
							aria-label="To"
							defaultValue={focus.to}
							onBlur={(e) => e.currentTarget.value && onChange({ ...focus, to: e.currentTarget.value })}
						/>
					</div>
				</div>
			</div>
		</Settings.Row>
	);
}

// Dragging a row, or Alt+↑/↓ on it, moves it; the picker and the keys 1 to 9 follow this order.
function Order() {
	const accounts = (useAccounts().data ?? []).filter((a) => !a.archivedAt);
	const groups = useGroups().data ?? [];
	const save = useSave();
	const [dragged, setDragged] = useState<string>();
	const store = (g: string[], a: string[]) => void save("/order", "PUT", { groups: g, accounts: a });
	const move = (list: string[], id: string, to: number) => {
		const next = list.filter((x) => x !== id);
		next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
		return next;
	};
	const rows = (kind: "groups" | "accounts", items: { id: string; label: string }[]) => {
		const ids = items.map((i) => i.id);
		const put = (id: string, to: number) => {
			const next = move(ids, id, to);
			const [g, a] = [groups.map((x) => x.id), accounts.map((x) => x.id)];
			store(kind === "groups" ? next : g, kind === "groups" ? a : next);
		};
		return items.map((item, i) => (
			<li
				key={item.id}
				draggable
				onDragStart={() => setDragged(item.id)}
				onDragEnd={() => setDragged(undefined)}
				onDragOver={(e) => dragged && ids.includes(dragged) && e.preventDefault()}
				onDrop={() => dragged && put(dragged, i)}
				data-dragged={dragged === item.id || undefined}
				className="-mx-3 rounded-md hover:bg-hover data-dragged:opacity-50"
			>
				<button
					type="button"
					aria-label={`${item.label}, ${i + 1} of ${items.length}. Alt and arrow keys move it.`}
					onKeyDown={(e) => {
						if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
						e.preventDefault();
						put(item.id, i + (e.key === "ArrowUp" ? -1 : 1));
					}}
					className="flex h-10 w-full cursor-grab items-center gap-2 rounded-md px-3 text-left outline-none focus-visible:outline-2"
				>
					<ChevronsUpDown strokeWidth={1.75} className="size-4 text-faint" />
					{item.label}
				</button>
			</li>
		));
	};
	return (
		<Settings.Page title="Order">
			{groups.length > 0 && (
				<Settings.Section title="Groups">
					<ul>
						{rows(
							"groups",
							groups.map((g) => ({ id: g.id, label: g.name })),
						)}
					</ul>
				</Settings.Section>
			)}
			<Settings.Section title="Accounts">
				<ul>
					{rows(
						"accounts",
						accounts.map((a) => ({ id: a.id, label: named(a) })),
					)}
				</ul>
			</Settings.Section>
		</Settings.Page>
	);
}

function Add() {
	const save = useSave();
	const navigate = useNavigate();
	return (
		<Sidebar.Item
			label="New group"
			icon={<Plus strokeWidth={1.75} />}
			onSelect={async () => {
				const res = await save("/groups", "POST", { name: "New group", accountIds: [], muted: false, focus: null });
				const { id } = (await res.json()) as { id: string };
				navigate({ to: "/settings/$page", params: { page: `group-${id}` } });
			}}
		/>
	);
}

export const groups: Module = {
	title: "Groups",
	usePages: () => [
		...(useGroups().data ?? []).map(
			(g): Page => ({
				id: `group-${g.id}`,
				title: g.name,
				icon: <Folder strokeWidth={1.75} />,
				entries: [
					{ id: "focus", label: "Focus times", keywords: "work hours schedule rest pause" },
					{ id: "mute", label: "Mute", keywords: "quiet unread dot" },
				],
				render: () => <GroupPage key={g.id} group={g} />,
			}),
		),
		{
			id: "order",
			title: "Order",
			icon: <ChevronsUpDown strokeWidth={1.75} />,
			entries: [{ id: "order", label: "Order of accounts and groups", keywords: "sort drag shortcuts 1 9" }],
			render: () => <Order />,
		},
	],
	action: Add,
};
