// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test";
import { app } from "./app";

const keys = { publicKey: btoa("public"), wrappedPrivate: btoa("wrapped") };
const welcome = (link: string, password: string) =>
	app.request(`/invites/${link.split("#")[1]}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password, ...keys }),
	});

// Someone signed in, added the way src/user.ts adds people: a link, where they pick their password.
async function signedIn(name: string) {
	const { auth } = await import("./auth");
	const { addUser } = await import("./user");
	const email = `${crypto.randomUUID()}@test.dev`;
	const { user, link } = await addUser(email, name);
	await welcome(link, "correct-horse-9");
	const res = await auth.api.signInEmail({ body: { email, password: "correct-horse-9" }, asResponse: true });
	return { id: user.id, email, cookie: res.headers.getSetCookie().join("; ") };
}

test("health", async () => {
	const res = await app.request("/health");
	expect(await res.json()).toEqual({ ok: true });
});

test("accounts need a session", async () => {
	const res = await app.request("/accounts", { method: "POST" });
	expect(res.status).toBe(401);
});

// Needs a migrated database (docker compose up -d postgres && bun run db:migrate).
test.skipIf(!process.env.DATABASE_URL)("changes page through the change log", async () => {
	const { db } = await import("./db");
	const { changeLog, mailAccount, mailbox, message, user } = await import("./db/schema");
	const { eq } = await import("drizzle-orm");

	const me = await signedIn("Lena");
	const { email } = me;
	const headers = { cookie: me.cookie };
	const id = crypto.randomUUID();
	try {
		await db.insert(mailAccount).values({
			id,
			userId: me.id,
			email,
			imapHost: "x",
			imapPort: 993,
			smtpHost: "x",
			smtpPort: 465,
			username: "x",
			secret: new Uint8Array(1),
			version: 4,
		});
		await db.insert(mailbox).values({ id: `${id}-in`, accountId: id, name: "INBOX", role: "inbox", uidValidity: 1 });
		const row = (n: number) => ({
			id: `${id}-${n}`,
			accountId: id,
			mailboxId: `${id}-in`,
			uid: n,
			messageId: `hash-${n}`,
			sentAt: new Date("2026-10-08T07:12:00Z"),
			flags: [],
			size: 10,
			key: new Uint8Array([n]),
			sealed: new Uint8Array([n, n]),
		});
		await db.insert(message).values([row(1), row(2)]);
		await db.insert(changeLog).values([
			{ accountId: id, version: 1, entity: "message", entityId: `${id}-1`, op: "upsert" },
			{ accountId: id, version: 2, entity: "message", entityId: `${id}-2`, op: "upsert" },
			{ accountId: id, version: 3, entity: "message", entityId: `${id}-1`, op: "delete" },
			{ accountId: id, version: 4, entity: "mailbox", entityId: `${id}-in`, op: "upsert" },
		]);

		const get = async (q: string) => (await app.request(`/accounts/${id}/changes?${q}`, { headers })).json();
		const first = await get("since=0&limit=2");
		expect(first).toMatchObject({ version: 2, more: true, messages: { deleted: [] } });
		// Only what the engine sealed goes out, and nothing of the headers.
		expect(first.messages.upserted.map((m: { sealed: string }) => m.sealed).sort()).toEqual([
			btoa("\x01\x01"),
			btoa("\x02\x02"),
		]);
		expect(first.messages.upserted[0]).not.toHaveProperty("messageId");
		expect(await get("since=2")).toEqual({
			version: 4,
			more: false,
			mailboxes: { upserted: [{ id: `${id}-in`, name: "INBOX", role: "inbox" }], deleted: [] },
			messages: { upserted: [], deleted: [`${id}-1`] },
		});
		// Mail 1 was upserted and deleted within one page: only the delete remains.
		expect((await get("since=0")).messages).toMatchObject({ deleted: [`${id}-1`] });
		expect(await get("since=4")).toEqual({
			version: 4,
			more: false,
			mailboxes: { upserted: [], deleted: [] },
			messages: { upserted: [], deleted: [] },
		});

		const other = await app.request(`/accounts/${crypto.randomUUID()}/changes?since=0`, { headers });
		expect(other.status).toBe(404);

		const { s3 } = await import("bun");
		await s3.file(`body/${id}-2.html`).write("sealed");
		const body = await app.request(`/accounts/${id}/messages/${id}-2/body`, { headers });
		expect(await body.json()).toEqual({ sealed: btoa("sealed") });
		expect((await app.request(`/accounts/${id}/messages/nope/body`, { headers })).status).toBe(404);
		await s3.file(`body/${id}-2.html`).delete();

		await s3.file(`att/${id}-2/0`).write("sealed");
		const att = await app.request(`/accounts/${id}/messages/${id}-2/attachments/0`, { headers });
		expect(await att.text()).toBe("sealed");
		expect(att.headers.get("content-type")).toBe("application/octet-stream");
		expect((await app.request(`/accounts/${id}/messages/${id}-2/attachments/1`, { headers })).status).toBe(404);
		await s3.file(`att/${id}-2/0`).delete();

		const form = new FormData();
		form.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
		const up = await app.request(`/accounts/${id}/uploads`, { method: "POST", headers, body: form });
		const { id: upload } = (await up.json()) as { id: string };
		expect(await s3.file(`upload/${id}/${upload}`).text()).toBe("hello");
		await s3.file(`upload/${id}/${upload}`).delete();

		const patch = await app.request(`/accounts/${id}`, {
			method: "PATCH",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ displayName: "Lena H.", signature: "Lena" }),
		});
		expect(patch.status).toBe(204);
		expect(await (await app.request("/accounts", { headers })).json()).toMatchObject([
			{ id, displayName: "Lena H.", signature: "Lena" },
		]);

		const del = (account: string) => app.request(`/accounts/${account}`, { method: "DELETE", headers });
		expect((await del(crypto.randomUUID())).status).toBe(404);
		expect((await del(id)).status).toBe(204);
		expect(await (await app.request("/accounts", { headers })).json()).toEqual([]);
	} finally {
		await db.delete(changeLog).where(eq(changeLog.accountId, id));
		await db.delete(user).where(eq(user.id, me.id));
	}
});

test.skipIf(!process.env.DATABASE_URL)("prefs merge per key and refuse unknown ones", async () => {
	const { cookie } = await signedIn("Lena");
	const patch = (body: unknown) =>
		app.request("/prefs", {
			method: "PATCH",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	expect(await (await app.request("/prefs", { headers: { cookie } })).json()).toEqual({});
	expect((await patch({ undoSend: 10 })).status).toBe(204);
	expect((await patch({ markRead: "never" })).status).toBe(204);
	expect((await patch({ undoSend: 7 })).status).toBe(400);
	expect((await patch({ nope: true })).status).toBe(400);
	expect(await (await app.request("/prefs", { headers: { cookie } })).json()).toEqual({
		undoSend: 10,
		markRead: "never",
	});
	expect((await app.request("/prefs")).status).toBe(401);
});

// Bringing it back queues a sync over NATS, which CI doesn't run.
test.skipIf(!process.env.DATABASE_URL)("archiving an account", async () => {
	const { db } = await import("./db");
	const { mailAccount } = await import("./db/schema");
	const me = await signedIn("Lena");
	const { cookie } = me;
	const id = crypto.randomUUID();
	await db.insert(mailAccount).values({
		id,
		userId: me.id,
		email: "old@x",
		imapHost: "x",
		imapPort: 993,
		smtpHost: "x",
		smtpPort: 465,
		username: "x",
		secret: new Uint8Array(1),
	});
	const archived = async () =>
		((await (await app.request("/accounts", { headers: { cookie } })).json()) as { archivedAt: string | null }[])[0]
			?.archivedAt;
	const patch = (archived: boolean) =>
		app.request(`/accounts/${id}`, {
			method: "PATCH",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ archived }),
		});

	expect(await archived()).toBeNull();
	expect((await patch(true)).status).toBe(204);
	expect(await archived()).toBeString();
});

test("sockets need a session", async () => {
	expect((await app.request("/ws")).status).toBe(401);
});

// Needs the database and NATS (docker compose up -d).
test.skipIf(!process.env.DATABASE_URL || !process.env.NATS_URL)(
	"a socket only hears about its own accounts",
	async () => {
		const { db } = await import("./db");
		const { mailAccount, user } = await import("./db/schema");
		const { nats } = await import("./nats");
		const { websocket } = await import("hono/bun");
		const { inArray } = await import("drizzle-orm");

		const lena = await signedIn("Lena");
		const tom = await signedIn("Tom");
		const account = crypto.randomUUID();
		const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
		try {
			await db.insert(mailAccount).values({
				id: account,
				userId: lena.id,
				email: "lena@x",
				imapHost: "x",
				imapPort: 993,
				smtpHost: "x",
				smtpPort: 465,
				username: "x",
				secret: new Uint8Array(1),
			});
			const listen = async (cookie: string) => {
				const heard: string[] = [];
				// @ts-expect-error Bun's WebSocket takes headers, the DOM type doesn't know them.
				const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { cookie } });
				ws.onmessage = (e) => heard.push(e.data as string);
				await new Promise((ready) => (ws.onopen = ready));
				return { ws, heard };
			};
			const forLena = await listen(lena.cookie);
			const forTom = await listen(tom.cookie);
			// The server subscribes once the socket is open; give it a moment.
			await Bun.sleep(200);
			const { nc } = await nats();
			nc.publish("evt.mailbox.syncing", JSON.stringify({ accountId: account }));
			await Bun.sleep(300);
			expect(forLena.heard).toHaveLength(1);
			expect(forTom.heard).toEqual([]);
			forLena.ws.close();
			forTom.ws.close();
		} finally {
			server.stop(true);
			await db.delete(mailAccount).where(inArray(mailAccount.id, [account]));
			await db.delete(user).where(inArray(user.id, [lena.id, tom.id]));
		}
	},
);

test.skipIf(!process.env.DATABASE_URL)("nobody signs up on their own or learns someone's password", async () => {
	const { auth } = await import("./auth");
	const { addUser, resetUser } = await import("./user");
	const res = await auth.api.signUpEmail({
		body: { name: "Mallory", email: `${crypto.randomUUID()}@test.dev`, password: "correct-horse-9" },
		asResponse: true,
	});
	expect(res.status).toBe(400);

	const email = `${crypto.randomUUID()}@test.dev`;
	const { link } = await addUser(email, "Lena");
	expect((await app.request(`/invites/${link.split("#")[1]}`)).status).toBe(200);
	expect((await welcome(link, "correct-horse-9")).status).toBe(204);
	expect((await welcome(link, "battery-staple-7")).status).toBe(404);
	const signIn = (password: string) => auth.api.signInEmail({ body: { email, password }, asResponse: true });
	const session = await signIn("correct-horse-9");
	expect(session.status).toBe(200);
	const cookie = session.headers.getSetCookie().join("; ");
	expect(await (await app.request("/keys", { headers: { cookie } })).json()).toEqual(keys);

	// The password only changes together with the wrapped key.
	const direct = await app.request("/api/auth/change-password", { method: "POST", headers: { cookie } });
	expect(direct.status).toBe(404);
	const change = (currentPassword: string) =>
		app.request("/password", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ currentPassword, newPassword: "battery-staple-7", wrappedPrivate: btoa("again") }),
		});
	expect((await change("wrong-horse-9")).status).toBe(400);
	const changed = await change("correct-horse-9");
	expect(changed.status).toBe(204);
	const fresh = changed.headers.getSetCookie().join("; ");
	expect(
		((await (await app.request("/keys", { headers: { cookie: fresh } })).json()) as typeof keys).wrappedPrivate,
	).toBe(btoa("again"));

	// A reset leaves neither the password nor the key, and signs everyone out.
	const again = await resetUser(email);
	expect((await signIn("battery-staple-7")).status).toBe(401);
	expect((await app.request("/keys", { headers: { cookie: fresh } })).status).toBe(401);
	expect((await welcome(again, "staple-battery-5")).status).toBe(204);
	expect((await signIn("staple-battery-5")).status).toBe(200);
});

test.skipIf(!process.env.DATABASE_URL)("groups hold the user's own accounts, in the user's order", async () => {
	const { db } = await import("./db");
	const { mailAccount, user } = await import("./db/schema");
	const { inArray } = await import("drizzle-orm");

	const lena = await signedIn("Lena");
	const tom = await signedIn("Tom");
	const [work, home, toms] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
	const account = (id: string, userId: string) => ({
		id,
		userId,
		email: `${id}@x`,
		imapHost: "x",
		imapPort: 993,
		smtpHost: "x",
		smtpPort: 465,
		username: "x",
		secret: new Uint8Array(1),
	});
	const send = (method: string, path: string, body?: unknown, cookie = lena.cookie) =>
		app.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
	try {
		await db.insert(mailAccount).values([account(work, lena.id), account(home, lena.id), account(toms, tom.id)]);
		const group = {
			name: "Work",
			accountIds: [work],
			muted: false,
			focus: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
		};
		expect((await send("POST", "/groups", { ...group, accountIds: [work, toms] })).status).toBe(404);
		const { id } = (await (await send("POST", "/groups", group)).json()) as { id: string };
		await send("POST", "/groups", { name: "All", accountIds: [work, home], muted: true, focus: null });

		expect((await send("PATCH", `/groups/${id}`, { name: "Mine" }, tom.cookie)).status).toBe(404);
		expect((await send("PATCH", `/groups/${id}`, { accountIds: [work, home] })).status).toBe(204);
		expect((await send("PATCH", `/accounts/${home}`, { nickname: "Home", color: "pink" })).status).toBe(400);
		expect((await send("PATCH", `/accounts/${home}`, { nickname: "Home", color: "green", muted: true })).status).toBe(
			204,
		);

		const list = async () =>
			(await (await send("GET", "/groups")).json()) as { id: string; name: string; accountIds: string[] }[];
		expect((await list()).map((g) => g.name)).toEqual(["Work", "All"]);
		expect((await list())[0]?.accountIds.sort()).toEqual([work, home].sort());
		expect(await (await send("GET", "/groups", undefined, tom.cookie)).json()).toEqual([]);

		const all = (await list())[1]?.id;
		expect((await send("PUT", "/order", { accounts: [home, work, toms], groups: [all, id] })).status).toBe(204);
		expect((await list()).map((g) => g.name)).toEqual(["All", "Work"]);
		const accounts = (await (await send("GET", "/accounts")).json()) as {
			id: string;
			nickname: string;
			color: string;
			muted: boolean;
		}[];
		expect(accounts.map((a) => a.id)).toEqual([home, work]);
		expect(accounts[0]).toMatchObject({ nickname: "Home", color: "green", muted: true });

		// Clients that can't send null clear with "none" and no days.
		await send("PATCH", `/accounts/${home}`, { color: "none" });
		await send("PATCH", `/groups/${id}`, { focus: { days: [], from: "09:00", to: "18:00" } });
		const cleared = (await (await send("GET", "/accounts")).json()) as { color: string | null }[];
		expect(cleared[0]?.color).toBeNull();
		expect(((await list()) as unknown as { focus: unknown }[])[1]?.focus).toBeNull();

		expect((await send("DELETE", `/groups/${id}`)).status).toBe(204);
		expect((await list()).map((g) => g.name)).toEqual(["All"]);
	} finally {
		await db.delete(mailAccount).where(inArray(mailAccount.id, [work, home, toms]));
		await db.delete(user).where(inArray(user.id, [lena.id, tom.id]));
	}
});

test.skipIf(!process.env.DATABASE_URL)("a rich mail's form only goes to public https addresses", async () => {
	const { db } = await import("./db");
	const { user } = await import("./db/schema");
	const { eq } = await import("drizzle-orm");
	const me = await signedIn("Lena");
	const submit = (action: string) =>
		app.request("/rich/submit", {
			method: "POST",
			headers: { cookie: me.cookie, "content-type": "application/json" },
			body: JSON.stringify({ action, fields: { answer: "By client" } }),
		});
	try {
		expect((await app.request("/rich/submit", { method: "POST" })).status).toBe(401);
		expect((await submit("http://example.com/a")).status).toBe(400);
		expect((await submit("https://127.0.0.1/a")).status).toBe(502);
		expect((await submit("https://localhost/a")).status).toBe(502);
	} finally {
		await db.delete(user).where(eq(user.id, me.id));
	}
});

test.skipIf(!process.env.DATABASE_URL)("sender rules are saved, changed and forgotten", async () => {
	const { db } = await import("./db");
	const { senderRule, user } = await import("./db/schema");
	const { eq } = await import("drizzle-orm");
	const me = await signedIn("Lena");
	const sender = "a".repeat(64);
	const put = (body: object) =>
		app.request("/rules", {
			method: "PUT",
			headers: { cookie: me.cookie, "content-type": "application/json" },
			body: JSON.stringify({ sender, messages: [], ...body }),
		});
	const rules = () => db.select().from(senderRule).where(eq(senderRule.userId, me.id));
	try {
		expect((await app.request("/rules", { method: "PUT" })).status).toBe(401);
		expect((await put({ category: "newsletters", spam: null })).status).toBe(204);
		expect((await put({ category: null, spam: true })).status).toBe(204);
		expect(await rules()).toMatchObject([{ sender, category: null, spam: true }]);
		await put({});
		expect(await rules()).toEqual([]);
		expect((await put({ sender: "not a hash", category: "primary", spam: null })).status).toBe(400);
		// One-click unsubscribing only goes to public https addresses, like rich mail forms.
		const unsubscribe = (url: string) =>
			app.request("/unsubscribe", {
				method: "POST",
				headers: { cookie: me.cookie, "content-type": "application/json" },
				body: JSON.stringify({ url }),
			});
		expect((await unsubscribe("http://example.com/u")).status).toBe(400);
		expect((await unsubscribe("https://127.0.0.1/u")).status).toBe(502);
	} finally {
		await db.delete(user).where(eq(user.id, me.id));
	}
});

test.skipIf(!process.env.DATABASE_URL || !process.env.NATS_URL)("what can be sent, and the outbox", async () => {
	const { db } = await import("./db");
	const { mailAccount, outbox, user } = await import("./db/schema");
	const { seal } = await import("./secret");
	const { eq } = await import("drizzle-orm");
	const { s3 } = await import("bun");
	const me = await signedIn("Lena");
	const id = crypto.randomUUID();
	const json = (method: string, path: string, body?: object) =>
		app.request(path, {
			method,
			headers: { cookie: me.cookie, "content-type": "application/json" },
			body: body && JSON.stringify(body),
		});
	const send = (body: object) => json("POST", `/accounts/${id}/send`, { subject: "Plan", text: "Hi", ...body });
	// The engine makes the stream; without one running, the test does.
	const { jetstreamManager } = await import("@nats-io/jetstream");
	const { nats } = await import("./nats");
	const jsm = await jetstreamManager((await nats()).nc);
	await jsm.streams.add({ name: "COMMANDS", subjects: ["cmd.>"], retention: "workqueue" }).catch(() => {});
	try {
		await db.insert(mailAccount).values({
			id,
			userId: me.id,
			email: "lena@example.com",
			imapHost: "x",
			imapPort: 993,
			smtpHost: "x",
			smtpPort: 465,
			username: "x",
			secret: new Uint8Array(1),
		});
		// Names with addresses and Bcc alone are fine; the send gets a key when the client has none.
		const ok = await send({ to: ["Max Weber <max@x.example>"], cc: [], bcc: [] });
		expect(ok.status).toBe(202);
		expect((await ok.json()).draftId).toMatch(/^[0-9a-f-]{36}$/);
		expect((await send({ bcc: ["boss@x.example"] })).status).toBe(202);
		// Nobody, a line break in a header, a made-up Message-ID or a file that isn't there.
		expect((await send({ to: [] })).status).toBe(400);
		expect((await send({ to: ["max@x.example"], subject: "Hi\r\nBcc: evil@x.example" })).status).toBe(400);
		expect((await send({ to: ["max@x.example\r\nX: 1"] })).status).toBe(400);
		expect((await send({ to: ["max@x.example"], inReplyTo: "<a b@x>" })).status).toBe(400);
		const missing = { id: crypto.randomUUID(), name: "a.pdf", type: "application/pdf" };
		expect((await send({ to: ["max@x.example"], attachments: [missing] })).status).toBe(422);
		expect((await send({ to: ["max@x.example"], text: "x".repeat(200_001) })).status).toBe(400);

		// The outbox lists what waits and what failed, and gives a scheduled one back as a draft with its file.
		const later = crypto.randomUUID();
		const file = crypto.randomUUID();
		await s3.file(`outbox/${later}/${file}`).write("%PDF-1");
		const cmd = (draftId: string) => ({
			accountId: id,
			draftId,
			to: ["max@x.example"],
			cc: [],
			bcc: [],
			subject: "Later",
			text: "Hi",
			attachments: [{ id: file, name: "Plan.pdf", type: "application/pdf" }],
		});
		const failed = crypto.randomUUID();
		await db.insert(outbox).values([
			{
				draftId: later,
				accountId: id,
				state: "scheduled",
				runAt: new Date(Date.now() + 86_400_000),
				payload: await seal(JSON.stringify(cmd(later))),
			},
			{
				draftId: failed,
				accountId: id,
				state: "failed",
				error: "No such user",
				payload: await seal(JSON.stringify(cmd(failed))),
			},
		]);
		// Sends above may be in it too, when an engine runs alongside the test.
		const list = (
			(await (await json("GET", `/accounts/${id}/outbox`)).json()) as { draftId: string; state: string }[]
		).filter((w) => w.draftId === later || w.draftId === failed);
		expect(list.map((w) => [w.draftId, w.state]).sort()).toEqual(
			[
				[later, "scheduled"],
				[failed, "failed"],
			].sort(),
		);
		expect(list.find((w: { draftId: string }) => w.draftId === failed)).toMatchObject({
			error: "No such user",
			subject: "Later",
		});
		expect((await json("DELETE", `/accounts/${id}/outbox/${later}`)).status).toBe(202);
		expect(await s3.file(`upload/${id}/${file}`).text()).toBe("%PDF-1");
		expect(await s3.file(`outbox/${later}/${file}`).exists()).toBe(false);
		expect((await json("DELETE", `/accounts/${id}/outbox/${failed}`)).status).toBe(202);
		const left = (await (await json("GET", `/accounts/${id}/outbox`)).json()) as { draftId: string }[];
		expect(left.filter((w) => w.draftId === later || w.draftId === failed)).toEqual([]);
		expect((await json("DELETE", `/accounts/${id}/outbox/${later}`)).status).toBe(404);
		await db.insert(outbox).values({ draftId: later, accountId: id, state: "sending", payload: await seal("{}") });
		expect((await json("DELETE", `/accounts/${id}/outbox/${later}`)).status).toBe(409);
		await s3.file(`upload/${id}/${file}`).delete();
	} finally {
		await db.delete(user).where(eq(user.id, me.id));
	}
});
