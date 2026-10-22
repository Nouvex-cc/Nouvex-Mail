// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { decrypt, derive, newKeys, openKey, openPrivate, unlock, wrapPrivate } from "./crypto";
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
