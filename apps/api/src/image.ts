// SPDX-License-Identifier: AGPL-3.0-only
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Addresses a mail must never make us fetch: our own network, cloud metadata, anything not on the public internet.
const internal = new BlockList();
for (const [net, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 3],
] as const)
	internal.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
	["::", 127],
	["64:ff9b::", 96],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	internal.addSubnet(net, bits, "ipv6");

export const isPublic = (ip: string) => !internal.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

const limit = 15 * 1024 * 1024;

/**
 * Fetches a remote image for a mail, so the sender sees our server instead of the reader's address. Returns
 * undefined for anything that isn't a public http(s) image.
 */
// ponytail: the host is resolved once for the check and again by fetch, so DNS rebinding can slip through; pin
// the checked address when fetch lets us connect to an IP while keeping the TLS name.
export async function fetchImage(url: string) {
	for (let hops = 0; hops < 5; hops++) {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return;
		}
		if (target.protocol !== "https:" && target.protocol !== "http:") return;
		const host = target.hostname.replace(/^\[|\]$/g, "");
		const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
		if (ips.length === 0 || !ips.every(isPublic)) return;

		const res = await fetch(target, {
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
			headers: { accept: "image/*", "user-agent": "Mozilla/5.0" },
		}).catch(() => undefined);
		if (!res) return;
		const next = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && next) {
			url = new URL(next, target).href;
			continue;
		}
		const type = res.headers.get("content-type") ?? "";
		if (!res.ok || !type.startsWith("image/") || Number(res.headers.get("content-length")) > limit) return;
		const body = await res.arrayBuffer().catch(() => undefined);
		if (!body || body.byteLength > limit) return;
		return { body, type };
	}
}
