// SPDX-License-Identifier: AGPL-3.0-only
import { AccountSwitcher, AppShell, Button, MessageList, MessageRow, Sidebar, useToast } from "@nouvex/ui";
import { Archive, File, Folder, Inbox as InboxIcon, PenLine, Send, ShieldAlert, Trash2 } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { AddAccount } from "../add-account";
import { auth } from "../auth";
import { db } from "../db";
import { Reader } from "../reader";
import { listen, pull, update } from "../sync";
import { type Draft, Write } from "../write";

const standard = [
	{ role: "inbox", label: "Inbox", Icon: InboxIcon },
	{ role: "archive", label: "Archive", Icon: Archive },
	{ role: "sent", label: "Sent", Icon: Send },
	{ role: "drafts", label: "Drafts", Icon: File },
	{ role: "junk", label: "Junk", Icon: ShieldAlert },
	{ role: "trash", label: "Trash", Icon: Trash2 },
] as const;

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		const { data } = await auth.getSession();
		if (!data) throw redirect({ to: "/login" });
		return { user: data.user };
	},
	component: Inbox,
});

function Inbox() {
	const { user } = Route.useRouteContext();
	const [current, setCurrent] = useState("all");
	// A role shows that folder of every account in view; the user's own folders are picked by id.
	const [folder, setFolder] = useState("inbox");
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState<Draft>();
	const toast = useToast();
	const [open, setOpen] = useState<string>();
	const accounts = useQuery({
		queryKey: ["accounts"],
		queryFn: async () => (await fetch("/accounts")).json() as Promise<{ id: string; email: string }[]>,
	});
	const ids = (accounts.data ?? []).map((a) => a.id).join();

	useEffect(() => {
		if (!ids) return;
		const list = ids.split(",");
		for (const id of list) void pull(id);
		return listen(list, (e) =>
			toast.add(
				e.error ? { title: `Couldn't send “${e.subject}”`, description: e.error } : { title: `Sent “${e.subject}”` },
			),
		);
	}, [ids, toast]);

	const boxes =
		useLiveQuery(
			() => (current === "all" ? db.mailboxes.toArray() : db.mailboxes.where("accountId").equals(current).toArray()),
			[current],
		) ?? [];
	const shown = boxes.filter((b) => (b.role ? b.role === folder : b.id === folder)).map((b) => b.id);
	// ponytail: renders every message; switch to VirtualList once folders get big.
	const messages = useLiveQuery(
		async () => (await db.messages.where("mailboxId").anyOf(shown).sortBy("sentAt")).reverse(),
		[shown.join()],
	);
	const own = current === "all" ? [] : boxes.filter((b) => !b.role).sort((a, b) => a.name.localeCompare(b.name));

	const reading = messages?.find((m) => m.id === open);

	return (
		<AppShell
			className="h-screen"
			logo={<span role="img" aria-label="Nouvex" className="logo" />}
			sidebar={
				<Sidebar.Root>
					<AccountSwitcher
						accounts={(accounts.data ?? []).map((a) => ({ id: a.id, email: a.email, name: a.email }))}
						current={current}
						onChange={(id) => {
							setCurrent(id);
							setFolder("inbox");
						}}
						onAddAccount={() => setAdding(true)}
					/>
					<Sidebar.Section>
						<Sidebar.Item label="Write" icon={<PenLine strokeWidth={1.75} />} onSelect={() => setDraft({})} />
						{standard
							.filter((f) => f.role === "inbox" || boxes.some((b) => b.role === f.role))
							.map(({ role, label, Icon }) => (
								<Sidebar.Item
									key={role}
									label={label}
									icon={<Icon strokeWidth={1.75} />}
									active={folder === role}
									onSelect={() => setFolder(role)}
								/>
							))}
					</Sidebar.Section>
					{own.length > 0 && (
						<Sidebar.Section title="Folders" collapsible>
							{own.map((b) => (
								<Sidebar.Item
									key={b.id}
									label={b.name}
									icon={<Folder strokeWidth={1.75} />}
									active={folder === b.id}
									onSelect={() => setFolder(b.id)}
								/>
							))}
						</Sidebar.Section>
					)}
					<Sidebar.Section title={user.email}>
						<Sidebar.Item label="Sign out" onSelect={() => auth.signOut().then(() => location.assign("/login"))} />
					</Sidebar.Section>
				</Sidebar.Root>
			}
			header={null}
		>
			{reading ? (
				<Reader
					message={reading}
					onClose={() => setOpen(undefined)}
					onWrite={setDraft}
					onTrash={() => {
						setOpen(undefined);
						void update(reading, { trash: true });
					}}
					onArchive={
						folder === "archive"
							? undefined
							: () => {
									setOpen(undefined);
									void update(reading, { archive: true });
								}
					}
				/>
			) : accounts.data?.length === 0 ? (
				<div className="grid h-full place-items-center">
					<Button variant="primary" onClick={() => setAdding(true)}>
						Add your first account
					</Button>
				</div>
			) : (
				<MessageList>
					{messages?.map((m) => (
						<MessageRow
							key={m.id}
							from={m.fromName || m.fromAddr}
							email={m.fromAddr}
							subject={m.subject}
							snippet={m.snippet}
							date={new Date(m.sentAt)}
							unread={!m.flags.includes("\\Seen")}
							onOpen={() => {
								setOpen(m.id);
								if (!m.flags.includes("\\Seen")) void update(m, { seen: true });
							}}
							onArchive={folder === "archive" ? undefined : () => void update(m, { archive: true })}
							onDelete={() => void update(m, { trash: true })}
						/>
					))}
				</MessageList>
			)}
			<AddAccount open={adding} onOpenChange={setAdding} onAdded={() => accounts.refetch()} />
			<Write
				from={accounts.data?.find((a) => a.id === (draft?.accountId ?? current)) ?? accounts.data?.[0]}
				contacts={[
					...new Map(
						(messages ?? []).map((m) => [m.fromAddr, { name: m.fromName || m.fromAddr, email: m.fromAddr }]),
					).values(),
				]}
				draft={draft}
				onClose={() => setDraft(undefined)}
			/>
		</AppShell>
	);
}
