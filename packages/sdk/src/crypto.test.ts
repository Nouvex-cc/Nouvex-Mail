// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
	decrypt,
	derive,
	newAccountKey,
	newKeys,
	newRecoveryKey,
	openAccount,
	openKey,
	openPrivate,
	openRecovery,
	openSealed,
	rewrapAccount,
	sealRecovery,
	sealTo,
	unlock,
	wrapPrivate,
} from "./crypto";
import fixture from "./crypto.fixture.json";

// Sealed by the engine (engine/internal/seal), so this checks the two sides agree.
test("opens what the engine sealed", async () => {
	const { authKey, encKey } = await derive(fixture.password, fixture.email);
	expect(authKey).toBe(fixture.authKey);
	const publicKey = Uint8Array.fromBase64(fixture.publicKey);
	const keys = await unlock(await openPrivate(encKey, Uint8Array.fromBase64(fixture.wrappedPrivate)), publicKey);
	const key = await openKey(keys, Uint8Array.fromBase64(fixture.messageKey));
	expect(new TextDecoder().decode(await decrypt(key, "meta", Uint8Array.fromBase64(fixture.meta)))).toBe(fixture.plain);
	await expect(decrypt(key, "body", Uint8Array.fromBase64(fixture.meta))).rejects.toThrow();
});

test("a new password keeps the same key", async () => {
	const old = await derive("first password", "a@b.c");
	const made = await newKeys(old.encKey);
	const next = await derive("second password", "a@b.c");
	const moved = await wrapPrivate(next.encKey, await openPrivate(old.encKey, made.wrappedPrivate));
	expect(await openPrivate(next.encKey, moved)).toEqual(await openPrivate(old.encKey, made.wrappedPrivate));
	await expect(openPrivate(old.encKey, moved)).rejects.toThrow();
});

test("a hosted account's key opens for its owner, and only under its own label", async () => {
	const owner = await newKeys((await derive("pw", "a@b.c")).encKey);
	const account = await newAccountKey(owner.publicKey);
	const keys = await openAccount(owner.keys, account.publicKey, account.wrapped);
	expect(keys.publicKey).toEqual(account.publicKey);
	// What is sealed to the account opens with the keys its owner unwrapped.
	const sealed = await sealTo(account.publicKey, new Uint8Array([1, 2, 3]), "test");
	expect(await openSealed(keys, sealed, "test")).toEqual(new Uint8Array([1, 2, 3]));
	await expect(openSealed(keys, sealed, "nouvex message key")).rejects.toThrow();
	await expect(openKey(owner.keys, account.wrapped)).rejects.toThrow();
});

test("a shared hosted account opens for the one it was shared with, as it does for its owner", async () => {
	const owner = await newKeys((await derive("pw", "a@b.c")).encKey);
	const member = await newKeys((await derive("pw", "m@b.c")).encKey);
	const account = await newAccountKey(owner.publicKey);
	const theirs = await rewrapAccount(owner.keys, account.wrapped, member.publicKey);
	const sealed = await sealTo(account.publicKey, new Uint8Array([4, 2]), "test");
	expect(await openSealed(await openAccount(member.keys, account.publicKey, theirs), sealed, "test")).toEqual(
		new Uint8Array([4, 2]),
	);
	await expect(openAccount(owner.keys, account.publicKey, theirs)).rejects.toThrow();
});

test("a recovery key opens the private key again, typed loosely", async () => {
	const made = await newKeys((await derive("pw", "a@b.c")).encKey);
	const raw = await openPrivate((await derive("pw", "a@b.c")).encKey, made.wrappedPrivate);
	const recovery = newRecoveryKey();
	expect(recovery).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
	const wrapped = await sealRecovery(recovery, raw);
	expect(await openRecovery(` ${recovery.toLowerCase().replaceAll("-", " ")} `, wrapped)).toEqual(raw);
	await expect(openRecovery(newRecoveryKey(), wrapped)).rejects.toThrow();
	await expect(openRecovery("too short", wrapped)).rejects.toThrow("That's not a recovery key.");
});
