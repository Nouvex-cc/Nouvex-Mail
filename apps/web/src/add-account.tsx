// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Dialog, Field } from "@nouvex/ui";
import { useState } from "react";

const fields = [
	{ name: "email", label: "Email", type: "email" },
	{ name: "password", label: "Password", type: "password" },
	{ name: "username", label: "Username", hint: "Usually your email address" },
	{ name: "imapHost", label: "IMAP server", hint: "e.g. imap.example.com" },
	{ name: "imapPort", label: "IMAP port", type: "number", value: "993" },
	{ name: "smtpHost", label: "SMTP server", hint: "e.g. smtp.example.com" },
	{ name: "smtpPort", label: "SMTP port", type: "number", value: "465" },
];

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

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Popup>
				<Dialog.Title>Add account</Dialog.Title>
				<form
					className="grid gap-3"
					onSubmit={async (e) => {
						e.preventDefault();
						const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
						setBusy(true);
						const res = await fetch("/accounts", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ ...f, imapPort: Number(f.imapPort), smtpPort: Number(f.smtpPort) }),
						});
						setBusy(false);
						if (!res.ok) return setError("Couldn't add the account. Check the fields and try again.");
						setError("");
						onAdded();
						onOpenChange(false);
					}}
				>
					{fields.map((f) => (
						<Field.Root key={f.name}>
							<Field.Label>{f.label}</Field.Label>
							<Field.Control name={f.name} type={f.type} defaultValue={f.value} placeholder={f.hint} required />
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
