// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Input, LabelColorPicker, Select, Settings, Sidebar, Switch, Textarea, useToast } from "@nouvex/ui";
import { Archive, Mail, Plus, X } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type Account, useAccounts } from "../accounts";
import { AddAccount } from "../add-account";
import { db } from "../db";
import { folders, type Plan, suggest, type Target } from "../importing";
import { forget } from "../sync";
import type { Module, Page } from "./registry";

function AccountPage({ account: a }: { account: Account }) {
	const accounts = useAccounts();
	const navigate = useNavigate();
	const [saved, setSaved] = useState(false);
	const patch = async (change: Partial<Account> | { archived: boolean }) => {
		await fetch(`/accounts/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(change),
		});
		void accounts.refetch();
	};

	return (
		<Settings.Page title={a.email}>
			<form
				className="grid gap-4"
				onSubmit={async (e) => {
					e.preventDefault();
					const f = new FormData(e.currentTarget);
					const res = await fetch(`/accounts/${a.id}`, {
						method: "PATCH",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							displayName: f.get("displayName"),
							signature: f.get("signature"),
							nickname: f.get("nickname"),
						}),
					});
					setSaved(res.ok);
					void accounts.refetch();
				}}
			>
				<Settings.Section title="In your inbox">
					<Settings.Row id="nickname" label="Short name" hint="In the account picker and on the From line">
						<div className="w-64">
							<Input name="nickname" aria-label="Short name" defaultValue={a.nickname} placeholder={a.email} />
						</div>
					</Settings.Row>
				</Settings.Section>
				<Settings.Section title="Sending">
					<Settings.Row id="name" label="Name" hint="Shown next to your address">
						<div className="w-64">
							<Input name="displayName" aria-label="Name" defaultValue={a.displayName} placeholder={a.email} />
						</div>
					</Settings.Row>
					<Settings.Row id="signature" label="Signature" hint="Added below new messages and replies" stack>
						<Textarea name="signature" aria-label="Signature" defaultValue={a.signature} />
					</Settings.Row>
				</Settings.Section>
				<Button
					type="submit"
					variant="primary"
					className="justify-self-end"
					success={saved && "Saved"}
					labels={["Saved"]}
					onClick={() => setSaved(false)}
				>
					Save
				</Button>
			</form>

			{a.kind === "hosted" && <Aliases account={a} />}
			{a.kind === "hosted" && <Importing account={a} />}

			<Settings.Section>
				<Settings.Row
					id="color"
					label="Color"
					hint="Its senders take it where several accounts are mixed, like All inboxes"
				>
					<LabelColorPicker label="Color" value={a.color} onChange={(color) => void patch({ color })} />
				</Settings.Row>
				<Settings.Row id="mute" label="Mute" hint="Its mail stays, without an unread dot in All inboxes">
					<Switch aria-label="Mute" checked={a.muted} onCheckedChange={(muted) => void patch({ muted })} />
				</Settings.Row>
				<Settings.Row
					id="archive"
					label="Archive"
					hint="Out of All inboxes and the account picker, checked for mail once a day. Still there under Archived."
				>
					<Switch
						aria-label="Archive"
						checked={!!a.archivedAt}
						onCheckedChange={(archived) => void patch({ archived })}
					/>
				</Settings.Row>
				<Settings.Row
					id="remove"
					label="Remove account"
					hint="Its mail is removed from Nouvex, the mailbox itself stays as it is"
				>
					<Button
						variant="danger"
						hold={1200}
						onHoldComplete={async () => {
							await forget(a.id);
							await accounts.refetch();
							navigate({ to: "/settings" });
						}}
					>
						Hold to remove
					</Button>
				</Settings.Row>
			</Settings.Section>
		</Settings.Page>
	);
}

// Other addresses of a mailbox Nouvex hosts: they receive into it, on the user's verified domains.
function Aliases({ account: a }: { account: Account }) {
	const accounts = useAccounts();
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	return (
		<Settings.Section title="Addresses">
			<Settings.Row id="address" label={a.email} hint="Its own address" />
			{a.aliases.map((alias) => (
				<Settings.Row key={alias} label={alias} hint="Alias">
					<Button
						variant="ghost"
						aria-label={`Remove ${alias}`}
						onClick={async () => {
							await fetch(`/accounts/${a.id}/aliases/${encodeURIComponent(alias)}`, { method: "DELETE" });
							void accounts.refetch();
						}}
					>
						<X strokeWidth={1.75} />
					</Button>
				</Settings.Row>
			))}
			<form
				className="flex gap-2 py-2"
				onSubmit={async (e) => {
					e.preventDefault();
					const form = e.currentTarget;
					setBusy(true);
					const res = await fetch(`/accounts/${a.id}/aliases`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ address: String(new FormData(form).get("alias")) }),
					});
					setBusy(false);
					if (!res.ok)
						return toast.add({ title: ((await res.json()) as { error?: string }).error ?? "Couldn't add it." });
					form.reset();
					void accounts.refetch();
				}}
			>
				<Input
					name="alias"
					type="email"
					required
					aria-label="New alias"
					placeholder={`hello@${a.email.split("@")[1]}`}
				/>
				<Button type="submit" loading={busy}>
					Add alias
				</Button>
			</form>
		</Settings.Section>
	);
}

const targets: { value: Target; label: string }[] = [
	{ value: "inbox", label: "Inbox" },
	{ value: "archive", label: "Archive" },
	{ value: "sent", label: "Sent" },
	{ value: "drafts", label: "Drafts" },
	{ value: "folder", label: "Own folder" },
	{ value: "junk", label: "Junk" },
	{ value: "trash", label: "Trash" },
	{ value: "skip", label: "Leave behind" },
];

type Import = {
	id: string;
	sourceId: string;
	done: number;
	total: number | null;
	error: string | null;
	finishedAt: string | null;
};

// Brings the mail of another of the user's accounts into this hosted mailbox, folder by folder as the user picks.
function Importing({ account: a }: { account: Account }) {
	const accounts = useAccounts();
	const toast = useToast();
	const sources = (accounts.data ?? []).filter((x) => x.kind === "imap");
	const [sourceId, setSourceId] = useState("");
	const [plans, setPlans] = useState<Plan[]>([]);
	const [busy, setBusy] = useState(false);
	const imports = useQuery({
		queryKey: ["imports", a.id],
		queryFn: async () => (await fetch(`/accounts/${a.id}/imports`)).json() as Promise<Import[]>,
		refetchInterval: (q) => (q.state.data?.some((j) => !j.finishedAt && !j.error) ? 3000 : false),
	});
	const pick = async (id: string) => {
		setSourceId(id);
		const boxes = await db.mailboxes.where("accountId").equals(id).toArray();
		const counted = await Promise.all(
			boxes.map(async (b) => ({
				name: b.name,
				role: b.role,
				count: await db.messages.where("mailboxId").equals(b.id).count(),
			})),
		);
		setPlans(suggest(counted));
	};
	const chosen = folders(plans);
	const from = (id: string) => sources.find((x) => x.id === id)?.email ?? "another account";
	return (
		<Settings.Section title="Import mail">
			{imports.data?.map((j) => (
				<Settings.Row
					key={j.id}
					label={`From ${from(j.sourceId)}`}
					hint={
						j.error
							? `Stopped: ${j.error}`
							: j.finishedAt
								? `Done, ${j.done.toLocaleString()} messages`
								: `${j.done.toLocaleString()} of ${j.total?.toLocaleString() ?? "…"} messages`
					}
				/>
			))}
			<Settings.Row
				id="import"
				label="From another account"
				hint={
					sources.length
						? "Copies its mail into this mailbox. The other account stays as it is."
						: "Add your old account first (Add account), then bring its mail here."
				}
			>
				{sources.length > 0 && (
					<Select.Root
						value={sourceId}
						onValueChange={(v) => v && void pick(String(v))}
						items={[
							{ value: "", label: "Choose an account" },
							...sources.map((x) => ({ value: x.id, label: x.email })),
						]}
					>
						<Select.Trigger className="w-56" />
						<Select.Popup>
							{sources.map((x) => (
								<Select.Item key={x.id} value={x.id}>
									{x.email}
								</Select.Item>
							))}
						</Select.Popup>
					</Select.Root>
				)}
			</Settings.Row>
			{plans.map((p, i) => (
				<Settings.Row key={p.from} label={p.from} hint={`${p.count.toLocaleString()} messages`}>
					{p.to === "folder" && (
						<Input
							aria-label={`Folder for ${p.from}`}
							className="w-40"
							value={p.name}
							onChange={(e) => setPlans(plans.with(i, { ...p, name: e.target.value }))}
						/>
					)}
					<Select.Root
						value={p.to}
						onValueChange={(v) => setPlans(plans.with(i, { ...p, to: v as Target }))}
						items={targets}
					>
						<Select.Trigger className="w-40" aria-label={`Where ${p.from} goes`} />
						<Select.Popup>
							{targets.map((t) => (
								<Select.Item key={t.value} value={t.value}>
									{t.label}
								</Select.Item>
							))}
						</Select.Popup>
					</Select.Root>
				</Settings.Row>
			))}
			{plans.length > 0 && (
				<div className="py-2">
					<Button
						loading={busy}
						disabled={!chosen.length}
						onClick={async () => {
							setBusy(true);
							const res = await fetch(`/accounts/${a.id}/imports`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ sourceId, folders: chosen }),
							});
							setBusy(false);
							if (!res.ok)
								return toast.add({ title: ((await res.json()) as { error?: string }).error ?? "Couldn't start it." });
							setPlans([]);
							setSourceId("");
							void imports.refetch();
						}}
					>
						Import {chosen.length === 1 ? "1 folder" : `${chosen.length} folders`}
					</Button>
				</div>
			)}
		</Settings.Section>
	);
}

function Add() {
	const accounts = useAccounts();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Sidebar.Item label="Add account" icon={<Plus strokeWidth={1.75} />} onSelect={() => setOpen(true)} />
			<AddAccount open={open} onOpenChange={setOpen} onAdded={() => accounts.refetch()} />
		</>
	);
}

export const accounts: Module = {
	title: "Accounts",
	usePages: () =>
		// Archived accounts come last, marked by their icon.
		(useAccounts().data ?? [])
			.toSorted((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt))
			.map(
				(a): Page => ({
					id: a.email,
					title: a.nickname || a.email,
					icon: a.archivedAt ? <Archive strokeWidth={1.75} /> : <Mail strokeWidth={1.75} />,
					entries: [
						{ id: "nickname", label: "Short name", keywords: "nickname alias label" },
						{ id: "name", label: "Name", keywords: "sender display" },
						{ id: "color", label: "Color", keywords: "colour tint" },
						{ id: "mute", label: "Mute", keywords: "quiet unread dot notifications" },
						{ id: "signature", label: "Signature" },
						{ id: "archive", label: "Archive", keywords: "hide rarely dormant" },
						{ id: "remove", label: "Remove account", keywords: "delete" },
					],
					render: () => <AccountPage key={a.id} account={a} />,
				}),
			),
	action: Add,
};
