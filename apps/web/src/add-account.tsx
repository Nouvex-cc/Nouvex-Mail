// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Dialog, Field, Toggle, ToggleGroup } from "@nouvex/ui";
import { useState } from "react";

const fields = [
	{ name: "email", label: "Email", type: "email" },
	{ name: "password", label: "Password", type: "password" },
	{ name: "username", label: "Username", hint: "Leave empty to use the email address", optional: true },
	{ name: "imapHost", label: "IMAP server", hint: "e.g. imap.example.com" },
	{ name: "imapPort", label: "IMAP port", type: "number", value: "993" },
	{ name: "smtpHost", label: "SMTP server", hint: "e.g. smtp.example.com" },
	{ name: "smtpPort", label: "SMTP port", type: "number", value: "465" },
];

// Both only take an app password over IMAP, so the servers are known and only the password needs explaining.
const providers = {
	gmail: {
		label: "Gmail",
		passwordUrl: "https://myaccount.google.com/apppasswords",
		passwordHint: ["Turn on two-step verification, then", "create an app password", "in your Google account."],
		server: { imapHost: "imap.gmail.com", imapPort: "993", smtpHost: "smtp.gmail.com", smtpPort: "465" },
	},
	icloud: {
		label: "iCloud",
		passwordUrl: "https://account.apple.com/account/manage",
		passwordHint: ["", "Create an app-specific password", "under Sign-in and security."],
		server: { imapHost: "imap.mail.me.com", imapPort: "993", smtpHost: "smtp.mail.me.com", smtpPort: "587" },
	},
};
type Provider = keyof typeof providers | "other";

export function AddAccount({
	open,
	onOpenChange,
	onAdded,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAdded: () => void;
}) {
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [provider, setProvider] = useState<Provider>("gmail");
	const preset = provider === "other" ? undefined : providers[provider];

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Popup>
				<Dialog.Title>Add account</Dialog.Title>
				<form
					className="grid gap-3"
					onSubmit={async (e) => {
						e.preventDefault();
						const f: Record<string, string> = {
							...preset?.server,
							...(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>),
						};
						setBusy(true);
						const res = await fetch("/accounts", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								...f,
								username: f.username || f.email,
								imapPort: Number(f.imapPort),
								smtpPort: Number(f.smtpPort),
							}),
						});
						setBusy(false);
						// The engine tried to log in; its answer says what the server didn't like.
						if (res.status === 422) return setError(((await res.json()) as { error: string }).error);
						if (!res.ok) return setError("Couldn't add the account. Check the fields and try again.");
						setError("");
						onAdded();
						onOpenChange(false);
					}}
				>
					<ToggleGroup value={[provider]} onValueChange={(v) => v[0] && setProvider(v[0] as Provider)}>
						{Object.entries(providers).map(([key, p]) => (
							<Toggle key={key} value={key}>
								{p.label}
							</Toggle>
						))}
						<Toggle value="other">Other</Toggle>
					</ToggleGroup>
					{fields
						.filter((f) => !preset || f.name === "email" || f.name === "password")
						.map((f) => (
							<Field.Root key={f.name}>
								<Field.Label>{preset && f.name === "password" ? "App password" : f.label}</Field.Label>
								<Field.Control
									name={f.name}
									type={f.type}
									defaultValue={f.value}
									placeholder={f.hint}
									required={!f.optional}
								/>
								{preset && f.name === "password" && (
									<Field.Description>
										Your normal password won't work. {preset.passwordHint[0]}{" "}
										<a className="text-ink underline" href={preset.passwordUrl} target="_blank" rel="noreferrer">
											{preset.passwordHint[1]}
										</a>{" "}
										{preset.passwordHint[2]}
									</Field.Description>
								)}
							</Field.Root>
						))}
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
	);
}
