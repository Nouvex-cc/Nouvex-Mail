// SPDX-License-Identifier: AGPL-3.0-only
// The password never leaves this device: it becomes authKey, which the server takes as the password, and encKey,
// which opens the user's private key (packages/sdk/src/crypto.ts). The unlocked key stays in IndexedDB until signing
// out, sealed with a key of this device's that the page can use but not read back: Safari can't keep an X25519 key
// there itself.
import {
	decrypt,
	derive,
	encrypt,
	type Keys,
	newAccountKey,
	openAccount,
	openKey,
	openPrivate,
	unlock,
	wrapPrivate,
} from "@nouvex/sdk/crypto";
import type { Account } from "./accounts";
import { auth } from "./auth";
import { type Device, db } from "./db";

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

const deviceLabel = "nouvex device key";

/** Unlocks this device with the password, after signing in with a passkey, on a new browser or right after picking it. */
export async function open(encKey: CryptoKey) {
	const keys = await stored();
	const raw = await privateKey(encKey, keys);
	const deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
	const device: Device & { id: "me" } = {
		id: "me",
		publicKey: Uint8Array.fromBase64(keys.publicKey),
		deviceKey,
		sealed: await encrypt(deviceKey, deviceLabel, raw),
	};
	await db.keys.put(device);
	opened = undefined;
}

export const unlocked = async () => !!(await db.keys.get("me"));

// Opened once per page load. Devices unlocked before keep the key itself.
let opened: Promise<Keys> | undefined;
async function load() {
	const k = await db.keys.get("me");
	if (!k) throw new Error("This device is locked.");
	return "sealed" in k ? unlock(await decrypt(k.deviceKey, deviceLabel, k.sealed), k.publicKey) : k;
}
function keys() {
	opened ??= load().catch((e) => {
		opened = undefined;
		throw e;
	});
	return opened;
}

/** Forgets the key opened for this page, so the next use reads the one stored now, e.g. after a reset in another tab. */
export const reload = () => {
	opened = undefined;
	accounts = undefined;
};

// Each account's keys: none for one synced from a mail server, whose mail is sealed to the user; a hosted account's
// own key versions, newest first, opened from what was wrapped for this user. Loaded once per page, and again for an
// account it doesn't know yet.
let accounts: Promise<Map<string, Keys[]>> | undefined;
async function loadAccounts() {
	const me = await keys();
	const list = (await (await fetch("/accounts")).json()) as Account[];
	const out = new Map<string, Keys[]>();
	for (const a of list) {
		const grants = a.kind === "hosted" ? a.keys : [];
		out.set(
			a.id,
			await Promise.all(
				grants.map((k) => openAccount(me, Uint8Array.fromBase64(k.publicKey), Uint8Array.fromBase64(k.wrappedKey))),
			),
		);
	}
	return out;
}
async function accountKeys(accountId: string) {
	for (const fresh of [false, true]) {
		if (fresh) accounts = undefined;
		accounts ??= loadAccounts().catch((e) => {
			accounts = undefined;
			throw e;
		});
		const own = (await accounts).get(accountId);
		if (own) return own;
	}
	return [];
}

/** Opens a message's own key, which opens its meta, body and attachments. */
export async function messageKey(m: { key: string; accountId: string }) {
	const sealed = Uint8Array.fromBase64(m.key);
	const own = await accountKeys(m.accountId);
	// Sealed to whichever version was newest then; a wrong one fails cleanly.
	for (const k of own.slice(0, -1)) {
		const key = await openKey(k, sealed).catch(() => undefined);
		if (key) return key;
	}
	return openKey(own.at(-1) ?? (await keys()), sealed);
}

/** Makes a mailbox we host: its key pair is made here, its private half wrapped for this user only. */
export async function createMailbox(email: string, displayName: string) {
	const me = await keys();
	const { publicKey, wrapped } = await newAccountKey(me.publicKey);
	const res = await fetch("/hosted-accounts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, displayName, publicKey: publicKey.toBase64(), wrappedKey: wrapped.toBase64() }),
	});
	accounts = undefined;
	return res;
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
