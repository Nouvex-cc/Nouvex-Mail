// SPDX-License-Identifier: Apache-2.0
// Mail is stored encrypted for its owner (engine/internal/seal). This is the client half, on WebCrypto only:
// - The password never leaves the device. PBKDF2 turns it into authKey, the only thing the server sees (it hashes
//   that again), and encKey, which wraps the user's X25519 private key.
// - Each message has its own AES-256-GCM key, sealed to the user's public key with HPKE (RFC 9180, DHKEM-X25519,
//   HKDF-SHA256, AES-256-GCM). WebCrypto has no HPKE, so its single-shot open is written out below.

const subtle = globalThis.crypto.subtle;
type Bytes = Uint8Array<ArrayBuffer>;
const text = new TextEncoder();
const empty = new Uint8Array();

export const privateLabel = "nouvex private key";
const info = text.encode("nouvex message key");

const url = { alphabet: "base64url", omitPadding: true } as const;

const cat = (...parts: (Uint8Array | number[])[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

const aes = (raw: Bytes) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** authKey goes to the server as the password; encKey stays here. */
export async function derive(password: string, email: string) {
	const pw = await subtle.importKey("raw", text.encode(password), "PBKDF2", false, ["deriveBits"]);
	const salt = text.encode(`nouvex/${email.toLowerCase()}`);
	const master = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 }, pw, 256);
	const hkdf = await subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
	const part = async (label: string) =>
		new Uint8Array(
			await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: empty, info: text.encode(label) }, hkdf, 256),
		);
	return { authKey: (await part("nouvex auth")).toBase64(url), encKey: await aes(await part("nouvex enc")) };
}

/** AES-256-GCM with the nonce in front; the label is the associated data, as in the engine. */
export async function encrypt(key: CryptoKey, label: string, plain: Bytes) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(label) }, key, plain);
	return cat(iv, new Uint8Array(sealed));
}

export async function decrypt(key: CryptoKey, label: string, sealed: Bytes) {
	const params = { name: "AES-GCM", iv: sealed.subarray(0, 12), additionalData: text.encode(label) };
	return new Uint8Array(await subtle.decrypt(params, key, sealed.subarray(12)));
}

export type Keys = { publicKey: Bytes; privateKey: CryptoKey };

/** A new key pair, with the private half wrapped for the server to keep. */
export async function newKeys(encKey: CryptoKey) {
	const pair = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
	const jwk = await subtle.exportKey("jwk", pair.privateKey);
	const raw = Uint8Array.fromBase64(jwk.d ?? "", url);
	const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
	return { publicKey, wrappedPrivate: await encrypt(encKey, privateLabel, raw), keys: await unlock(raw, publicKey) };
}

/** The raw private key, for unlocking or wrapping again under a new password. */
export const openPrivate = (encKey: CryptoKey, wrapped: Bytes) => decrypt(encKey, privateLabel, wrapped);
export const wrapPrivate = (encKey: CryptoKey, raw: Bytes) => encrypt(encKey, privateLabel, raw);

/** The private key as a CryptoKey that can't be read back out, safe to keep in IndexedDB. */
export async function unlock(raw: Bytes, publicKey: Bytes): Promise<Keys> {
	const jwk = { kty: "OKP", crv: "X25519", d: raw.toBase64(url), x: publicKey.toBase64(url) };
	return { publicKey, privateKey: await subtle.importKey("jwk", jwk, { name: "X25519" }, false, ["deriveBits"]) };
}

// RFC 9180 section 4 and 5.1, base mode, with KEM 0x0020, KDF 0x0001 and AEAD 0x0002.
const kemSuite = cat(text.encode("KEM"), [0, 0x20]);
const hpkeSuite = cat(text.encode("HPKE"), [0, 0x20, 0, 1, 0, 2]);

async function hmac(key: Bytes, data: Bytes) {
	// An empty HMAC key is the same as one of zeros, and WebCrypto won't take an empty one.
	const k = await subtle.importKey(
		"raw",
		key.length ? key : new Uint8Array(32),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await subtle.sign("HMAC", k, data));
}

const extract = (suite: Bytes, salt: Bytes, label: string, ikm: Bytes) =>
	hmac(salt, cat(text.encode("HPKE-v1"), suite, text.encode(label), ikm));

// Every length here fits in one SHA-256 block.
const expand = async (suite: Bytes, prk: Bytes, label: string, ctx: Bytes, length: number) =>
	(await hmac(prk, cat([0, length], text.encode("HPKE-v1"), suite, text.encode(label), ctx, [1]))).slice(0, length);

/** Opens a message's key, sealed by the engine to this user. */
export async function openKey({ publicKey, privateKey }: Keys, sealed: Bytes) {
	const enc = sealed.subarray(0, 32);
	const ephemeral = await subtle.importKey("raw", enc, { name: "X25519" }, false, []);
	const dh = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: ephemeral }, privateKey, 256));
	const shared = await expand(
		kemSuite,
		await extract(kemSuite, empty, "eae_prk", dh),
		"shared_secret",
		cat(enc, publicKey),
		32,
	);
	const ctx = cat(
		[0],
		await extract(hpkeSuite, empty, "psk_id_hash", empty),
		await extract(hpkeSuite, empty, "info_hash", info),
	);
	const secret = await extract(hpkeSuite, shared, "secret", empty);
	const key = await aes(await expand(hpkeSuite, secret, "key", ctx, 32));
	const iv = await expand(hpkeSuite, secret, "base_nonce", ctx, 12);
	return aes(new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, sealed.subarray(32))));
}
