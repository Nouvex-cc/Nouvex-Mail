// SPDX-License-Identifier: AGPL-3.0-only
import { AccountSwitcher, AppShell, Button, MessageList, MessageRow, Sidebar, useToast } from "@nouvex/ui";
import { Inbox as InboxIcon, PenLine } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { AddAccount } from "../add-account";
import { auth } from "../auth";
import { db } from "../db";
import { Reader } from "../reader";
import { listen, pull, update } from "../sync";
import { Write } from "../write";

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
	const [adding, setAdding] = useState(false);
	const [writing, setWriting] = useState(false);
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

	// ponytail: renders every message; switch to VirtualList once inboxes get big.
	const messages = useLiveQuery(
		() =>
			current === "all"
				? db.messages.orderBy("sentAt").reverse().toArray()
				: db.messages.where("[accountId+sentAt]").between([current, ""], [current, "￿"]).reverse().toArray(),
		[current],
	);

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
						onChange={setCurrent}
						onAddAccount={() => setAdding(true)}
					/>
					<Sidebar.Section>
						<Sidebar.Item label="Write" icon={<PenLine strokeWidth={1.75} />} onSelect={() => setWriting(true)} />
						<Sidebar.Item label="Inbox" icon={<InboxIcon strokeWidth={1.75} />} active onSelect={() => {}} />
					</Sidebar.Section>
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
					onTrash={() => {
						setOpen(undefined);
						void update(reading, { trash: true });
					}}
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
							onDelete={() => void update(m, { trash: true })}
						/>
					))}
				</MessageList>
			)}
			<AddAccount open={adding} onOpenChange={setAdding} onAdded={() => accounts.refetch()} />
			<Write
				from={accounts.data?.find((a) => a.id === current) ?? accounts.data?.[0]}
				contacts={[
					...new Map(
						(messages ?? []).map((m) => [m.fromAddr, { name: m.fromName || m.fromAddr, email: m.fromAddr }]),
					).values(),
				]}
				open={writing}
				onOpenChange={setWriting}
			/>
		</AppShell>
	);
}
