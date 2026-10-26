// SPDX-License-Identifier: AGPL-3.0-only
// Envelope encryption: each secret gets its own data key, and only that key is encrypted with the master key
// (SECRETS_KEY, base64, 32 bytes). Layout: 0x01 | nonce | sealed data key | nonce | sealed secret, AES-256-GCM.
// engine/internal/secret opens it.
const gcm = (raw: Uint8Array<ArrayBuffer>, use: KeyUsage) =>
	crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);

async function encrypt(raw: Uint8Array<ArrayBuffer>, plain: Uint8Array<ArrayBuffer>) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await gcm(raw, "encrypt"), plain);
	return [iv, new Uint8Array(sealed)];
}

export async function seal(
	secret: string,
	master = new Uint8Array(Buffer.from(process.env.SECRETS_KEY ?? "", "base64")),
) {
	if (master.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64");
	const dataKey = crypto.getRandomValues(new Uint8Array(32));
	const parts = [...(await encrypt(master, dataKey)), ...(await encrypt(dataKey, new TextEncoder().encode(secret)))];
	return Buffer.concat([Uint8Array.of(1), ...parts]);
}

/** Opens what seal, or the engine (engine/internal/secret.Seal), sealed. */
export async function open(
	sealed: Uint8Array<ArrayBuffer>,
	master = new Uint8Array(Buffer.from(process.env.SECRETS_KEY ?? "", "base64")),
) {
	const decrypt = async (raw: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) =>
		new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await gcm(raw, "decrypt"), data));
	if (sealed[0] !== 1) throw new Error("unknown secret format");
	const dataKey = await decrypt(master, sealed.slice(1, 13), sealed.slice(13, 61));
	return new TextDecoder().decode(await decrypt(dataKey, sealed.slice(61, 73), sealed.slice(73)));
}
