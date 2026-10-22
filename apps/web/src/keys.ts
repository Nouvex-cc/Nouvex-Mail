// SPDX-License-Identifier: AGPL-3.0-only
// The password never leaves this device: it becomes authKey, which the server takes as the password, and encKey,
// which opens the user's private key (packages/sdk/src/crypto.ts). The unlocked key stays in IndexedDB as a key the
// page can use but not read back, until signing out.
import { derive, openKey, openPrivate, unlock, wrapPrivate } from "@nouvex/sdk/crypto";
import { auth } from "./auth";
import { db } from "./db";

type Stored = { publicKey: string; wrappedPrivate: string };

const stored = async () => {
	const res = await fetch("/keys");
	if (!res.ok) throw new Error("Couldn't load your keys.");
	return (await res.json()) as Stored;
};

/** Signs in with the password; with two-factor on, the keys open after the code (open). */
export async function signIn(email: string, password: string) {
	const { authKey, encKey } = await derive(password, email);
	const res = await auth.signIn.email({ email, password: authKey });
	const twoFactor = !!res.data && "twoFactorRedirect" in res.data;
	if (!res.error && !twoFactor) await open(encKey);
	return { res, twoFactor, encKey };
}

const privateKey = async (encKey: CryptoKey, { wrappedPrivate }: Stored) =>
	openPrivate(encKey, Uint8Array.fromBase64(wrappedPrivate)).catch(() => {
		throw new Error("That's not your password.");
	});

/** Unlocks this device with the password, after signing in with a passkey or on a new browser. */
export async function open(encKey: CryptoKey) {
	const keys = await stored();
	await db.keys.put({
		id: "me",
		...(await unlock(await privateKey(encKey, keys), Uint8Array.fromBase64(keys.publicKey))),
	});
}

export const unlocked = async () => !!(await db.keys.get("me"));

/** Opens a message's own key, which opens its meta, body and attachments. */
export async function messageKey(m: { key: string }) {
	const keys = await db.keys.get("me");
	if (!keys) throw new Error("This device is locked.");
	return openKey(keys, Uint8Array.fromBase64(m.key));
}

/** What the server takes as the password, for settings that ask for it again. */
export const authKey = async (password: string, email: string) => (await derive(password, email)).authKey;

export async function changePassword(email: string, current: string, next: string) {
	const [old, fresh] = await Promise.all([derive(current, email), derive(next, email)]);
	const raw = await privateKey(old.encKey, await stored());
	const res = await fetch("/password", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			currentPassword: old.authKey,
			newPassword: fresh.authKey,
			wrappedPrivate: (await wrapPrivate(fresh.encKey, raw)).toBase64(),
		}),
	});
	if (!res.ok) throw new Error(((await res.json()) as { message: string }).message);
}

/** Signing out takes the keys and the mail stored here with it. */
export async function signOut() {
	await auth.signOut();
	await Promise.all(db.tables.map((t) => t.clear()));
	location.assign("/login");
}
