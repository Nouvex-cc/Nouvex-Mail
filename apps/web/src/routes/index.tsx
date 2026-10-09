// SPDX-License-Identifier: AGPL-3.0-only
import { AccountSwitcher, AppShell, Button, MessageList, MessageRow, Sidebar } from "@nouvex/ui";
import { Inbox as InboxIcon } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { AddAccount } from "../add-account";
import { auth } from "../auth";
import { db } from "../db";
import { listen, pull } from "../sync";

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
	const accounts = useQuery({
		queryKey: ["accounts"],
		queryFn: async () => (await fetch("/accounts")).json() as Promise<{ id: string; email: string }[]>,
	});
	const ids = (accounts.data ?? []).map((a) => a.id).join();

	useEffect(() => {
		if (!ids) return;
		const list = ids.split(",");
		for (const id of list) void pull(id);
		return listen(list);
	}, [ids]);

	// ponytail: renders every message; switch to VirtualList once inboxes get big.
	const messages = useLiveQuery(
		() =>
			current === "all"
				? db.messages.orderBy("sentAt").reverse().toArray()
				: db.messages.where("[accountId+sentAt]").between([current, ""], [current, "￿"]).reverse().toArray(),
		[current],
	);

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
						<Sidebar.Item label="Inbox" icon={<InboxIcon strokeWidth={1.75} />} active onSelect={() => {}} />
					</Sidebar.Section>
					<Sidebar.Section title={user.email}>
						<Sidebar.Item label="Sign out" onSelect={() => auth.signOut().then(() => location.assign("/login"))} />
					</Sidebar.Section>
				</Sidebar.Root>
			}
			header={null}
		>
			{accounts.data?.length === 0 ? (
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
							date={new Date(m.sentAt)}
							unread={!m.flags.includes("\\Seen")}
						/>
					))}
				</MessageList>
			)}
			<AddAccount open={adding} onOpenChange={setAdding} onAdded={() => accounts.refetch()} />
		</AppShell>
	);
}
