// SPDX-License-Identifier: AGPL-3.0-only

import { derive } from "@nouvex/sdk/crypto";
import { Button, Field } from "@nouvex/ui";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { session } from "../auth";
import { open, signOut } from "../keys";

// After a passkey, or in a browser that hasn't seen the password yet: mail is stored encrypted, and only the password
// opens the key to it.
export const Route = createFileRoute("/unlock")({
	beforeLoad: async () => {
		const { data } = await session();
		if (!data) throw redirect({ to: "/login" });
		return { email: data.user.email };
	},
	component: Unlock,
});

function Unlock() {
	const { email } = Route.useRouteContext();
	const navigate = useNavigate();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	return (
		<main className="grid min-h-screen place-items-center p-4">
			<form
				className="grid w-full max-w-sm gap-4"
				onSubmit={async (e) => {
					e.preventDefault();
					setBusy(true);
					try {
						await open((await derive(String(new FormData(e.currentTarget).get("password")), email)).encKey);
						navigate({ to: "/" });
					} catch (e) {
						setError((e as Error).message);
						setBusy(false);
					}
				}}
			>
				<span role="img" aria-label="Nouvex" className="logo mb-4" />
				<p className="text-sm text-muted">
					Your mail is stored encrypted. Enter your password once to open it on this device.
				</p>
				<Field.Root>
					<Field.Label>Password for {email}</Field.Label>
					<Field.Control name="password" type="password" required autoFocus autoComplete="current-password" />
				</Field.Root>
				{error && <p className="text-sm text-danger">{error}</p>}
				<Button variant="primary" type="submit" loading={busy} className="justify-center">
					Unlock
				</Button>
				<Button variant="ghost" className="justify-center" onClick={signOut}>
					Sign out
				</Button>
			</form>
		</main>
	);
}
