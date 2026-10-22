// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Dialog, Field, Input, OTPField, Settings, useToast } from "@nouvex/ui";
import { Shield, User } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { encode } from "uqr";
import { auth } from "../auth";
import type { Module, Page } from "./registry";

type Result = { error: { message?: string } | null };
const failed = (res: Result) => (res.error ? (res.error.message ?? "That didn't work.") : "");

// Changes that could lock someone out ask for the password first.
function Confirm({
	title,
	action,
	open,
	onOpenChange,
	onConfirm,
	children,
}: {
	title: string;
	action: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (password: string) => Promise<string>;
	children?: ReactNode;
}) {
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(o) => {
				setError("");
				onOpenChange(o);
			}}
		>
			<Dialog.Popup className="max-w-sm">
				<Dialog.Title>{title}</Dialog.Title>
				<form
					className="grid gap-3"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						const problem = await onConfirm(String(new FormData(e.currentTarget).get("password")));
						setBusy(false);
						setError(problem);
						if (!problem) onOpenChange(false);
					}}
				>
					{children}
					<Field.Root>
						<Field.Label>Your password</Field.Label>
						<Field.Control name="password" type="password" required autoFocus autoComplete="current-password" />
					</Field.Root>
					{error && <p className="text-sm text-danger">{error}</p>}
					<Dialog.Footer>
						<Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
						<Button variant="primary" type="submit" loading={busy}>
							{action}
						</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Popup>
		</Dialog.Root>
	);
}

function Profile() {
	const session = auth.useSession();
	const toast = useToast();
	const [password, setPassword] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const user = session.data?.user;
	if (!user) return null;

	return (
		<Settings.Page title="Profile">
			<Settings.Section>
				<Settings.Row id="name" label="Name" hint="Shown to you in Nouvex, not to people you write to">
					<form
						className="w-64"
						onSubmit={async (e) => {
							e.preventDefault();
							const name = String(new FormData(e.currentTarget).get("name")).trim();
							if (name && name !== user.name && !(await auth.updateUser({ name })).error)
								toast.add({ title: "Name saved" });
						}}
					>
						<Input
							name="name"
							aria-label="Name"
							defaultValue={user.name}
							onBlur={(e) => e.currentTarget.form?.requestSubmit()}
						/>
					</form>
				</Settings.Row>
				<Settings.Row id="email" label="Email" hint="What you sign in with">
					<span className="text-muted">{user.email}</span>
				</Settings.Row>
				<Settings.Row id="password" label="Password" hint="Changing it signs you out everywhere else">
					<Button onClick={() => setPassword(true)}>Change</Button>
				</Settings.Row>
			</Settings.Section>

			<Settings.Section>
				<Settings.Row
					id="delete"
					label="Delete your Nouvex account"
					hint="Removes your accounts, settings and everything synced. Your mailboxes stay as they are."
				>
					<Button variant="danger" onClick={() => setLeaving(true)}>
						Delete
					</Button>
				</Settings.Row>
			</Settings.Section>

			<Confirm
				title="Change password"
				action="Change"
				open={password}
				onOpenChange={setPassword}
				onConfirm={async (currentPassword) => {
					const newPassword = (document.getElementById("new-password") as HTMLInputElement).value;
					const problem = failed(
						await auth.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }),
					);
					if (!problem) toast.add({ title: "Password changed" });
					return problem;
				}}
			>
				<Field.Root>
					<Field.Label>New password</Field.Label>
					<Field.Control id="new-password" type="password" required minLength={8} autoComplete="new-password" />
				</Field.Root>
			</Confirm>
			<Confirm
				title="Delete your Nouvex account?"
				action="Delete for good"
				open={leaving}
				onOpenChange={setLeaving}
				onConfirm={async (password) => {
					const problem = failed(await auth.deleteUser({ password }));
					if (!problem) location.assign("/login");
					return problem;
				}}
			/>
		</Settings.Page>
	);
}

// The authenticator app's QR code, always dark on light: plenty of scanners can't read it the other way round.
function Qr({ text }: { text: string }) {
	const { size, data } = encode(text, { border: 1 });
	const dark = data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ""))).join("");
	return (
		<svg
			viewBox={`0 0 ${size} ${size}`}
			className="size-40 rounded-md bg-paper fill-ink scheme-light"
			role="img"
			aria-label="QR code"
		>
			<path d={dark} />
		</svg>
	);
}

function TwoFactor({ on }: { on: boolean }) {
	const toast = useToast();
	const [step, setStep] = useState<"password" | "off" | "codes">();
	const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] }>();
	const [fresh, setFresh] = useState<string[]>();
	const [error, setError] = useState("");
	const secret = setup && new URL(setup.totpURI).searchParams.get("secret");

	return (
		<Settings.Row
			id="two-factor"
			label="Two-factor authentication"
			hint={on ? "On. Signing in also asks for a code from your authenticator app." : "Off"}
			stack={!!setup || !!fresh}
		>
			{setup ? (
				<div className="grid gap-4">
					<div className="flex flex-wrap items-start gap-6">
						<Qr text={setup.totpURI} />
						<div className="grid max-w-xs gap-2 text-sm">
							<p>Scan this with your authenticator app, or enter the key by hand:</p>
							<code className="break-all rounded-md bg-sunken px-2 py-1">{secret}</code>
							<p className="text-muted">Then type the code it shows.</p>
							<OTPField
								aria-label="Code from your authenticator app"
								onValueComplete={async (code) => {
									const problem = failed(await auth.twoFactor.verifyTotp({ code }));
									setError(problem);
									if (!problem) {
										setSetup(undefined);
										toast.add({ title: "Two-factor is on", description: "Keep your backup codes somewhere safe." });
									}
								}}
							/>
							{error && <p className="text-danger">{error}</p>}
						</div>
					</div>
					<BackupCodes codes={setup.backupCodes} />
				</div>
			) : on ? (
				<>
					{fresh && <BackupCodes codes={fresh} />}
					<div className="flex gap-2">
						<Button onClick={() => setStep("codes")}>New backup codes</Button>
						<Button variant="ghost" onClick={() => setStep("off")}>
							Turn off
						</Button>
					</div>
				</>
			) : (
				<Button onClick={() => setStep("password")}>Turn on</Button>
			)}
			<Confirm
				title={step === "off" ? "Turn off two-factor?" : step === "codes" ? "New backup codes" : "Turn on two-factor"}
				action={step === "off" ? "Turn off" : "Continue"}
				open={step !== undefined}
				onOpenChange={(o) => !o && setStep(undefined)}
				onConfirm={async (password) => {
					setFresh(undefined);
					if (step === "off") return failed(await auth.twoFactor.disable({ password }));
					if (step === "codes") {
						const res = await auth.twoFactor.generateBackupCodes({ password });
						setFresh(res.data?.backupCodes);
						return failed(res);
					}
					const res = await auth.twoFactor.enable({ password });
					if (res.data && "totpURI" in res.data) setSetup(res.data);
					return failed(res);
				}}
			/>
		</Settings.Row>
	);
}

function BackupCodes({ codes }: { codes: string[] }) {
	return (
		<div className="grid gap-2 text-sm">
			<p className="text-muted">Backup codes, each works once when your phone isn't at hand:</p>
			<code className="grid grid-cols-2 gap-x-6 gap-y-1 justify-self-start rounded-md bg-sunken px-3 py-2 sm:grid-cols-5">
				{codes.map((c) => (
					<span key={c}>{c}</span>
				))}
			</code>
		</div>
	);
}

// Enough to tell devices apart: the browser and the system it runs on. Edge says Chrome too, Chrome says Safari.
// The Apple apps say "Nouvex Mail (macOS)" or "(iOS)".
const browsers = [
	[/^Nouvex Mail/, "Nouvex Mail"],
	[/Edg\//, "Edge"],
	[/Firefox\//, "Firefox"],
	[/Chrome\//, "Chrome"],
	[/Safari\//, "Safari"],
] as const;
const systems = [
	[/iPhone|iPad|\(iOS\)/, "iOS"],
	[/Mac OS X|\(macOS\)/, "macOS"],
	[/Android/, "Android"],
	[/Windows/, "Windows"],
	[/Linux/, "Linux"],
] as const;
function device(agent = "") {
	const browser = browsers.find(([r]) => r.test(agent))?.[1] ?? "Browser";
	const system = systems.find(([r]) => r.test(agent))?.[1];
	return system ? `${browser} on ${system}` : browser;
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Security() {
	const session = auth.useSession();
	const passkeys = auth.useListPasskeys();
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: async () => (await auth.listSessions()).data ?? [] });
	const toast = useToast();
	const current = session.data?.session.token;

	return (
		<Settings.Page title="Security">
			<Settings.Section>
				<TwoFactor on={!!session.data?.user.twoFactorEnabled} />
			</Settings.Section>

			<Settings.Section title="Passkeys">
				{passkeys.data?.map((p) => (
					<Settings.Row key={p.id} label={p.name || "Passkey"} hint={`Added ${when.format(new Date(p.createdAt))}`}>
						<Button
							variant="ghost"
							onClick={async () => {
								await auth.passkey.deletePasskey({ id: p.id });
								toast.add({ title: "Passkey removed" });
							}}
						>
							Remove
						</Button>
					</Settings.Row>
				))}
				<Settings.Row
					id="passkeys"
					label="Sign in with your fingerprint, face or device"
					hint="No password to type, nothing to phish"
				>
					<Button
						onClick={async () => {
							const res = await auth.passkey.addPasskey({ name: device(navigator.userAgent) });
							if (res?.error && !("code" in res.error && res.error.code === "AUTH_CANCELLED"))
								toast.add({ title: "Couldn't add the passkey", description: res.error.message });
						}}
					>
						Add passkey
					</Button>
				</Settings.Row>
			</Settings.Section>

			<Settings.Section title="Where you're signed in">
				{sessions.data
					?.toSorted((a, b) => Number(b.token === current) - Number(a.token === current))
					.map((s) => (
						<Settings.Row
							key={s.id}
							id={s.token === current ? "sessions" : undefined}
							label={device(s.userAgent ?? "")}
							hint={s.token === current ? "This device" : `Last active ${when.format(new Date(s.updatedAt))}`}
						>
							{s.token !== current && (
								<Button
									variant="ghost"
									onClick={async () => {
										await auth.revokeSession({ token: s.token });
										void sessions.refetch();
									}}
								>
									Sign out
								</Button>
							)}
						</Settings.Row>
					))}
				{(sessions.data?.length ?? 0) > 1 && (
					<Settings.Row label="Sign out everywhere else">
						<Button
							onClick={async () => {
								await auth.revokeOtherSessions();
								void sessions.refetch();
							}}
						>
							Sign out others
						</Button>
					</Settings.Row>
				)}
			</Settings.Section>
		</Settings.Page>
	);
}

const profile: Page = {
	id: "profile",
	title: "Profile",
	icon: <User strokeWidth={1.75} />,
	entries: [
		{ id: "name", label: "Name" },
		{ id: "email", label: "Email", keywords: "address login" },
		{ id: "password", label: "Password", keywords: "change" },
		{ id: "delete", label: "Delete your Nouvex account", keywords: "remove close" },
	],
	render: () => <Profile />,
};

const security: Page = {
	id: "security",
	title: "Security",
	icon: <Shield strokeWidth={1.75} />,
	entries: [
		{ id: "two-factor", label: "Two-factor authentication", keywords: "2fa totp authenticator code backup" },
		{ id: "passkeys", label: "Passkeys", keywords: "fingerprint face touch id webauthn" },
		{ id: "sessions", label: "Where you're signed in", keywords: "sessions devices sign out log out" },
	],
	render: () => <Security />,
};

export const you: Module = { title: "You", usePages: () => [profile, security] };
