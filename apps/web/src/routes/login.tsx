// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Field, OTPField } from "@nouvex/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { auth } from "../auth";
import { open, signIn } from "../keys";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
	const navigate = useNavigate();
	// With two-factor on, the password only gets as far as asking for the code.
	const [code, setCode] = useState<"app" | "backup">();
	// Kept from the password until the code is in, to unlock the keys then.
	const [encKey, setEncKey] = useState<CryptoKey>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const codeForm = useRef<HTMLFormElement>(null);
	useEffect(() => {
		if (code) codeForm.current?.querySelector("input")?.focus();
	}, [code]);
	const done = async (res: { error: { message?: string } | null }) => {
		if (!res.error && encKey) await open(encKey).catch((e: Error) => setError(e.message));
		setBusy(false);
		if (res.error) return setError(res.error.message ?? "That didn't work.");
		navigate({ to: "/" });
	};

	if (code)
		return (
			<main className="grid min-h-screen place-items-center p-4">
				<form
					ref={codeForm}
					className="grid w-full max-w-sm gap-4"
					onSubmit={async (e) => {
						e.preventDefault();
						const value = String(new FormData(e.currentTarget).get("code"));
						setBusy(true);
						await done(
							code === "app"
								? await auth.twoFactor.verifyTotp({ code: value, trustDevice: true })
								: await auth.twoFactor.verifyBackupCode({ code: value, trustDevice: true }),
						);
					}}
				>
					<span role="img" aria-label="Nouvex" className="logo mb-4" />
					{code === "app" ? (
						<Field.Root>
							<Field.Label>Code from your authenticator app</Field.Label>
							<OTPField name="code" onValueComplete={() => codeForm.current?.requestSubmit()} />
						</Field.Root>
					) : (
						<Field.Root>
							<Field.Label>Backup code</Field.Label>
							<Field.Control name="code" required autoFocus autoComplete="one-time-code" />
						</Field.Root>
					)}
					{error && <p className="text-sm text-danger">{error}</p>}
					<Button variant="primary" type="submit" loading={busy} className="justify-center">
						Sign in
					</Button>
					<Button
						variant="ghost"
						className="justify-center"
						onClick={() => {
							setError("");
							setCode(code === "app" ? "backup" : "app");
						}}
					>
						{code === "app" ? "Use a backup code" : "Use the authenticator app"}
					</Button>
				</form>
			</main>
		);

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
					const { res, twoFactor, encKey } = await signIn(email, password).catch((e: Error) => ({
						res: { error: { message: e.message } },
						twoFactor: false,
						encKey: undefined,
					}));
					if (twoFactor) {
						setEncKey(encKey);
						setBusy(false);
						setError("");
						return setCode("app");
					}
					setBusy(false);
					if (res.error) return setError(res.error.message ?? "That didn't work.");
					navigate({ to: "/" });
				}}
			>
				<span role="img" aria-label="Nouvex" className="logo mb-4" />
				<Field.Root>
					<Field.Label>Email</Field.Label>
					<Field.Control name="email" type="email" required autoComplete="email webauthn" />
				</Field.Root>
				<Field.Root>
					<Field.Label>Password</Field.Label>
					<Field.Control name="password" type="password" required minLength={8} autoComplete="current-password" />
				</Field.Root>
				{error && <p className="text-sm text-danger">{error}</p>}
				<Button variant="primary" type="submit" loading={busy} className="justify-center">
					Sign in
				</Button>
				<Button
					variant="ghost"
					className="justify-center"
					onClick={async () => {
						const res = await auth.signIn.passkey();
						if (!res?.error) return navigate({ to: "/" });
						// Closing the browser's passkey sheet isn't worth an error.
						if (!("code" in res.error && res.error.code === "AUTH_CANCELLED"))
							setError(res.error.message ?? "That didn't work.");
					}}
				>
					Sign in with a passkey
				</Button>
				{/* Accounts are added on the server (apps/api/src/user.ts), so there's nothing to sign up for here. */}
				<p className="text-center text-sm text-muted">No account yet? Ask whoever runs this server.</p>
			</form>
		</main>
	);
}
