// SPDX-License-Identifier: AGPL-3.0-only
import { httpInstrumentationMiddleware } from "@hono/otel";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Subscription } from "@nats-io/transport-node";
import type { AccountCheck, AccountChecked, DraftSave, MailboxSync, MessageSend, MessageUpdate } from "@nouvex/schema";
import { s3 } from "bun";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { db } from "./db";
import { changeLog, mailAccount, mailbox, message, userPrefs } from "./db/schema";
import { fetchImage } from "./image";
import { nats } from "./nats";
import { seal } from "./secret";

type Env = { Variables: { userId: string } };
export const app = new OpenAPIHono<Env>();

app.use("*", httpInstrumentationMiddleware({ serviceName: "nouvex-api" }));
app.use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/image", async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.body(null, 401);
	await next();
});

const signedIn: MiddlewareHandler<Env> = async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.body(null, 401);
	c.set("userId", session.user.id);
	await next();
};
app.use("/prefs", signedIn);
app.use("/accounts/*", signedIn);

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
				content: {
					"application/json": {
						schema: z.array(
							z.object({
								id: z.string(),
								email: z.string(),
								displayName: z.string(),
								signature: z.string(),
								syncError: z.string().nullable(),
								archivedAt: z.string().nullable(),
							}),
						),
					},
				},
			},
		},
	}),
	async (c) =>
		c.json(
			await db
				.select({
					id: mailAccount.id,
					email: mailAccount.email,
					displayName: mailAccount.displayName,
					signature: mailAccount.signature,
					syncError: mailAccount.syncError,
					archivedAt: mailAccount.archivedAt,
				})
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
			422: {
				description: "The mail server didn't accept these settings",
				content: { "application/json": { schema: z.object({ error: z.string() }) } },
			},
		},
	}),
	async (c) => {
		const { password, ...rest } = c.req.valid("json");
		const secret = await seal(password);
		// The engine tries both logins first, so wrong settings are caught here instead of failing quietly later.
		const check: AccountCheck = { ...rest, secret: secret.toString("base64") };
		const { nc } = await nats();
		const reply = await nc.request("rpc.account.check", JSON.stringify(check), { timeout: 65_000 });
		const { error } = reply.json<AccountChecked>();
		if (error) return c.json({ error }, 422);
		const id = crypto.randomUUID();
		await db.insert(mailAccount).values({ ...rest, id, userId: c.get("userId"), secret });
		await sync(id);
		return c.json({ id }, 201);
	},
);

// Only settings the clients know about; anything else is refused instead of piling up.
export const Prefs = z
	.object({
		markRead: z.enum(["instant", "delay", "never"]),
		remoteImages: z.enum(["always", "ask"]),
		afterArchive: z.enum(["next", "previous", "list"]),
		undoSend: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(20), z.literal(30)]),
		replyDefault: z.enum(["reply", "all"]),
		archivedReplies: z.boolean(),
		/** Minutes before a meeting starts that it shows in the sidebar. */
		meetingLead: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]),
		/** Minutes a sign-in code stays in the sidebar. */
		codeLife: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15)]),
		/** Promotions, social, updates and newsletters leave the inbox for their own place under it. */
		categories: z.boolean(),
	})
	.partial()
	.strict();

app.openapi(
	createRoute({
		method: "get",
		path: "/prefs",
		operationId: "getPrefs",
		responses: {
			200: {
				description: "What the user changed; anything missing is at its default",
				content: { "application/json": { schema: Prefs } },
			},
		},
	}),
	async (c) => {
		const [row] = await db
			.select()
			.from(userPrefs)
			.where(eq(userPrefs.userId, c.get("userId")));
		// Keys dropped from Prefs since they were stored don't reach the clients.
		return c.json(Prefs.strip().parse(row?.prefs ?? {}), 200);
	},
);

app.openapi(
	createRoute({
		method: "patch",
		path: "/prefs",
		operationId: "updatePrefs",
		request: { body: { content: { "application/json": { schema: Prefs } } } },
		responses: { 204: { description: "Saved" } },
	}),
	async (c) => {
		const change = c.req.valid("json");
		// Through text: bun-sql would bind the object as a JSON string, and jsonb would keep it as one.
		await db
			.insert(userPrefs)
			.values({ userId: c.get("userId"), prefs: sql`${JSON.stringify(change)}::text::jsonb` })
			.onConflictDoUpdate({
				target: userPrefs.userId,
				set: { prefs: sql`${userPrefs.prefs} || excluded.prefs`, updatedAt: new Date() },
			});
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "patch",
		path: "/accounts/{accountId}",
		operationId: "updateAccount",
		request: {
			params: z.object({ accountId: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							displayName: z.string().max(200).optional(),
							signature: z.string().max(5000).optional(),
							archived: z.boolean().optional(),
						}),
					},
				},
			},
		},
		responses: { 204: { description: "Saved" }, 404: { description: "No such account" } },
	}),
	async (c) => {
		const { archived, ...change } = c.req.valid("json");
		const { accountId } = c.req.valid("param");
		const set = archived === undefined ? change : { ...change, archivedAt: archived ? new Date() : null };
		if (Object.keys(set).length) await db.update(mailAccount).set(set).where(eq(mailAccount.id, accountId));
		// Back from the archive: the sync starts its watcher again.
		if (archived === false) await sync(accountId);
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "delete",
		path: "/accounts/{accountId}",
		operationId: "deleteAccount",
		description: "Removes the account and everything synced from it. The mail server is not touched.",
		request: { params: z.object({ accountId: z.string() }) },
		responses: { 204: { description: "Removed" }, 404: { description: "No such account" } },
	}),
	async (c) => {
		// ponytail: its bodies and attachments stay in S3; a cleanup job can remove raw/, body/ and att/ of gone ids.
		const { accountId } = c.req.valid("param");
		await db.delete(mailAccount).where(eq(mailAccount.id, accountId));
		await db.delete(changeLog).where(eq(changeLog.accountId, accountId));
		return c.body(null, 204);
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

// A number in the path or query. Coercing makes its input `unknown`, which the document would list as optional and
// nullable, and the generated Swift client can't build from that.
const whole = z.coerce
	.number()
	.int()
	.min(0)
	.openapi({ type: "integer", minimum: 0, param: { required: true } });

const Mailbox = z.object({
	id: z.string(),
	name: z.string(),
	role: z.enum(["inbox", "sent", "drafts", "trash", "junk", "archive", "snoozed", ""]),
});

const Message = z.object({
	id: z.string(),
	mailboxId: z.string(),
	messageId: z.string(),
	threadId: z.string(),
	subject: z.string(),
	snippet: z.string(),
	fromName: z.string(),
	fromAddr: z.string(),
	to: z.array(z.string()),
	cc: z.array(z.string()),
	sentAt: z.iso.datetime({ offset: true }),
	flags: z.array(z.string()),
	size: z.int(),
	attachments: z.array(z.object({ name: z.string(), type: z.string(), size: z.int() })),
	/** The inbox tab it belongs in, sorted by the engine from its headers. */
	category: z.enum(["primary", "promotions", "social", "updates", "newsletters"]),
	/** A sign-in code to copy or a meeting to join, found by the engine. How long it's useful is up to the client. */
	actions: z.array(
		z.object({
			kind: z.enum(["code", "meeting"]),
			code: z.string().optional(),
			title: z.string().optional(),
			start: z.iso.datetime({ offset: true }).optional(),
			end: z.iso.datetime({ offset: true }).optional(),
			url: z.url().optional(),
			provider: z.string().optional(),
			event: z.string().optional(),
			cancelled: z.boolean().optional(),
		}),
	),
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
				since: whole,
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
							mailboxes: z.object({ upserted: z.array(Mailbox), deleted: z.array(z.string()) }),
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
		const last = (entity: string) => {
			const ops = new Map(page.filter((r) => r.entity === entity).map((r) => [r.entityId, r.op]));
			const pick = (op: string) => [...ops].filter(([, o]) => o === op).map(([id]) => id);
			return { upserted: pick("upsert"), deleted: pick("delete") };
		};
		const boxes = last("mailbox");
		const msgs = last("message");
		const [mailboxes, messages] = await Promise.all([
			boxes.upserted.length
				? db
						.select({ id: mailbox.id, name: mailbox.name, role: mailbox.role })
						.from(mailbox)
						.where(inArray(mailbox.id, boxes.upserted))
				: [],
			msgs.upserted.length ? db.select().from(message).where(inArray(message.id, msgs.upserted)) : [],
		]);
		return c.json(
			{
				version: page.at(-1)?.version ?? since,
				more: rows.length > limit,
				mailboxes: { upserted: mailboxes, deleted: boxes.deleted },
				messages: {
					upserted: messages.map(({ accountId: _, uid: __, refs: ___, sentAt, ...m }) => ({
						...m,
						sentAt: sentAt.toISOString(),
					})),
					deleted: msgs.deleted,
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
				sub = nc.subscribe("evt.>", {
					callback: (_, m) => ws.send(JSON.stringify({ subject: m.subject, data: m.json() })),
				});
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
		description:
			"Mark a message read or unread, or move it to the trash or the archive. Shows up in /changes once the server has it.",
		request: {
			params: z.object({ accountId: z.string(), messageId: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							seen: z.boolean().optional(),
							flagged: z.boolean().optional(),
							trash: z.boolean().optional(),
							archive: z.boolean().optional(),
							snoozeUntil: z.iso.datetime().optional(),
						}),
					},
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

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/send",
		operationId: "sendMessage",
		description: "Sends a plain text message. The outcome arrives as an evt.message.sent event on /ws.",
		request: {
			params: z.object({ accountId: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							to: z.array(z.email()).min(1),
							cc: z.array(z.email()).default([]),
							bcc: z.array(z.email()).default([]),
							subject: z.string(),
							text: z.string(),
							inReplyTo: z.string().optional(),
							draftId: z.uuid().optional(),
							sendAt: z.iso.datetime().optional(),
							attachments: z.array(z.object({ id: z.uuid(), name: z.string(), type: z.string() })).optional(),
						}),
					},
				},
			},
		},
		responses: { 202: { description: "Queued for sending" }, 404: { description: "No such account" } },
	}),
	async (c) => {
		const cmd: MessageSend = { accountId: c.req.valid("param").accountId, ...c.req.valid("json") };
		const { js } = await nats();
		await js.publish("cmd.message.send", JSON.stringify(cmd));
		return c.body(null, 202);
	},
);

app.openapi(
	createRoute({
		method: "get",
		path: "/accounts/{accountId}/messages/{messageId}/attachments/{index}",
		operationId: "getAttachment",
		request: {
			params: z.object({ accountId: z.string(), messageId: z.string(), index: whole }),
		},
		responses: {
			200: { description: "The file, as a download", content: { "application/octet-stream": { schema: z.any() } } },
			404: { description: "No such attachment" },
		},
	}),
	async (c) => {
		const { accountId, messageId, index } = c.req.valid("param");
		const [found] = await db
			.select({ attachments: message.attachments })
			.from(message)
			.where(and(eq(message.id, messageId), eq(message.accountId, accountId)));
		const file = found?.attachments[index];
		if (!file) return c.body(null, 404);
		// Always a download, never rendered on our origin.
		return new Response(s3.file(`att/${messageId}/${index}`).stream(), {
			headers: {
				"content-type": file.type || "application/octet-stream",
				"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
			},
		});
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/uploads",
		operationId: "uploadFile",
		description: "Stores a file to attach to a message sent later; pass the returned id in sendMessage.",
		request: {
			params: z.object({ accountId: z.string() }),
			body: {
				required: true,
				content: {
					"multipart/form-data": {
						schema: z.object({ file: z.instanceof(File).openapi({ type: "string", format: "binary" }) }),
					},
				},
			},
		},
		responses: {
			201: { description: "Stored", content: { "application/json": { schema: z.object({ id: z.uuid() }) } } },
			413: { description: "Larger than 25 MB" },
		},
	}),
	async (c) => {
		const { file } = c.req.valid("form");
		if (file.size > 25 * 1024 * 1024) return c.body(null, 413);
		const id = crypto.randomUUID();
		// ponytail: uploads that never get sent stay in S3; a lifecycle rule on upload/ can expire them.
		await s3.file(`upload/${c.req.valid("param").accountId}/${id}`).write(file);
		return c.json({ id }, 201);
	},
);

const Draft = z.object({
	to: z.array(z.string()),
	cc: z.array(z.string()).default([]),
	bcc: z.array(z.string()).default([]),
	subject: z.string(),
	text: z.string(),
	inReplyTo: z.string().optional(),
});

const draft = async (cmd: DraftSave) => {
	const { js } = await nats();
	await js.publish("cmd.draft.save", JSON.stringify(cmd));
};

app.openapi(
	createRoute({
		method: "put",
		path: "/accounts/{accountId}/drafts/{draftId}",
		operationId: "saveDraft",
		description: "Stores the draft in the Drafts folder, replacing its previous version. The client picks the draftId.",
		request: {
			params: z.object({ accountId: z.string(), draftId: z.uuid() }),
			body: { content: { "application/json": { schema: Draft } } },
		},
		responses: { 202: { description: "Saving" }, 404: { description: "No such account" } },
	}),
	async (c) => {
		await draft({ ...c.req.valid("param"), ...c.req.valid("json") });
		return c.body(null, 202);
	},
);

app.openapi(
	createRoute({
		method: "delete",
		path: "/accounts/{accountId}/drafts/{draftId}",
		operationId: "discardDraft",
		request: { params: z.object({ accountId: z.string(), draftId: z.uuid() }) },
		responses: { 202: { description: "Discarding" }, 404: { description: "No such account" } },
	}),
	async (c) => {
		await draft({ ...c.req.valid("param"), to: [], cc: [], bcc: [], subject: "", text: "", discard: true });
		return c.body(null, 202);
	},
);

app.openapi(
	createRoute({
		method: "get",
		path: "/image",
		operationId: "getImage",
		description: "Loads a remote image of a mail through the server, so the sender never sees the reader's address.",
		request: { query: z.object({ url: z.url() }) },
		responses: {
			200: { description: "The image", content: { "image/*": { schema: z.any() } } },
			404: { description: "Not a public image" },
		},
	}),
	async (c) => {
		const image = await fetchImage(c.req.valid("query").url);
		if (!image) return c.body(null, 404);
		return new Response(image.body, {
			headers: {
				"content-type": image.type,
				"cache-control": "private, max-age=86400",
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
			},
		});
	},
);

app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "Nouvex Mail API", version: "0.0.0" } });
