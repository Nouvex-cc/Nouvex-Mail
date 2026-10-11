// SPDX-License-Identifier: AGPL-3.0-only
import { Backdrop, Button, Field, Slider, Switch, Textarea, Toggle, ToggleGroup, useToast } from "@nouvex/ui";
import { ChevronLeft } from "@nouvex/ui/icons";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { type Account, useAccounts } from "../accounts";
import { AddAccount } from "../add-account";
import { session } from "../auth";
import { forget } from "../sync";
import { applyLook, applyTheme, type Look, presets, shrink, storedLook, storedTheme, type Theme } from "../theme";

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
				<LookSettings />
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

const hues = [
	[15, "Rose"],
	[45, "Amber"],
	[95, "Lime"],
	[155, "Green"],
	[200, "Teal"],
	[245, "Blue"],
	[285, "Violet"],
	[330, "Pink"],
] as const;

// Colors take effect on the whole page as they're picked; the background shows in the preview here and behind the
// inbox list.
function LookSettings() {
	const toast = useToast();
	const [look, setLook] = useState(storedLook);
	const picker = useRef<HTMLInputElement>(null);
	const change = (next: Partial<Look>) => {
		const merged = { ...look, ...next };
		setLook(merged);
		if (!applyLook(merged)) toast.add({ title: "Couldn't keep the image", description: "Try a smaller one." });
	};
	const active = presets.find((p) => Object.entries(p.look).every(([k, v]) => look[k as keyof Look] === v))?.name;

	return (
		<div className="grid gap-5">
			<div className="grid gap-2">
				<h3 className="text-sm font-medium text-muted">Theme</h3>
				<div className="grid grid-cols-3 gap-2">
					{presets.map((p) => (
						<button
							key={p.name}
							type="button"
							data-active={active === p.name || undefined}
							onClick={() => change(p.look)}
							className="flex h-11 items-center gap-2.5 rounded-lg border border-line px-3 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 data-active:border-accent data-active:bg-accent-soft"
						>
							<span
								className={p.look.tone === "ink" ? "size-4 rounded-full bg-ink" : "hue-swatch size-4 rounded-full"}
								style={{ "--hue": p.look.hue } as React.CSSProperties}
							/>
							{p.name}
						</button>
					))}
				</div>
			</div>

			<div className="grid gap-3">
				<h3 className="text-sm font-medium text-muted">Make your own</h3>
				<ToggleGroup
					value={[look.tone]}
					onValueChange={(v) => v[0] && change({ tone: v[0] as Look["tone"] })}
					className="justify-self-start"
				>
					<Toggle value="ink">Ink</Toggle>
					<Toggle value="accent">Accent</Toggle>
					<Toggle value="tinted">Tinted</Toggle>
					<Toggle value="frame">Frame</Toggle>
				</ToggleGroup>
				<div className="flex gap-2" aria-disabled={look.tone === "ink"}>
					{hues.map(([hue, name]) => (
						<button
							key={hue}
							type="button"
							aria-label={name}
							aria-pressed={look.hue === hue}
							disabled={look.tone === "ink"}
							onClick={() => change({ hue })}
							className="hue-swatch size-7 rounded-full outline-offset-2 transition duration-150 ease-out hover:scale-110 focus-visible:outline-2 disabled:opacity-30 disabled:hover:scale-100 aria-pressed:outline-2 aria-pressed:outline-ink"
							style={{ "--hue": hue } as React.CSSProperties}
						/>
					))}
				</div>
				<label className="flex items-center gap-3">
					<Switch checked={look.people} onCheckedChange={(people) => change({ people })} />
					<span>Give every person a color</span>
				</label>
			</div>

			<div className="grid gap-3">
				<h3 className="text-sm font-medium text-muted">Inbox background</h3>
				<div className="relative h-36 overflow-hidden rounded-lg border border-line bg-paper">
					{look.image && <Backdrop src={look.image} blur={look.blur} grain={look.grain} strength={look.strength} />}
					<div className="relative grid gap-2 p-4">
						{["Lena Hartmann", "Vivid Money", "Jonas Weber"].map((name, i) => (
							<div key={name} className="flex gap-3 text-sm">
								<span className={i < 2 ? "w-28 font-semibold" : "w-28 text-muted"}>{name}</span>
								<span className={i < 2 ? "" : "text-muted"}>Keys for the new flat</span>
							</div>
						))}
					</div>
				</div>
				<div className="flex gap-2">
					<Button size="sm" onClick={() => picker.current?.click()}>
						{look.image ? "Choose another image" : "Choose image"}
					</Button>
					{look.image && (
						<Button size="sm" variant="ghost" onClick={() => change({ image: undefined })}>
							Remove
						</Button>
					)}
					<input
						ref={picker}
						type="file"
						accept="image/*"
						hidden
						onChange={async (e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file) change({ image: await shrink(file) });
						}}
					/>
				</div>
				{look.image && (
					<div className="grid gap-4 sm:grid-cols-3">
						<Slider
							label="Blur"
							min={0}
							max={60}
							value={look.blur}
							onValueChange={(v) => change({ blur: v as number })}
						/>
						<Slider
							label="Grain"
							min={0}
							max={1}
							step={0.05}
							value={look.grain}
							onValueChange={(v) => change({ grain: v as number })}
						/>
						<Slider
							label="Strength"
							min={0.05}
							max={1}
							step={0.05}
							value={look.strength}
							onValueChange={(v) => change({ strength: v as number })}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
