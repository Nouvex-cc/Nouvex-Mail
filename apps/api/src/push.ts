// SPDX-License-Identifier: AGPL-3.0-only
// Pushes for new mail to iPhones, through APNs. A push carries the message's sealed meta and key, nothing readable:
// the app's notification extension opens them with the user's key (apps/apple/NouvexNotify), see docs/security.md.
import { type ClientHttp2Session, connect } from "node:http2";
import type { MessageArrived } from "@nouvex/schema";
import { within } from "@nouvex/sdk/focus";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { accountGroup, accountGroupMember, device, mailAccount, message, userPrefs } from "./db/schema";
import { nats } from "./nats";

export type Device = typeof device.$inferSelect;
export type Push = { id: string; body: Record<string, unknown> };

// A push may be 4 KB. Sealed meta with long To and Cc lists is bigger; that push goes out without it.
const maxSize = 4096;

/** A group rests outside its focus times, judged on the device's clock. */
export function resting(focus: { days: number[]; from: string; to: string } | null, timeZone: string, at: Date) {
	if (!focus) return false;
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(at)
			.map((p) => [p.type, p.value]),
	);
	const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
	return !within(focus, day, Number(parts.hour) * 60 + Number(parts.minute));
}

/** The push for one message: a plain fallback, and the sealed meta for the extension if it fits. */
export function note(
	m: { id: string; threadId: string; key: Uint8Array; sealed: Uint8Array },
	account: { email: string; nickname: string },
): Push {
	const aps = {
		alert: { title: "New mail", body: account.nickname || account.email },
		sound: "default",
		"thread-id": m.threadId,
		"mutable-content": 1,
	};
	const body = { aps, m: { key: m.key.toBase64(), sealed: m.sealed.toBase64() } };
	return { id: m.id, body: JSON.stringify(body).length <= maxSize ? body : { aps } };
}

/**
 * What to push for new mail, per device: the same mail the app itself notifies about (Mail.notify): primary, and
 * updates unless categories are on; nothing for an archived or muted account, or one in a muted or resting group.
 */
export async function pushes(e: MessageArrived, at = new Date()) {
	const [account] = await db.select().from(mailAccount).where(eq(mailAccount.id, e.accountId));
	if (!account || account.archivedAt || account.muted) return [];
	const [devices, groups, [prefs], messages] = await Promise.all([
		db.select().from(device).where(eq(device.userId, account.userId)),
		db
			.select({ muted: accountGroup.muted, focus: accountGroup.focus })
			.from(accountGroup)
			.innerJoin(accountGroupMember, eq(accountGroupMember.groupId, accountGroup.id))
			.where(eq(accountGroupMember.accountId, account.id)),
		db.select().from(userPrefs).where(eq(userPrefs.userId, account.userId)),
		db
			.select({
				id: message.id,
				threadId: message.threadId,
				category: message.category,
				key: message.key,
				sealed: message.sealed,
			})
			.from(message)
			.where(and(eq(message.accountId, account.id), inArray(message.id, e.messageIds))),
	]);
	if (groups.some((g) => g.muted)) return [];
	const loud = (prefs?.prefs as { categories?: boolean } | undefined)?.categories
		? ["primary"]
		: ["primary", "updates"];
	const notes = messages.filter((m) => loud.includes(m.category)).map((m) => note(m, account));
	return devices
		.filter((d) => !groups.some((g) => resting(g.focus, d.timeZone, at)))
		.flatMap((d) => notes.map((n) => ({ device: d, push: n })));
}

/** An APNs provider token: ES256, signed with the .p8 key, good for an hour; Apple wants a new one at most every 20 minutes. */
export async function providerToken(key: CryptoKey, keyId: string, teamId: string, at = new Date()) {
	const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const input = `${part({ alg: "ES256", kid: keyId })}.${part({ iss: teamId, iat: Math.floor(at.getTime() / 1000) })}`;
	const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
	return `${input}.${Buffer.from(sig).toString("base64url")}`;
}

/**
 * Sends pushes over one HTTP/2 connection per APNs host, kept open as Apple asks. Returns APNs' status and reason;
 * a token Apple calls gone is removed.
 */
export function apns(
	key: CryptoKey,
	keyId: string,
	teamId: string,
	hosts = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" },
) {
	const sessions = new Map<string, ClientHttp2Session>();
	let token: { value: string; at: number } | undefined;
	const session = (host: string) => {
		let s = sessions.get(host);
		if (!s || s.closed || s.destroyed) {
			s = connect(host);
			s.on("error", () => sessions.delete(host));
			s.on("close", () => sessions.delete(host));
			sessions.set(host, s);
		}
		return s;
	};
	return async (d: Device, p: Push) => {
		if (!token || Date.now() - token.at > 50 * 60_000)
			token = { value: await providerToken(key, keyId, teamId), at: Date.now() };
		const req = session(d.sandbox ? hosts.sandbox : hosts.production).request({
			":method": "POST",
			":path": `/3/device/${d.token}`,
			authorization: `bearer ${token.value}`,
			// Debug builds are the .dev app.
			"apns-topic": d.sandbox ? "cc.nouvex.Nouvex.dev" : "cc.nouvex.Nouvex",
			"apns-push-type": "alert",
			"apns-priority": "10",
			// The app notifies about the same message while it runs; one replaces the other.
			"apns-collapse-id": p.id,
		});
		req.end(JSON.stringify(p.body));
		const [status, reason] = await new Promise<[number, string]>((resolve, reject) => {
			let status = 0;
			let text = "";
			req.on("response", (h) => {
				status = Number(h[":status"]);
			});
			req.setEncoding("utf8");
			req.on("data", (c: string) => {
				text += c;
			});
			req.on("end", () => resolve([status, text ? (JSON.parse(text) as { reason: string }).reason : ""]));
			req.on("error", reject);
		});
		if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered")
			await db.delete(device).where(eq(device.token, d.token));
		return { status, reason };
	};
}

/** Pushes new mail while the API runs; without APNS_KEY there are no pushes. */
export async function startPush() {
	const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID } = process.env;
	if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID) return;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		Buffer.from(
			Buffer.from(APNS_KEY, "base64")
				.toString()
				.replace(/-----[^-]+-----|\s/g, ""),
			"base64",
		),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const send = apns(key, APNS_KEY_ID, APNS_TEAM_ID);
	const { nc } = await nats();
	for await (const m of nc.subscribe("evt.message.arrived")) {
		const e = JSON.parse(m.string()) as MessageArrived;
		void pushes(e)
			.then((all) => Promise.all(all.map(({ device: d, push: p }) => send(d, p))))
			.then((results) => {
				for (const r of results) if (r.status !== 200) console.warn("push refused", r.status, r.reason);
			})
			.catch((err) => console.error("push failed", err));
	}
}
