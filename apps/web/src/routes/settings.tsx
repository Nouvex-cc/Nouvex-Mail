// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Field, Textarea, Toggle, ToggleGroup } from "@nouvex/ui";
import { ChevronLeft } from "@nouvex/ui/icons";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type Account, useAccounts } from "../accounts";
import { AddAccount } from "../add-account";
import { session } from "../auth";
import { forget } from "../sync";
import { applyTheme, storedTheme, type Theme } from "../theme";

export const Route = createFileRoute("/settings")({
	beforeLoad: async () => {
		const { data } = await session();
		if (!data) throw redirect({ to: "/login" });
	},
	component: Settings,
});

function Settings() {
	const navigate = useNavigate();
	const accounts = useAccounts();
	const [adding, setAdding] = useState(false);
	const [theme, setTheme] = useState(storedTheme);

	return (
		<main className="mx-auto grid max-w-2xl content-start gap-8 p-6">
			<Button variant="ghost" size="sm" className="justify-self-start" onClick={() => navigate({ to: "/" })}>
				<ChevronLeft strokeWidth={1.75} />
				Inbox
			</Button>

			<section className="grid gap-3">
				<h2 className="text-xl font-semibold">Appearance</h2>
				<ToggleGroup
					value={[theme]}
					onValueChange={(v) => {
						const next = (v[0] as Theme | undefined) ?? theme;
						setTheme(next);
						applyTheme(next);
					}}
					className="justify-self-start"
				>
					<Toggle value="system">System</Toggle>
					<Toggle value="light">Light</Toggle>
					<Toggle value="dark">Dark</Toggle>
				</ToggleGroup>
			</section>

			<section className="grid gap-3">
				<div className="flex items-center justify-between">
					<h2 className="text-xl font-semibold">Accounts</h2>
					<Button size="sm" onClick={() => setAdding(true)}>
						Add account
					</Button>
				</div>
				{accounts.data?.map((a) => (
					<AccountSettings key={a.id} account={a} onChanged={() => accounts.refetch()} />
				))}
			</section>
			<AddAccount open={adding} onOpenChange={setAdding} onAdded={() => accounts.refetch()} />
		</main>
	);
}

function AccountSettings({ account: a, onChanged }: { account: Account; onChanged: () => void }) {
	const [saved, setSaved] = useState(false);
	return (
		<form
			className="grid gap-3 rounded-lg border border-line p-4"
			onSubmit={async (e) => {
				e.preventDefault();
				const f = new FormData(e.currentTarget);
				const res = await fetch(`/accounts/${a.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ displayName: f.get("displayName"), signature: f.get("signature") }),
				});
				setSaved(res.ok);
				onChanged();
			}}
		>
			<span className="font-medium">{a.email}</span>
			<Field.Root>
				<Field.Label>Name</Field.Label>
				<Field.Control name="displayName" defaultValue={a.displayName} placeholder="Shown next to your address" />
			</Field.Root>
			<Field.Root>
				<Field.Label>Signature</Field.Label>
				<Textarea name="signature" defaultValue={a.signature} placeholder="Added below new messages and replies" />
			</Field.Root>
			<div className="flex justify-between gap-2">
				<Button
					type="button"
					variant="danger"
					hold={1200}
					onHoldComplete={async () => {
						await forget(a.id);
						onChanged();
					}}
				>
					Hold to remove
				</Button>
				<Button
					type="submit"
					variant="primary"
					success={saved && "Saved"}
					labels={["Saved"]}
					onClick={() => setSaved(false)}
				>
					Save
				</Button>
			</div>
		</form>
	);
}
