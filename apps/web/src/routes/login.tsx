// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Field } from "@nouvex/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { auth } from "../auth";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
	const navigate = useNavigate();
	const [signUp, setSignUp] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	return (
		<main className="grid min-h-screen place-items-center p-4">
			<form
				className="grid w-full max-w-sm gap-4"
				onSubmit={async (e) => {
					e.preventDefault();
					const f = new FormData(e.currentTarget);
					const email = String(f.get("email"));
					const password = String(f.get("password"));
					setBusy(true);
					const { error } = signUp
						? await auth.signUp.email({ email, password, name: String(f.get("name")) })
						: await auth.signIn.email({ email, password });
					setBusy(false);
					if (error) return setError(error.message ?? "That didn't work.");
					navigate({ to: "/" });
				}}
			>
				<span role="img" aria-label="Nouvex" className="logo mb-4" />
				{signUp && (
					<Field.Root>
						<Field.Label>Name</Field.Label>
						<Field.Control name="name" required autoComplete="name" />
					</Field.Root>
				)}
				<Field.Root>
					<Field.Label>Email</Field.Label>
					<Field.Control name="email" type="email" required autoComplete="email" />
				</Field.Root>
				<Field.Root>
					<Field.Label>Password</Field.Label>
					<Field.Control
						name="password"
						type="password"
						required
						minLength={8}
						autoComplete={signUp ? "new-password" : "current-password"}
					/>
				</Field.Root>
				{error && <p className="text-sm text-danger">{error}</p>}
				<Button variant="primary" type="submit" loading={busy} className="justify-center">
					{signUp ? "Create account" : "Sign in"}
				</Button>
				<Button variant="ghost" className="justify-center" onClick={() => setSignUp(!signUp)}>
					{signUp ? "I already have an account" : "Create an account"}
				</Button>
			</form>
		</main>
	);
}
