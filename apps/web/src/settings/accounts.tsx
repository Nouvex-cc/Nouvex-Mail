// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Input, Settings, Sidebar, Textarea } from "@nouvex/ui";
import { Mail, Plus } from "@nouvex/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type Account, useAccounts } from "../accounts";
import { AddAccount } from "../add-account";
import { forget } from "../sync";
import type { Module, Page } from "./registry";

function AccountPage({ account: a }: { account: Account }) {
	const accounts = useAccounts();
	const navigate = useNavigate();
	const [saved, setSaved] = useState(false);

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
						body: JSON.stringify({ displayName: f.get("displayName"), signature: f.get("signature") }),
					});
					setSaved(res.ok);
					void accounts.refetch();
				}}
			>
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

			<Settings.Section>
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
		(useAccounts().data ?? []).map(
			(a): Page => ({
				id: a.email,
				title: a.email,
				icon: <Mail strokeWidth={1.75} />,
				entries: [
					{ id: "name", label: "Name", keywords: "sender display" },
					{ id: "signature", label: "Signature" },
					{ id: "remove", label: "Remove account", keywords: "delete" },
				],
				render: () => <AccountPage key={a.id} account={a} />,
			}),
		),
	action: Add,
};
