// SPDX-License-Identifier: AGPL-3.0-only
import { httpInstrumentationMiddleware } from "@hono/otel";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Subscription } from "@nats-io/transport-node";
import type { MailboxSync, MessageUpdate } from "@nouvex/schema";
import { s3 } from "bun";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { db } from "./db";
import { changeLog, mailAccount, message } from "./db/schema";
import { nats } from "./nats";
import { seal } from "./secret";

type Env = { Variables: { userId: string } };
export const app = new OpenAPIHono<Env>();

app.use("*", httpInstrumentationMiddleware({ serviceName: "nouvex-api" }));
app.use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/accounts/*", async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.body(null, 401);
	c.set("userId", session.user.id);
	await next();
});

// Someone else's account answers like a missing one.
app.use("/accounts/:accountId/*", async (c, next) => {
	const [own] = await db
		.select({ id: mailAccount.id })
		.from(mailAccount)
		.where(and(eq(mailAccount.id, c.req.param("accountId")), eq(mailAccount.userId, c.get("userId"))));
	if (!own) return c.body(null, 404);
	await next();
});

const sync = async (accountId: string) => {
	const cmd: MailboxSync = { accountId };
	const { js } = await nats();
	await js.publish("cmd.mailbox.sync", JSON.stringify(cmd));
};

app.openapi(
	createRoute({
		method: "get",
		path: "/health",
		operationId: "getHealth",
		responses: {
			200: {
				description: "Service is up",
				content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
			},
		},
	}),
	(c) => c.json({ ok: true }),
);

app.openapi(
	createRoute({
		method: "get",
		path: "/accounts",
		operationId: "listAccounts",
		responses: {
			200: {
				description: "The user's mail accounts",
				content: { "application/json": { schema: z.array(z.object({ id: z.string(), email: z.string() })) } },
			},
		},
	}),
	async (c) =>
		c.json(
			await db
				.select({ id: mailAccount.id, email: mailAccount.email })
				.from(mailAccount)
				.where(eq(mailAccount.userId, c.get("userId")))
				.orderBy(mailAccount.createdAt),
			200,
		),
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts",
		operationId: "createAccount",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							email: z.email(),
							imapHost: z.string().min(1),
							imapPort: z.int().min(1).max(65535),
							smtpHost: z.string().min(1),
							smtpPort: z.int().min(1).max(65535),
							username: z.string().min(1),
							password: z.string().min(1),
						}),
					},
				},
			},
		},
		responses: {
			201: {
				description: "Account added, first sync queued",
				content: { "application/json": { schema: z.object({ id: z.string() }) } },
			},
		},
	}),
	async (c) => {
		const { password, ...rest } = c.req.valid("json");
		const id = crypto.randomUUID();
		await db.insert(mailAccount).values({ ...rest, id, userId: c.get("userId"), secret: await seal(password) });
		await sync(id);
		return c.json({ id }, 201);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/sync",
		operationId: "syncAccount",
		request: { params: z.object({ accountId: z.string() }) },
		responses: { 202: { description: "Sync queued" }, 404: { description: "No such account" } },
	}),
	async (c) => {
		await sync(c.req.valid("param").accountId);
		return c.body(null, 202);
	},
);

const Message = z.object({
	id: z.string(),
	mailboxId: z.string(),
	messageId: z.string(),
	subject: z.string(),
	snippet: z.string(),
	fromName: z.string(),
	fromAddr: z.string(),
	sentAt: z.iso.datetime({ offset: true }),
	flags: z.array(z.string()),
	size: z.int(),
});

app.openapi(
	createRoute({
		method: "get",
		path: "/accounts/{accountId}/changes",
		operationId: "getChanges",
		description:
			"Everything that changed after `since`. Start with 0, then pass the returned version. While `more` is true, ask again right away.",
		request: {
			params: z.object({ accountId: z.string() }),
			query: z.object({
				since: z.coerce.number().int().min(0),
				limit: z.coerce.number().int().min(1).max(1000).default(500),
			}),
		},
		responses: {
			200: {
				description: "Changes after `since`",
				content: {
					"application/json": {
						schema: z.object({
							version: z.int(),
							more: z.boolean(),
							messages: z.object({ upserted: z.array(Message), deleted: z.array(z.string()) }),
						}),
					},
				},
			},
			404: { description: "No such account" },
		},
	}),
	async (c) => {
		const { accountId } = c.req.valid("param");
		const { since, limit } = c.req.valid("query");
		const rows = await db
			.select()
			.from(changeLog)
			.where(and(eq(changeLog.accountId, accountId), gt(changeLog.version, since)))
			.orderBy(asc(changeLog.version))
			.limit(limit + 1);
		const page = rows.slice(0, limit);
		// Later entries win, so an entity changed several times in this page shows up once.
		const last = new Map(page.filter((r) => r.entity === "message").map((r) => [r.entityId, r.op]));
		const ids = [...last].filter(([, op]) => op === "upsert").map(([id]) => id);
		const upserted = ids.length ? await db.select().from(message).where(inArray(message.id, ids)) : [];
		return c.json(
			{
				version: page.at(-1)?.version ?? since,
				more: rows.length > limit,
				messages: {
					upserted: upserted.map(({ accountId: _, uid: __, sentAt, ...m }) => ({ ...m, sentAt: sentAt.toISOString() })),
					deleted: [...last].filter(([, op]) => op === "delete").map(([id]) => id),
				},
			},
			200,
		);
	},
);

// Every socket gets every event for now. Needs filtering per user once sessions are checked here.
app.get(
	"/ws",
	upgradeWebSocket(() => {
		let sub: Subscription | undefined;
		return {
			async onOpen(_, ws) {
				const { nc } = await nats();
				sub = nc.subscribe("evt.>", { callback: (_, m) => ws.send(m.string()) });
			},
			onClose: () => sub?.unsubscribe(),
		};
	}),
);

app.openapi(
	createRoute({
		method: "get",
		path: "/accounts/{accountId}/messages/{messageId}/body",
		operationId: "getMessageBody",
		description: "The HTML to show for a message, unsanitized. Render it only in a sandboxed frame after sanitizing.",
		request: { params: z.object({ accountId: z.string(), messageId: z.string() }) },
		responses: {
			200: {
				description: "Message body",
				content: { "application/json": { schema: z.object({ html: z.string() }) } },
			},
			404: { description: "No such message" },
		},
	}),
	async (c) => {
		const { accountId, messageId } = c.req.valid("param");
		const [found] = await db
			.select({ id: message.id })
			.from(message)
			.where(and(eq(message.id, messageId), eq(message.accountId, accountId)));
		if (!found) return c.body(null, 404);
		// JSON instead of text/html, so opening this URL directly can't run the mail's markup on our origin.
		return c.json({ html: await s3.file(`body/${found.id}.html`).text() }, 200);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/messages/{messageId}/update",
		operationId: "updateMessage",
		description: "Mark a message read or unread, or move it to the trash. Shows up in /changes once the server has it.",
		request: {
			params: z.object({ accountId: z.string(), messageId: z.string() }),
			body: {
				content: {
					"application/json": { schema: z.object({ seen: z.boolean().optional(), trash: z.boolean().optional() }) },
				},
			},
		},
		responses: { 202: { description: "Change queued" }, 404: { description: "No such message" } },
	}),
	async (c) => {
		const { accountId, messageId } = c.req.valid("param");
		const [found] = await db
			.select({ id: message.id })
			.from(message)
			.where(and(eq(message.id, messageId), eq(message.accountId, accountId)));
		if (!found) return c.body(null, 404);
		const cmd: MessageUpdate = { accountId, messageId, ...c.req.valid("json") };
		const { js } = await nats();
		await js.publish("cmd.message.update", JSON.stringify(cmd));
		return c.body(null, 202);
	},
);

app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "Nouvex Mail API", version: "0.0.0" } });
