// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Dialog, Field, Select, Settings, Sidebar, Switch, useToast } from "@nouvex/ui";
import { Copy, Globe, Plus } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAccounts } from "../accounts";
import type { Module, Page } from "./registry";

type DnsRecord = {
	key: string;
	type: "TXT" | "MX";
	name: string;
	value: string;
	priority?: number;
	ok: boolean | null;
	found: string[];
};
export type Domain = {
	id: string;
	name: string;
	verified: boolean;
	catchAllAccountId: string | null;
	checkedAt: string | null;
	records: DnsRecord[];
};

export const useDomains = () =>
	useQuery({ queryKey: ["domains"], queryFn: async () => (await fetch("/domains")).json() as Promise<Domain[]> });

// What each record is for, in the words of someone setting up their domain.
const purpose: Record<string, string> = {
	verify: "Shows the domain is yours",
	mx: "Brings the domain's mail to Nouvex",
	spf: "Lets Nouvex send for the domain",
	dkim: "Signs what Nouvex sends for it",
	dmarc: "Tells receivers what to do with mail that fails both",
	bounce: "Brings bounces back to Nouvex",
	bounceSpf: "Lets Amazon SES send from the bounce domain",
};

const problem = async (res: Response) =>
	((await res.json().catch(() => ({}))) as { error?: string }).error ?? "That didn't work.";

function DomainPage({ domain: d }: { domain: Domain }) {
	const domains = useDomains();
	const accounts = useAccounts();
	const navigate = useNavigate();
	const toast = useToast();
	const [checking, setChecking] = useState(false);
	const [cf, setCf] = useState(false);
	const hosted = (accounts.data ?? []).filter((a) => a.kind === "hosted");
	const ok = d.records.filter((r) => r.ok).length;

	return (
		<Settings.Page title={d.name}>
			<Settings.Section>
				<Settings.Row
					id="status"
					label={d.verified ? "Verified" : "Waiting for its TXT record"}
					hint={
						d.checkedAt
							? `${ok} of ${d.records.length} records in place, checked ${new Date(d.checkedAt).toLocaleString()}`
							: "Add the records below, then check. DNS can take a few minutes to show them."
					}
				>
					<Button
						loading={checking}
						onClick={async () => {
							setChecking(true);
							await fetch(`/domains/${d.id}/check`, { method: "POST" });
							await domains.refetch();
							setChecking(false);
						}}
					>
						Check now
					</Button>
				</Settings.Row>
				<Settings.Row id="cloudflare" label="Cloudflare" hint="Adds the records with a token, used once and not kept">
					<Button onClick={() => setCf(true)}>Set up in Cloudflare</Button>
				</Settings.Row>
			</Settings.Section>

			<Settings.Section title="DNS records">
				{d.records.map((r) => (
					<Settings.Row
						key={r.key}
						id={`record-${r.key}`}
						label={
							<span className="flex items-center gap-2">
								<span
									role="img"
									aria-label={r.ok === null ? "Not checked" : r.ok ? "In place" : "Missing"}
									className={`size-2 rounded-full ${r.ok === null ? "bg-faint" : r.ok ? "bg-positive" : "bg-danger"}`}
								/>
								{purpose[r.key] ?? r.key}
							</span>
						}
						hint={
							<span className="grid gap-1">
								<span>
									{r.type} {r.name}
									{r.priority ? ` (priority ${r.priority})` : ""}
								</span>
								<code className="break-all text-ink">{r.value}</code>
								{r.ok === false && r.found.length > 0 && (
									<span className="break-all">Found: {r.found.join(" · ")}</span>
								)}
							</span>
						}
						stack
					>
						<Button
							variant="ghost"
							className="justify-self-start"
							onClick={async () => {
								await navigator.clipboard.writeText(r.value);
								toast.add({ title: "Copied" });
							}}
						>
							<Copy strokeWidth={1.75} /> Copy value
						</Button>
					</Settings.Row>
				))}
			</Settings.Section>

			<Settings.Section>
				<Settings.Row
					id="catch-all"
					label="Catch-all"
					hint="Mail to an address nobody has. Without one it's refused, which keeps spam to made-up addresses out."
				>
					<Select.Root
						value={d.catchAllAccountId ?? ""}
						onValueChange={async (v) => {
							const res = await fetch(`/domains/${d.id}`, {
								method: "PATCH",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ catchAllAccountId: v || null }),
							});
							if (!res.ok) toast.add({ title: await problem(res) });
							void domains.refetch();
						}}
						items={[{ value: "", label: "Refuse" }, ...hosted.map((a) => ({ value: a.id, label: a.email }))]}
					>
						<Select.Trigger className="w-56" />
						<Select.Popup>
							<Select.Item value="">Refuse</Select.Item>
							{hosted.map((a) => (
								<Select.Item key={a.id} value={a.id}>
									{a.email}
								</Select.Item>
							))}
						</Select.Popup>
					</Select.Root>
				</Settings.Row>
				<Settings.Row id="remove" label="Remove domain" hint="Its mailboxes and aliases have to go first">
					<Button
						variant="danger"
						hold={1200}
						onHoldComplete={async () => {
							const res = await fetch(`/domains/${d.id}`, { method: "DELETE" });
							if (!res.ok) return toast.add({ title: await problem(res) });
							await domains.refetch();
							navigate({ to: "/settings" });
						}}
					>
						Hold to remove
					</Button>
				</Settings.Row>
			</Settings.Section>
			<CloudflareDialog domain={d} open={cf} onOpenChange={setCf} />
		</Settings.Page>
	);
}

function CloudflareDialog({
	domain: d,
	open,
	onOpenChange,
}: {
	domain: Domain;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const domains = useDomains();
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [replaceMx, setReplaceMx] = useState(false);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Popup className="max-w-md">
				<Dialog.Title>Set up {d.name} in Cloudflare</Dialog.Title>
				<form
					className="grid gap-3"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						const token = String(new FormData(e.currentTarget).get("token"));
						const res = await fetch(`/domains/${d.id}/cloudflare`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ token, replaceMx }),
						});
						setBusy(false);
						if (!res.ok) return setError(await problem(res));
						const { applied } = (await res.json()) as { applied: Record<string, string> };
						const conflicts = Object.entries(applied).filter(([, v]) => v === "conflict");
						toast.add({
							title: conflicts.length ? "Set up, with something left to decide" : "Set up in Cloudflare",
							description: conflicts.length
								? "The domain has other MX records. Turn on moving its mail to Nouvex when you're ready."
								: "DNS can take a few minutes to show it everywhere.",
						});
						setError("");
						onOpenChange(false);
						void domains.refetch();
					}}
				>
					<p className="text-sm text-muted">
						Make an API token in Cloudflare (My Profile, API Tokens, Edit zone DNS) for this domain's zone. Nouvex uses
						it for this once and doesn't keep it.
					</p>
					<Field.Root>
						<Field.Label>API token</Field.Label>
						<Field.Control name="token" type="password" required autoComplete="off" />
					</Field.Root>
					<label className="flex items-start justify-between gap-4 text-sm">
						<span className="grid gap-0.5">
							<span className="font-medium">Move its mail to Nouvex now</span>
							<span className="text-muted">
								Replaces its other MX records; mail stops going to where it went before.
							</span>
						</span>
						<Switch aria-label="Move its mail to Nouvex now" checked={replaceMx} onCheckedChange={setReplaceMx} />
					</label>
					{error && <p className="text-sm text-danger">{error}</p>}
					<Dialog.Footer>
						<Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
						<Button variant="primary" type="submit" loading={busy}>
							Set up
						</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Popup>
		</Dialog.Root>
	);
}

function Add() {
	const domains = useDomains();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Sidebar.Item label="Add domain" icon={<Plus strokeWidth={1.75} />} onSelect={() => setOpen(true)} />
			<Dialog.Root open={open} onOpenChange={setOpen}>
				<Dialog.Popup className="max-w-sm">
					<Dialog.Title>Add domain</Dialog.Title>
					<form
						className="grid gap-3"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							const res = await fetch("/domains", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ name: String(new FormData(e.currentTarget).get("name")) }),
							});
							setBusy(false);
							if (!res.ok) return setError(await problem(res));
							const added = (await res.json()) as Domain;
							setError("");
							setOpen(false);
							await domains.refetch();
							navigate({ to: "/settings/$page", params: { page: added.name } });
						}}
					>
						<p className="text-sm text-muted">
							Your own domain, for addresses Nouvex hosts. You'll add a few DNS records next.
						</p>
						<Field.Root>
							<Field.Label>Domain</Field.Label>
							<Field.Control name="name" required placeholder="example.com" autoComplete="off" spellCheck={false} />
						</Field.Root>
						{error && <p className="text-sm text-danger">{error}</p>}
						<Dialog.Footer>
							<Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
							<Button variant="primary" type="submit" loading={busy}>
								Add
							</Button>
						</Dialog.Footer>
					</form>
				</Dialog.Popup>
			</Dialog.Root>
		</>
	);
}

export const domains: Module = {
	title: "Domains",
	usePages: () =>
		(useDomains().data ?? []).map(
			(d): Page => ({
				id: d.name,
				title: d.name,
				icon: <Globe strokeWidth={1.75} />,
				entries: [
					{ id: "status", label: "Verify domain", keywords: "dns check txt" },
					{ id: "cloudflare", label: "Set up in Cloudflare", keywords: "dns token automatic" },
					{ id: "catch-all", label: "Catch-all", keywords: "any address catchall" },
				],
				render: () => <DomainPage domain={d} />,
			}),
		),
	action: Add,
};
