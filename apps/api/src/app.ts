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
import {
	accountGroup,
	accountGroupMember,
	changeLog,
	labelColors,
	mailAccount,
	mailbox,
	message,
	senderRule,
	userKey,
	userPrefs,
} from "./db/schema";
import { fetchImage, post } from "./image";
import { nats } from "./nats";
import { seal } from "./secret";

type Env = { Variables: { userId: string } };
export const app = new OpenAPIHono<Env>();

app.use("*", httpInstrumentationMiddleware({ serviceName: "nouvex-api" }));
app.use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true }));

// A new password also wraps the user's key again, so it only changes through POST /password.
app.post("/api/auth/change-password", (c) => c.body(null, 404));
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
app.use("/keys", signedIn);
app.use("/password", signedIn);
app.use("/accounts/*", signedIn);
app.use("/groups/*", signedIn);
app.use("/order", signedIn);
app.use("/rich/*", signedIn);
app.use("/rules", signedIn);
app.use("/unsubscribe", signedIn);

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
								nickname: z.string(),
								color: z.enum(labelColors).nullable(),
								muted: z.boolean(),
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
					nickname: mailAccount.nickname,
					color: mailAccount.color,
					muted: mailAccount.muted,
				})
				.from(mailAccount)
				.where(eq(mailAccount.userId, c.get("userId")))
				.orderBy(mailAccount.position, mailAccount.createdAt),
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

const Keys = z.object({ publicKey: z.base64(), wrappedPrivate: z.base64() });

app.openapi(
	createRoute({
		method: "get",
		path: "/invites/{token}",
		operationId: "getInvite",
		request: { params: z.object({ token: z.string() }) },
		responses: {
			200: {
				description: "Who the link from src/user.ts is for",
				content: { "application/json": { schema: z.object({ email: z.string() }) } },
			},
			404: { description: "Used or expired" },
		},
	}),
	async (c) => {
		const ctx = await auth.$context;
		const row = await ctx.internalAdapter.findVerificationValue(`invite:${c.req.valid("param").token}`);
		const user = row && row.expiresAt > new Date() && (await ctx.internalAdapter.findUserById(row.value));
		if (!user) return c.body(null, 404);
		return c.json({ email: user.email }, 200);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/invites/{token}",
		operationId: "acceptInvite",
		request: {
			params: z.object({ token: z.string() }),
			body: {
				content: {
					"application/json": {
						// password is the authKey the client derived; the password itself stays on the device.
						schema: Keys.extend({ password: z.string().min(8).max(128) }),
					},
				},
			},
		},
		responses: { 204: { description: "Password and keys set, sign in next" }, 404: { description: "Used or expired" } },
	}),
	async (c) => {
		const { password, publicKey, wrappedPrivate } = c.req.valid("json");
		const ctx = await auth.$context;
		const row = await ctx.internalAdapter.consumeVerificationValue(`invite:${c.req.valid("param").token}`);
		if (!row) return c.body(null, 404);
		const userId = row.value;
		const hash = await ctx.password.hash(password);
		if (await ctx.internalAdapter.findCredentialAccount(userId)) await ctx.internalAdapter.updatePassword(userId, hash);
		else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
		const keys = {
			publicKey: Uint8Array.fromBase64(publicKey),
			wrappedPrivate: Uint8Array.fromBase64(wrappedPrivate),
			createdAt: new Date(),
		};
		await db
			.insert(userKey)
			.values({ userId, ...keys })
			.onConflictDoUpdate({ target: userKey.userId, set: keys });
		// The engine waits for a key before it fetches anything.
		const accounts = await db.select({ id: mailAccount.id }).from(mailAccount).where(eq(mailAccount.userId, userId));
		for (const a of accounts) await sync(a.id);
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "get",
		path: "/keys",
		operationId: "getKeys",
		responses: {
			200: {
				description: "The user's key pair, the private half wrapped",
				content: { "application/json": { schema: Keys } },
			},
			404: { description: "None yet" },
		},
	}),
	async (c) => {
		const [row] = await db
			.select()
			.from(userKey)
			.where(eq(userKey.userId, c.get("userId")));
		if (!row) return c.body(null, 404);
		return c.json({ publicKey: row.publicKey.toBase64(), wrappedPrivate: row.wrappedPrivate.toBase64() }, 200);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/password",
		operationId: "changePassword",
		request: {
			body: {
				content: {
					"application/json": {
						// Both are authKeys; wrappedPrivate is the same private key, wrapped for the new password.
						schema: z.object({
							currentPassword: z.string(),
							newPassword: z.string().min(8).max(128),
							wrappedPrivate: z.base64(),
						}),
					},
				},
			},
		},
		responses: {
			204: { description: "Changed, every other session signed out" },
			400: {
				description: "The current password is wrong",
				content: { "application/json": { schema: z.object({ message: z.string() }) } },
			},
		},
	}),
	async (c) => {
		const { currentPassword, newPassword, wrappedPrivate } = c.req.valid("json");
		const res = await auth.api.changePassword({
			body: { currentPassword, newPassword, revokeOtherSessions: true },
			headers: c.req.raw.headers,
			asResponse: true,
		});
		if (!res.ok) {
			const { message } = (await res.json()) as { message?: string };
			return c.json({ message: message ?? "Couldn't change the password." }, 400);
		}
		await db
			.update(userKey)
			.set({ wrappedPrivate: Uint8Array.fromBase64(wrappedPrivate) })
			.where(eq(userKey.userId, c.get("userId")));
		// This device keeps its session under a new token.
		for (const cookie of res.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
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
							nickname: z.string().max(40).optional(),
							// "none" as well as null, for clients that can't send null.
							color: z
								.enum([...labelColors, "none"])
								.nullable()
								.optional(),
							muted: z.boolean().optional(),
						}),
					},
				},
			},
		},
		responses: { 204: { description: "Saved" }, 404: { description: "No such account" } },
	}),
	async (c) => {
		const { archived, color, ...change } = c.req.valid("json");
		const { accountId } = c.req.valid("param");
		const set = {
			...change,
			...(color !== undefined && { color: color === "none" ? null : color }),
			...(archived !== undefined && { archivedAt: archived ? new Date() : null }),
		};
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

// No days turns focus times off, like null, for clients that can't send null.
const Focus = z.object({
	days: z.array(z.number().int().min(0).max(6)),
	from: z.string().regex(/^\d\d:\d\d$/),
	to: z.string().regex(/^\d\d:\d\d$/),
});
const off = (focus: z.infer<typeof Focus> | null | undefined) => (focus?.days.length === 0 ? null : focus);
const GroupChange = z.object({
	name: z.string().min(1).max(60),
	accountIds: z.array(z.string()),
	muted: z.boolean(),
	focus: Focus.nullable(),
});
const Group = GroupChange.extend({ id: z.string() });

// Only the user's own accounts join a group.
const ownAccounts = async (userId: string, ids: string[]) =>
	ids.length === 0
		? true
		: (
				await db
					.select({ id: mailAccount.id })
					.from(mailAccount)
					.where(and(eq(mailAccount.userId, userId), inArray(mailAccount.id, ids)))
			).length === new Set(ids).size;

const setMembers = async (groupId: string, accountIds: string[]) => {
	await db.delete(accountGroupMember).where(eq(accountGroupMember.groupId, groupId));
	if (accountIds.length)
		await db
			.insert(accountGroupMember)
			.values([...new Set(accountIds)].map((accountId) => ({ groupId, accountId })))
			.onConflictDoNothing();
};

app.openapi(
	createRoute({
		method: "get",
		path: "/groups",
		operationId: "listGroups",
		responses: {
			200: {
				description: "The user's groups, in their order",
				content: { "application/json": { schema: z.array(Group) } },
			},
		},
	}),
	async (c) => {
		const groups = await db
			.select()
			.from(accountGroup)
			.where(eq(accountGroup.userId, c.get("userId")))
			.orderBy(accountGroup.position, accountGroup.name);
		const members = groups.length
			? await db
					.select()
					.from(accountGroupMember)
					.where(
						inArray(
							accountGroupMember.groupId,
							groups.map((g) => g.id),
						),
					)
			: [];
		return c.json(
			groups.map(({ id, name, muted, focus }) => ({
				id,
				name,
				muted,
				focus: focus ?? null,
				accountIds: members.filter((m) => m.groupId === id).map((m) => m.accountId),
			})),
			200,
		);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/groups",
		operationId: "createGroup",
		request: { body: { content: { "application/json": { schema: GroupChange } } } },
		responses: {
			201: {
				description: "Created, last in the order",
				content: { "application/json": { schema: z.object({ id: z.string() }) } },
			},
			404: { description: "One of the accounts isn't the user's" },
		},
	}),
	async (c) => {
		const { accountIds, focus, ...group } = c.req.valid("json");
		const userId = c.get("userId");
		if (!(await ownAccounts(userId, accountIds))) return c.body(null, 404);
		const id = crypto.randomUUID();
		// Last in the order.
		const position = sql<number>`(select count(*) from ${accountGroup} where ${accountGroup.userId} = ${userId})`;
		await db.insert(accountGroup).values({ id, userId, ...group, focus: off(focus), position });
		await setMembers(id, accountIds);
		return c.json({ id }, 201);
	},
);

// Someone else's group answers like a missing one.
app.use("/groups/:groupId", async (c, next) => {
	const [own] = await db
		.select({ id: accountGroup.id })
		.from(accountGroup)
		.where(and(eq(accountGroup.id, c.req.param("groupId")), eq(accountGroup.userId, c.get("userId"))));
	if (!own) return c.body(null, 404);
	await next();
});

app.openapi(
	createRoute({
		method: "patch",
		path: "/groups/{groupId}",
		operationId: "updateGroup",
		request: {
			params: z.object({ groupId: z.string() }),
			body: { content: { "application/json": { schema: GroupChange.partial() } } },
		},
		responses: { 204: { description: "Saved" }, 404: { description: "No such group, or an account isn't the user's" } },
	}),
	async (c) => {
		const { accountIds, focus, ...rest } = c.req.valid("json");
		const { groupId } = c.req.valid("param");
		if (accountIds && !(await ownAccounts(c.get("userId"), accountIds))) return c.body(null, 404);
		const change = focus === undefined ? rest : { ...rest, focus: off(focus) };
		if (Object.keys(change).length) await db.update(accountGroup).set(change).where(eq(accountGroup.id, groupId));
		if (accountIds) await setMembers(groupId, accountIds);
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "delete",
		path: "/groups/{groupId}",
		operationId: "deleteGroup",
		description: "Removes the group; its accounts stay.",
		request: { params: z.object({ groupId: z.string() }) },
		responses: { 204: { description: "Removed" }, 404: { description: "No such group" } },
	}),
	async (c) => {
		await db.delete(accountGroup).where(eq(accountGroup.id, c.req.valid("param").groupId));
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "put",
		path: "/order",
		operationId: "setOrder",
		description: "The order of the account picker. Ids that aren't the user's are ignored.",
		request: {
			body: {
				content: {
					"application/json": { schema: z.object({ accounts: z.array(z.string()), groups: z.array(z.string()) }) },
				},
			},
		},
		responses: { 204: { description: "Saved" } },
	}),
	async (c) => {
		const { accounts, groups } = c.req.valid("json");
		const userId = c.get("userId");
		await db.transaction(async (tx) => {
			for (const [position, id] of accounts.entries())
				await tx
					.update(mailAccount)
					.set({ position })
					.where(and(eq(mailAccount.id, id), eq(mailAccount.userId, userId)));
			for (const [position, id] of groups.entries())
				await tx
					.update(accountGroup)
					.set({ position })
					.where(and(eq(accountGroup.id, id), eq(accountGroup.userId, userId)));
		});
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

const Category = z.enum(["primary", "promotions", "social", "updates", "newsletters"]);

const Message = z.object({
	id: z.string(),
	mailboxId: z.string(),
	threadId: z.string(),
	sentAt: z.iso.datetime({ offset: true }),
	flags: z.array(z.string()),
	size: z.int(),
	/** The inbox tab it belongs in, sorted by the engine (engine/internal/mail/sort.go). */
	category: Category,
	/** The engine took it for spam; it shows under Junk. */
	spam: z.boolean(),
	/** The message's own key, sealed to the user's public key (engine/internal/seal). */
	key: z.base64(),
	/**
	 * Opened with that key (label "meta"): messageId, subject, snippet, fromName, fromAddr, to, cc, attachments and the
	 * sign-in codes and meetings the engine found (Meta in engine/internal/mail/sync.go).
	 */
	sealed: z.base64(),
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
					upserted: messages.map(
						({ accountId: _, uid: __, refs: ___, messageId: ____, sentAt, key, sealed, ...m }) => ({
							...m,
							sentAt: sentAt.toISOString(),
							key: key.toBase64(),
							sealed: sealed.toBase64(),
						}),
					),
					deleted: msgs.deleted,
				},
			},
			200,
		);
	},
);

// A socket only hears about the signed-in user's own accounts.
app.use("/ws", signedIn);
app.get(
	"/ws",
	upgradeWebSocket((c) => {
		const userId = c.get("userId");
		// Whose an account is doesn't change, so each answer holds for the socket's life.
		const mine = new Map<string, Promise<boolean>>();
		const owns = (accountId: string) => {
			let known = mine.get(accountId);
			if (!known) {
				known = db
					.select({ id: mailAccount.id })
					.from(mailAccount)
					.where(and(eq(mailAccount.id, accountId), eq(mailAccount.userId, userId)))
					.then((rows) => rows.length > 0);
				mine.set(accountId, known);
			}
			return known;
		};
		let sub: Subscription | undefined;
		return {
			async onOpen(_, ws) {
				const { nc } = await nats();
				sub = nc.subscribe("evt.>", {
					callback: (_, m) => {
						const data = m.json<{ accountId?: string }>();
						if (!data.accountId) return;
						owns(data.accountId).then((ok) => {
							if (ok) ws.send(JSON.stringify({ subject: m.subject, data }));
						});
					},
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
		description:
			"The HTML to show for a message, sealed with the message's key (label body). Unsanitized: render it only in a sandboxed frame after sanitizing.",
		request: { params: z.object({ accountId: z.string(), messageId: z.string() }) },
		responses: {
			200: {
				description: "Message body",
				content: { "application/json": { schema: z.object({ sealed: z.base64() }) } },
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
		return c.json({ sealed: (await s3.file(`body/${found.id}.html`).bytes()).toBase64() }, 200);
	},
);

app.openapi(
	createRoute({
		method: "get",
		path: "/accounts/{accountId}/messages/{messageId}/rich",
		operationId: "getMessageRich",
		description:
			"The designed version of a rich mail (docs/rich-mail.md), sealed with the message's key (label rich). Unsanitized, like the body.",
		request: { params: z.object({ accountId: z.string(), messageId: z.string() }) },
		responses: {
			200: {
				description: "The designed version",
				content: { "application/json": { schema: z.object({ sealed: z.base64() }) } },
			},
			404: { description: "No such message, or it has no designed version" },
		},
	}),
	async (c) => {
		const { accountId, messageId } = c.req.valid("param");
		const [found] = await db
			.select({ id: message.id })
			.from(message)
			.where(and(eq(message.id, messageId), eq(message.accountId, accountId)));
		const file = found && s3.file(`rich/${found.id}.html`);
		if (!file || !(await file.exists())) return c.body(null, 404);
		return c.json({ sealed: (await file.bytes()).toBase64() }, 200);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/rich/submit",
		operationId: "submitRichForm",
		description:
			"Sends what the reader filled into a rich mail's form to its action, from the server, after the reader confirmed it.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							action: z.url({ protocol: /^https$/ }),
							fields: z.record(z.string(), z.union([z.string().max(10_000), z.array(z.string().max(10_000)).max(50)])),
						}),
					},
				},
			},
		},
		responses: { 204: { description: "The sender took it" }, 502: { description: "The sender didn't take it" } },
	}),
	async (c) => {
		const { action, fields } = c.req.valid("json");
		return (await post(action, "application/json", JSON.stringify(fields))) ? c.body(null, 204) : c.body(null, 502);
	},
);

app.openapi(
	createRoute({
		method: "put",
		path: "/rules",
		operationId: "setSenderRule",
		description:
			"Where a sender's mail goes from now on: a tab, spam or not spam; neither forgets the rule. The messages listed, the sender's mail the client has, move along.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							/** SHA-256 (hex) of the lowercased address, or of "@domain" for a whole domain. */
							sender: z.string().regex(/^[0-9a-f]{64}$/),
							// Left out or null: no say. The Swift client can't send null, it leaves the field out.
							category: Category.nullish(),
							spam: z.boolean().nullish(),
							messages: z.array(z.object({ accountId: z.string(), id: z.string() })).max(2000),
						}),
					},
				},
			},
		},
		responses: { 204: { description: "Saved, the messages are moving" } },
	}),
	async (c) => {
		const userId = c.get("userId");
		const { sender, messages, ...body } = c.req.valid("json");
		const category = body.category ?? null;
		const spam = body.spam ?? null;
		if (category === null && spam === null) {
			await db.delete(senderRule).where(and(eq(senderRule.userId, userId), eq(senderRule.sender, sender)));
		} else {
			await db
				.insert(senderRule)
				.values({ userId, sender, category, spam })
				.onConflictDoUpdate({ target: [senderRule.userId, senderRule.sender], set: { category, spam } });
		}
		const mine = messages.length
			? await db
					.select({ id: message.id, accountId: message.accountId })
					.from(message)
					.innerJoin(mailAccount, eq(mailAccount.id, message.accountId))
					.where(
						and(
							eq(mailAccount.userId, userId),
							inArray(
								message.id,
								messages.map((m) => m.id),
							),
						),
					)
			: [];
		const { js } = await nats();
		for (const m of mine) {
			const cmd: MessageUpdate = {
				accountId: m.accountId,
				messageId: m.id,
				...(category && { category }),
				...(spam !== null && { spam }),
			};
			await js.publish("cmd.message.update", JSON.stringify(cmd));
		}
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/unsubscribe",
		operationId: "unsubscribe",
		description:
			"Leaves a list with one click (RFC 8058), from the server, so the sender doesn't learn the reader's address.",
		request: {
			body: { content: { "application/json": { schema: z.object({ url: z.url({ protocol: /^https$/ }) }) } } },
		},
		responses: { 204: { description: "The sender took it" }, 502: { description: "The sender didn't take it" } },
	}),
	async (c) => {
		const ok = await post(c.req.valid("json").url, "application/x-www-form-urlencoded", "List-Unsubscribe=One-Click");
		return ok ? c.body(null, 204) : c.body(null, 502);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/messages/{messageId}/update",
		operationId: "updateMessage",
		description:
			"Mark a message read or unread, move it to the trash or the archive, put it into another tab, or mark it spam or not. Shows up in /changes once the server has it.",
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
							category: Category.optional(),
							spam: z.boolean().optional(),
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
							inReplyTo: z.string().optional().describe("Message-ID header of the message this answers"),
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
			// Sealed with the message's key (label att/<index>); name and type are in its Meta.
			200: { description: "The file", content: { "application/octet-stream": { schema: z.any() } } },
			404: { description: "No such attachment" },
		},
	}),
	async (c) => {
		const { accountId, messageId, index } = c.req.valid("param");
		const [found] = await db
			.select({ id: message.id })
			.from(message)
			.where(and(eq(message.id, messageId), eq(message.accountId, accountId)));
		const file = s3.file(`att/${messageId}/${index}`);
		if (!found || !(await file.exists())) return c.body(null, 404);
		return new Response(file.stream(), { headers: { "content-type": "application/octet-stream" } });
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
	inReplyTo: z.string().optional().describe("Message-ID header of the message this answers"),
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
