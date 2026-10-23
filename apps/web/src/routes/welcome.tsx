// SPDX-License-Identifier: AGPL-3.0-only

import { derive, newKeys } from "@nouvex/sdk/crypto";
import { Button, Field } from "@nouvex/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { auth } from "../auth";
import { open } from "../keys";

// The link from apps/api/src/user.ts. The password is picked here and stays here: the server gets authKey and the
// private key wrapped with it, so nobody running the server ever knows either.
export const Route = createFileRoute("/welcome")({ component: Welcome });

function Welcome() {
	const navigate = useNavigate();
	const token = location.hash.slice(1);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const link = useQuery({
		queryKey: ["welcome", token],
		queryFn: async () => {
			const res = await fetch(`/invites/${token}`);
			return res.ok ? ((await res.json()) as { email: string }) : null;
		},
	});
	const email = link.data?.email;

	return (
		<main className="grid min-h-screen place-items-center p-4">
			{link.data === null ? (
				<p className="text-sm text-muted">This link has been used or is too old. Ask for a new one.</p>
			) : (
				<form
					className="grid w-full max-w-sm gap-4"
					onSubmit={async (e) => {
						e.preventDefault();
						const f = new FormData(e.currentTarget);
						const password = String(f.get("password"));
						if (!email) return;
						if (password !== f.get("again")) return setError("The two passwords differ.");
						setBusy(true);
						const { authKey, encKey } = await derive(password, email);
						const made = await newKeys(encKey);
						const res = await fetch(`/invites/${token}`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								password: authKey,
								publicKey: made.publicKey.toBase64(),
								wrappedPrivate: made.wrappedPrivate.toBase64(),
							}),
						});
						if (!res.ok) {
							setBusy(false);
							return setError("This link has been used or is too old. Ask for a new one.");
						}
						await auth.signIn.email({ email, password: authKey });
						await open(encKey);
						navigate({ to: "/" });
					}}
				>
					<span role="img" aria-label="Nouvex" className="logo mb-4" />
					<p className="text-sm text-muted">
						Pick a password for {email}. It never leaves this device, so nobody running the server can read your mail.
						If you forget it, your mail is fetched again from your mailboxes.
					</p>
					<Field.Root>
						<Field.Label>Password</Field.Label>
						<Field.Control
							name="password"
							type="password"
							required
							minLength={8}
							autoFocus
							autoComplete="new-password"
						/>
					</Field.Root>
					<Field.Root>
						<Field.Label>Once more</Field.Label>
						<Field.Control name="again" type="password" required minLength={8} autoComplete="new-password" />
					</Field.Root>
					{error && <p className="text-sm text-danger">{error}</p>}
					<Button variant="primary" type="submit" loading={busy} disabled={!email} className="justify-center">
						Set password
					</Button>
				</form>
			)}
		</main>
	);
}
