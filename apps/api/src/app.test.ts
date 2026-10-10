// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test";
import { app } from "./app";

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
	const { auth } = await import("./auth");
	const { db } = await import("./db");
	const { changeLog, mailAccount, mailbox, message, user } = await import("./db/schema");
	const { eq } = await import("drizzle-orm");

	const email = `${crypto.randomUUID()}@test.dev`;
	const res = await auth.api.signUpEmail({
		body: { name: "Lena", email, password: "correct-horse-9" },
		asResponse: true,
	});
	const headers = { cookie: res.headers.getSetCookie().join("; ") };
	const { user: me } = (await res.json()) as { user: { id: string } };
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
			messageId: `<${n}@x>`,
			subject: `Mail ${n}`,
			fromName: "Lena",
			fromAddr: "lena@x",
			sentAt: new Date("2026-10-08T07:12:00Z"),
			flags: [],
			size: 10,
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
		expect(first.messages.upserted.map((m: { subject: string }) => m.subject).sort()).toEqual(["Mail 1", "Mail 2"]);
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
		await s3.file(`body/${id}-2.html`).write("<p>Hi</p>");
		const body = await app.request(`/accounts/${id}/messages/${id}-2/body`, { headers });
		expect(await body.json()).toEqual({ html: "<p>Hi</p>" });
		expect((await app.request(`/accounts/${id}/messages/nope/body`, { headers })).status).toBe(404);
		await s3.file(`body/${id}-2.html`).delete();

		await db
			.update(message)
			.set({ attachments: [{ name: "Übergabe.pdf", type: "application/pdf", size: 6 }] })
			.where(eq(message.id, `${id}-2`));
		await s3.file(`att/${id}-2/0`).write("%PDF-1");
		const att = await app.request(`/accounts/${id}/messages/${id}-2/attachments/0`, { headers });
		expect(await att.text()).toBe("%PDF-1");
		expect(att.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''%C3%9Cbergabe.pdf");
		expect(att.headers.get("x-content-type-options")).toBe("nosniff");
		expect((await app.request(`/accounts/${id}/messages/${id}-2/attachments/1`, { headers })).status).toBe(404);
		await s3.file(`att/${id}-2/0`).delete();

		const form = new FormData();
		form.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
		const up = await app.request(`/accounts/${id}/uploads`, { method: "POST", headers, body: form });
		const { id: upload } = (await up.json()) as { id: string };
		expect(await s3.file(`upload/${id}/${upload}`).text()).toBe("hello");
		await s3.file(`upload/${id}/${upload}`).delete();
	} finally {
		await db.delete(changeLog).where(eq(changeLog.accountId, id));
		await db.delete(user).where(eq(user.id, me.id));
	}
});
