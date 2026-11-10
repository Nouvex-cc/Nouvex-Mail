// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test";
import { applyCloudflare, check, dkimKey, type Lookup, records } from "./domains";

const domain = { name: "louma.test", verifyToken: "tok", dkimPublic: "PUB" };

test("a DKIM key's public half is what DNS gets", async () => {
	const k = await dkimKey();
	const pub = await crypto.subtle.importKey(
		"spki",
		Uint8Array.fromBase64(k.publicKey),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		true,
		["verify"],
	);
	expect((pub.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
	expect(k.privateKey.length).toBeGreaterThan(1000);
});

test("checks each record the way mail servers read it", async () => {
	const want = records(domain);
	const dns: Lookup = {
		txt: async (name) =>
			({
				"_nouvex.louma.test": ["nouvex-verify=tok"],
				// Someone else's SPF without ours, and a second SPF record elsewhere: neither counts.
				"louma.test": ["v=spf1 include:_spf.google.com ~all", "google-site-verification=x"],
				"nx1._domainkey.louma.test": ["v=DKIM1; k=rsa;p=PUB"],
				"_dmarc.louma.test": ["v=DMARC1; p=reject; rua=mailto:d@louma.test"],
				"bounce.louma.test": ["v=spf1 include:amazonses.com ~all"],
			})[name] ?? [],
		mx: async (name) => ({ "louma.test": ["MX.Nouvex.cc."] })[name] ?? [],
	};
	const result = await check(want, dns);
	expect(Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.ok]))).toEqual({
		verify: true,
		mx: true,
		spf: false,
		dkim: true,
		dmarc: true,
		bounce: false,
		bounceSpf: true,
	});
	expect(result.spf?.found).toContain("v=spf1 include:_spf.google.com ~all");
});

// A zone in memory, answering like Cloudflare's API.
function zone(initial: { type: string; name: string; content: string }[]) {
	const rows = initial.map((r, i) => ({ id: `r${i}`, ...r }));
	const cf = async (path: string, init?: { method?: string; body?: unknown }) => {
		const url = new URL(`https://x${path}`);
		if (url.pathname === "/zones")
			return { success: true, result: url.searchParams.get("name") === "louma.test" ? [{ id: "z" }] : [] };
		const id = url.pathname.split("/")[4];
		const body = init?.body as { type: string; name: string; content: string };
		switch (init?.method ?? "GET") {
			case "GET":
				return {
					success: true,
					result: rows.filter(
						(r) => r.type === url.searchParams.get("type") && r.name === url.searchParams.get("name"),
					),
				};
			case "POST":
				rows.push({ id: `n${rows.length}`, type: body.type, name: body.name, content: body.content });
				return { success: true, result: {} };
			case "PATCH":
				for (const r of rows) if (r.id === id) r.content = body.content;
				return { success: true, result: {} };
			default:
				rows.splice(
					rows.findIndex((r) => r.id === id),
					1,
				);
				return { success: true, result: {} };
		}
	};
	return { rows, cf };
}

test("Cloudflare: adds what's missing, joins SPF, and moves MX only when asked", async () => {
	const z = zone([
		{ type: "MX", name: "louma.test", content: "aspmx.l.google.com" },
		{ type: "TXT", name: "louma.test", content: '"v=spf1 include:_spf.google.com ~all"' },
		{ type: "TXT", name: "_dmarc.louma.test", content: "v=DMARC1; p=reject" },
	]);
	const first = await applyCloudflare(z.cf, "louma.test", records(domain), false);
	expect(first).toEqual({
		verify: "created",
		mx: "conflict",
		spf: "updated",
		dkim: "created",
		dmarc: "there",
		bounce: "created",
		bounceSpf: "created",
	});
	expect(z.rows.find((r) => r.name === "louma.test" && r.type === "TXT")?.content).toBe(
		'"v=spf1 include:spf.nouvex.cc include:_spf.google.com ~all"',
	);
	expect(z.rows.filter((r) => r.type === "MX" && r.name === "louma.test").map((r) => r.content)).toEqual([
		"aspmx.l.google.com",
	]);

	const second = await applyCloudflare(z.cf, "louma.test", records(domain), true);
	expect(second.mx).toBe("created");
	expect(second.spf).toBe("there");
	expect(z.rows.filter((r) => r.type === "MX" && r.name === "louma.test").map((r) => r.content)).toEqual([
		"mx.nouvex.cc",
	]);
	// Nothing doubled on the second run.
	expect(z.rows.filter((r) => r.name === "_nouvex.louma.test")).toHaveLength(1);
});

test("Cloudflare finds the zone above a subdomain, and says when there is none", async () => {
	const z = zone([]);
	const sub = { ...domain, name: "mail.louma.test" };
	expect((await applyCloudflare(z.cf, sub.name, records(sub), false)).verify).toBe("created");
	await expect(applyCloudflare(z.cf, "other.test", records({ ...domain, name: "other.test" }), false)).rejects.toThrow(
		"No Cloudflare zone",
	);
});
