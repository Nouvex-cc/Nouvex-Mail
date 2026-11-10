// SPDX-License-Identifier: AGPL-3.0-only
// What a domain needs in its DNS to host mail with us, checking it, and setting it up in Cloudflare with a token the
// user gives once. Nothing here is kept but the result of a check.
import { Resolver } from "node:dns/promises";

export type DnsRecord = {
	key: "verify" | "mx" | "spf" | "dkim" | "dmarc" | "bounce" | "bounceSpf";
	type: "TXT" | "MX";
	name: string;
	value: string;
	priority?: number;
};
export type Check = Record<string, { ok: boolean; found: string[] }>;

const mxHost = () => process.env.MX_HOST ?? "mx.nouvex.cc";
// One include for all our senders: SES now, our own IPs later, without customers changing anything.
const spfInclude = () => process.env.SPF_INCLUDE ?? "spf.nouvex.cc";
const sesRegion = () => process.env.SES_REGION ?? "eu-central-1";

/** Every record a domain needs, the verification first. */
export function records(d: { name: string; verifyToken: string; dkimPublic: string }): DnsRecord[] {
	return [
		{ key: "verify", type: "TXT", name: `_nouvex.${d.name}`, value: `nouvex-verify=${d.verifyToken}` },
		{ key: "mx", type: "MX", name: d.name, value: mxHost(), priority: 10 },
		{ key: "spf", type: "TXT", name: d.name, value: `v=spf1 include:${spfInclude()} ~all` },
		{ key: "dkim", type: "TXT", name: `nx1._domainkey.${d.name}`, value: `v=DKIM1; k=rsa; p=${d.dkimPublic}` },
		// Reports only, until the domain's mail is known to pass; owners tighten it themselves.
		{ key: "dmarc", type: "TXT", name: `_dmarc.${d.name}`, value: "v=DMARC1; p=none" },
		// SES's bounces come back here (custom MAIL FROM), so SPF lines up with the domain.
		{
			key: "bounce",
			type: "MX",
			name: `bounce.${d.name}`,
			value: `feedback-smtp.${sesRegion()}.amazonses.com`,
			priority: 10,
		},
		{ key: "bounceSpf", type: "TXT", name: `bounce.${d.name}`, value: "v=spf1 include:amazonses.com ~all" },
	];
}

/** A new DKIM key: the public half for DNS (base64 SPKI), the private half (base64 PKCS#8) to seal. */
export async function dkimKey() {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	return { publicKey: spki.toBase64(), privateKey: pkcs8.toBase64() };
}

export type Lookup = { txt: (name: string) => Promise<string[]>; mx: (name: string) => Promise<string[]> };

// Asked of public resolvers, so a check sees what the rest of the internet sees, not this machine's cache.
export function resolver(): Lookup {
	const r = new Resolver();
	r.setServers(["1.1.1.1", "8.8.8.8"]);
	const none = (e: { code?: string }) => {
		if (e.code === "ENOTFOUND" || e.code === "ENODATA") return [];
		throw e;
	};
	return {
		txt: (name) => r.resolveTxt(name).then((rows) => rows.map((chunks) => chunks.join("")), none),
		mx: (name) => r.resolveMx(name).then((rows) => rows.map((m) => m.exchange.toLowerCase()), none),
	};
}

const host = (h: string) => h.toLowerCase().replace(/\.$/, "");
const spaces = (s: string) => s.replace(/\s+/g, "");

/** Looks each record up and says whether it's there as needed, with what was found. */
export async function check(wanted: DnsRecord[], dns: Lookup = resolver()): Promise<Check> {
	const out: Check = {};
	for (const r of wanted) {
		const found = r.type === "MX" ? await dns.mx(r.name) : await dns.txt(r.name);
		let ok: boolean;
		if (r.type === "MX") ok = found.some((f) => host(f) === host(r.value));
		else if (r.key === "spf" || r.key === "bounceSpf") {
			// Only one SPF record counts; ours has to be included in it.
			const include = r.value.split(" ").find((p) => p.startsWith("include:")) ?? "";
			const spf = found.filter((f) => f.startsWith("v=spf1"));
			ok = spf.length === 1 && (spf[0]?.split(/\s+/).includes(include) ?? false);
		} else if (r.key === "dmarc") ok = found.some((f) => f.startsWith("v=DMARC1"));
		else ok = found.some((f) => spaces(f) === spaces(r.value));
		out[r.key] = { ok, found };
	}
	return out;
}

/** How domains reach DNS and Cloudflare; tests put fakes here. */
export const dnsDeps = { lookup: resolver, fetch: fetch as typeof fetch };

type Cf = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ success: boolean; result: unknown }>;

/** Cloudflare's API with a token. */
export function cloudflare(token: string, fetcher: typeof fetch = fetch): Cf {
	return async (path, init) => {
		const res = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
			method: init?.method ?? "GET",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: init?.body === undefined ? undefined : JSON.stringify(init.body),
		});
		return (await res.json()) as { success: boolean; result: unknown };
	};
}

type CfRecord = { id: string; type: string; name: string; content: string };
export type Applied = Record<string, "created" | "updated" | "there" | "conflict">;

/**
 * Puts the records into the domain's Cloudflare zone. What's there stays: an SPF record gets our include, and other
 * MX records are only replaced with replaceMx, since that moves where the domain's mail goes.
 */
export async function applyCloudflare(cf: Cf, domain: string, wanted: DnsRecord[], replaceMx: boolean) {
	let zone: string | undefined;
	// The zone can be a parent of the domain (mail.example.com in example.com).
	for (let name = domain; name.includes("."); name = name.slice(name.indexOf(".") + 1)) {
		const res = await cf(`/zones?name=${encodeURIComponent(name)}`);
		const found = res.success ? (res.result as { id: string }[]) : [];
		if (!res.success) throw new Error("Cloudflare didn't accept the token.");
		if (found[0]) {
			zone = found[0].id;
			break;
		}
	}
	if (!zone) throw new Error(`No Cloudflare zone for ${domain} with this token.`);
	const applied: Applied = {};
	for (const r of wanted) {
		const list = await cf(`/zones/${zone}/dns_records?type=${r.type}&name=${encodeURIComponent(r.name)}`);
		const there = (list.success ? list.result : []) as CfRecord[];
		const body = {
			type: r.type,
			name: r.name,
			content: r.value,
			ttl: 1,
			...(r.priority ? { priority: r.priority } : {}),
		};
		const create = async () => (await cf(`/zones/${zone}/dns_records`, { method: "POST", body })).success;
		if (r.type === "MX") {
			const ours = there.some((t) => host(t.content) === host(r.value));
			const others = there.filter((t) => host(t.content) !== host(r.value));
			if (others.length && !replaceMx) {
				applied[r.key] = ours ? "there" : "conflict";
				continue;
			}
			for (const o of others) await cf(`/zones/${zone}/dns_records/${o.id}`, { method: "DELETE" });
			applied[r.key] = ours ? (others.length ? "updated" : "there") : (await create()) ? "created" : "conflict";
			continue;
		}
		if (r.key === "spf" || r.key === "bounceSpf") {
			const spf = there.find((t) => t.content.replace(/^"|"$/g, "").startsWith("v=spf1"));
			const include = r.value.split(" ").find((p) => p.startsWith("include:")) ?? "";
			if (!spf) applied[r.key] = (await create()) ? "created" : "conflict";
			else if (spf.content.includes(include)) applied[r.key] = "there";
			else {
				// Ours goes right after v=spf1, before whatever ends it (~all, -all).
				const content = spf.content.replace(/^("?)v=spf1/, `$1v=spf1 ${include}`);
				const res = await cf(`/zones/${zone}/dns_records/${spf.id}`, { method: "PATCH", body: { content } });
				applied[r.key] = res.success ? "updated" : "conflict";
			}
			continue;
		}
		if (r.key === "dmarc" && there.some((t) => t.content.includes("v=DMARC1"))) {
			applied[r.key] = "there";
			continue;
		}
		if (there.some((t) => spaces(t.content.replace(/"/g, "")) === spaces(r.value))) applied[r.key] = "there";
		else applied[r.key] = (await create()) ? "created" : "conflict";
	}
	return applied;
}
