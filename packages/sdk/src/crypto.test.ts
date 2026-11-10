// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
	decrypt,
	derive,
	newAccountKey,
	newKeys,
	openAccount,
	openKey,
	openPrivate,
	openSealed,
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
