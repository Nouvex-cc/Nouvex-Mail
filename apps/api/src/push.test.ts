// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, expect, test } from "bun:test";
import { createServer } from "node:http2";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { accountGroup, accountGroupMember, device, mailAccount, mailbox, message, user, userPrefs } from "./db/schema";
import { apns, note, providerToken, pushes, resting } from "./push";

const weekdays = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
const nights = { days: [5], from: "22:00", to: "06:00" };

test("focus times are judged on the device's clock", () => {
	// Monday 08:30 UTC: 09:30 in Berlin, 04:30 in New York.
	const at = new Date("2026-10-26T08:30:00Z");
	expect(resting(weekdays, "Europe/Berlin", at)).toBe(false);
	expect(resting(weekdays, "America/New_York", at)).toBe(true);
	expect(resting(null, "Europe/Berlin", at)).toBe(false);
	// Over midnight a focus time belongs to the day it starts: Friday night into Saturday.
	expect(resting(nights, "UTC", new Date("2026-10-31T03:00:00Z"))).toBe(false);
	expect(resting(nights, "UTC", new Date("2026-11-01T03:00:00Z"))).toBe(true);
});

test("a push carries only what's sealed, and leaves it out when too big", () => {
	const m = { id: "m1", threadId: "t1", key: new Uint8Array([1, 2]), sealed: new Uint8Array([3, 4]) };
	const p = note(m, { email: "lena@example.com", nickname: "" });
	expect(p.body).toEqual({
		aps: {
			alert: { title: "New mail", body: "lena@example.com" },
			sound: "default",
			"thread-id": "t1",
			"mutable-content": 1,
		},
		m: { key: "AQI=", sealed: "AwQ=" },
	});
	const big = note({ ...m, sealed: new Uint8Array(4000) }, { email: "lena@example.com", nickname: "Work" });
	expect(big.body).not.toHaveProperty("m");
	expect(JSON.stringify(big.body)).toContain("Work");
});

test("the provider token verifies with the key's public half", async () => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const token = await providerToken(pair.privateKey, "KEY123", "TEAM456", new Date("2026-10-26T08:00:00Z"));
	const [h, c, sig] = token.split(".") as [string, string, string];
	expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
	expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "TEAM456", iat: 1793001600 });
	const ok = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		pair.publicKey,
		Buffer.from(sig, "base64url"),
		new TextEncoder().encode(`${h}.${c}`),
	);
	expect(ok).toBe(true);
});

// Needs a migrated database (docker compose up -d postgres && bun run db:migrate).
const withDb = test.skipIf(!process.env.DATABASE_URL);
const made: string[] = [];
afterAll(async () => {
	for (const id of made) await db.delete(user).where(eq(user.id, id));
});

async function mailboxOf(categories?: boolean) {
	const id = crypto.randomUUID();
	made.push(id);
	await db.insert(user).values({ id, name: "Lena", email: `${id}@test.dev`, createdAt: new Date() });
	if (categories !== undefined) await db.insert(userPrefs).values({ userId: id, prefs: { categories } });
	await db.insert(mailAccount).values({
		id,
		userId: id,
		email: "lena@example.com",
		imapHost: "x",
		imapPort: 993,
		smtpHost: "x",
		smtpPort: 465,
		username: "x",
		secret: new Uint8Array(1),
	});
	await db.insert(mailbox).values({ id, accountId: id, name: "INBOX", role: "inbox", uidValidity: 1 });
	const mail = async (n: number, category: "primary" | "updates" | "promotions") => {
		await db.insert(message).values({
			id: `${id}-${n}`,
			accountId: id,
			mailboxId: id,
			uid: n,
			messageId: `hash-${n}`,
			sentAt: new Date(),
			flags: [],
			size: 10,
			category,
			threadId: `t-${n}`,
			key: new Uint8Array([n]),
			sealed: new Uint8Array([n, n]),
		});
		return `${id}-${n}`;
	};
	const phone = async (timeZone = "Europe/Berlin", sandbox = false) => {
		const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
		await db.insert(device).values({ token, userId: id, sandbox, timeZone });
		return token;
	};
	return { id, mail, phone };
}

withDb("new mail is pushed the way the app would notify about it", async () => {
	const at = new Date("2026-10-26T08:30:00Z");
	const lena = await mailboxOf();
	const berlin = await lena.phone("Europe/Berlin");
	const [primary, updates] = [await lena.mail(1, "primary"), await lena.mail(2, "updates")];
	const ids = [primary, updates, await lena.mail(3, "promotions")];
	const got = await pushes({ accountId: lena.id, messageIds: ids }, at);
	expect(got.map((p) => [p.device.token, p.push.id])).toEqual([
		[berlin, primary],
		[berlin, updates],
	]);

	// With categories on only Primary rings.
	const max = await mailboxOf(true);
	await max.phone();
	const only = await pushes(
		{ accountId: max.id, messageIds: [await max.mail(1, "primary"), await max.mail(2, "updates")] },
		at,
	);
	expect(only.map((p) => p.push.id)).toEqual([`${max.id}-1`]);

	// A group resting on one phone's clock is quiet there only.
	const g = crypto.randomUUID();
	await db.insert(accountGroup).values({ id: g, userId: lena.id, name: "Work", focus: weekdays });
	await db.insert(accountGroupMember).values({ groupId: g, accountId: lena.id });
	await lena.phone("America/New_York");
	const focused = await pushes({ accountId: lena.id, messageIds: [primary] }, at);
	expect(focused.map((p) => p.device.token)).toEqual([berlin]);

	await db.update(accountGroup).set({ muted: true }).where(eq(accountGroup.id, g));
	expect(await pushes({ accountId: lena.id, messageIds: ids }, at)).toEqual([]);
	await db.update(accountGroup).set({ muted: false }).where(eq(accountGroup.id, g));
	await db.update(mailAccount).set({ muted: true }).where(eq(mailAccount.id, lena.id));
	expect(await pushes({ accountId: lena.id, messageIds: ids }, at)).toEqual([]);
});

withDb("pushes go to APNs over HTTP/2, and a token Apple calls gone is dropped", async () => {
	const seen: { headers: Record<string, unknown>; body: string }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			seen.push({ headers: req.headers, body });
			const gone = String(req.headers[":path"]).endsWith("dead");
			res.writeHead(gone ? 410 : 200, { "content-type": "application/json" });
			res.end(gone ? JSON.stringify({ reason: "Unregistered" }) : "");
		});
	});
	await new Promise<void>((r) => server.listen(0, r));
	const host = `http://localhost:${(server.address() as { port: number }).port}`;
	try {
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
		const send = apns(pair.privateKey, "KEY123", "TEAM456", { production: host, sandbox: host });
		const lena = await mailboxOf();
		const live = await lena.phone();
		const dead = `${crypto.randomUUID().replaceAll("-", "")}dead`;
		await db.insert(device).values({ token: dead, userId: lena.id, sandbox: true, timeZone: "UTC" });
		const devices = await db.select().from(device).where(eq(device.userId, lena.id));
		const push = note(
			{ id: "m1", threadId: "t1", key: new Uint8Array([1]), sealed: new Uint8Array([2]) },
			{
				email: "lena@example.com",
				nickname: "",
			},
		);
		const results = await Promise.all(devices.map((d) => send(d, push)));
		expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
		const live1 = seen.find((s) => String(s.headers[":path"]).endsWith(live));
		expect(live1?.headers).toMatchObject({
			"apns-topic": "cc.nouvex.Nouvex",
			"apns-push-type": "alert",
			"apns-collapse-id": "m1",
		});
		expect(String(live1?.headers.authorization)).toStartWith("bearer ");
		expect(JSON.parse(live1?.body ?? "")).toEqual(push.body);
		expect(seen.find((s) => String(s.headers[":path"]).endsWith("dead"))?.headers["apns-topic"]).toBe(
			"cc.nouvex.Nouvex.dev",
		);
		const left = await db.select({ token: device.token }).from(device).where(eq(device.userId, lena.id));
		expect(left.map((d) => d.token)).toEqual([live]);
	} finally {
		server.close();
	}
});
