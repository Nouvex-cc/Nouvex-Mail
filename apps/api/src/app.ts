// SPDX-License-Identifier: AGPL-3.0-only
import { httpInstrumentationMiddleware } from "@hono/otel";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Subscription } from "@nats-io/transport-node";
import type {
	AccountCheck,
	AccountChecked,
	DomainSetup,
	DraftSave,
	ImportRun,
	MailboxSync,
	MessageSend,
	MessageUnsend,
	MessageUpdate,
	SendFeedback,
} from "@nouvex/schema";
import { s3 } from "bun";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { db } from "./db";
import {
	accountGroup,
	accountGroupMember,
	accountKey,
	accountMember,
	address as addressTable,
	changeLog,
	device,
	domain,
	importJob,
	labelColors,
	mailAccount,
	mailbox,
	message,
	outbox,
	sendEvent,
	senderRule,
	userKey,
	userPrefs,
} from "./db/schema";
import { applyCloudflare, check, cloudflare, dkimKey, dnsDeps, records } from "./domains";
import { fetchImage, post } from "./image";
import { nats } from "./nats";
import { open, seal } from "./secret";
import { fromAws, report, type Sns, snsDeps, verify } from "./sns";

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
app.use("/devices", signedIn);
app.use("/devices/*", signedIn);
app.use("/keys", signedIn);
app.use("/keys/*", signedIn);
app.use("/password", signedIn);
app.use("/accounts/*", signedIn);
app.use("/hosted-accounts", signedIn);
app.use("/domains", signedIn);
app.use("/domains/*", signedIn);
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
								kind: z.enum(["imap", "hosted"]),
								// A hosted account's keys, newest first: its private key wrapped to this user, opened with
								// their own key (packages/sdk openAccount). Mail opens with the version it was sealed to.
								keys: z.array(z.object({ version: z.int(), publicKey: z.string(), wrappedKey: z.string() })),
								// A hosted account's other addresses, which it receives and can send from.
								aliases: z.array(z.string()),
							}),
						),
					},
				},
			},
		},
	}),
	async (c) => {
		const userId = c.get("userId");
		const accounts = await db
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
				kind: mailAccount.kind,
			})
			.from(mailAccount)
			.where(eq(mailAccount.userId, userId))
			.orderBy(mailAccount.position, mailAccount.createdAt);
		const grants = await db
			.select({
				accountId: accountMember.accountId,
				version: accountMember.keyVersion,
				publicKey: accountKey.publicKey,
				wrappedKey: accountMember.wrappedKey,
			})
			.from(accountMember)
			.innerJoin(
				accountKey,
				and(eq(accountKey.accountId, accountMember.accountId), eq(accountKey.version, accountMember.keyVersion)),
			)
			.where(eq(accountMember.userId, userId))
			.orderBy(desc(accountMember.keyVersion));
		const aliases = await db
			.select({ accountId: addressTable.accountId, address: addressTable.address })
			.from(addressTable)
			.where(
				and(
					inArray(
						addressTable.accountId,
						accounts.map((a) => a.id),
					),
					eq(addressTable.kind, "alias"),
				),
			)
			.orderBy(addressTable.address);
		const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
		return c.json(
			accounts.map((a) => ({
				...a,
				keys: grants
					.filter((g) => g.accountId === a.id && g.wrappedKey)
					.map((g) => ({
						version: g.version,
						publicKey: b64(g.publicKey),
						wrappedKey: b64(g.wrappedKey as Uint8Array),
					})),
				aliases: aliases.filter((x) => x.accountId === a.id).map((x) => x.address),
			})),
			200,
		);
	},
);

// The user's verified domain an address is on, if any.
async function verifiedDomain(userId: string, address: string) {
	const name = address.slice(address.lastIndexOf("@") + 1);
	const [d] = await db
		.select({ id: domain.id })
		.from(domain)
		.where(and(eq(domain.userId, userId), eq(domain.name, name), isNotNull(domain.verifiedAt)));
	return d;
}

app.openapi(
	createRoute({
		method: "post",
		path: "/hosted-accounts",
		operationId: "createHostedAccount",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							email: z.email(),
							displayName: z.string().max(200).optional(),
							// The account's own key pair, made on the device (packages/sdk newAccountKey): the public half
							// its mail is sealed to, and the private half sealed to this user's public key.
							publicKey: z.base64(),
							wrappedKey: z.base64(),
						}),
					},
				},
			},
		},
		responses: {
			201: {
				description: "Mailbox created, its folders are being made",
				content: { "application/json": { schema: z.object({ id: z.string() }) } },
			},
			422: {
				description: "We don't host mail for this address",
				content: { "application/json": { schema: z.object({ error: z.string() }) } },
			},
		},
	}),
	async (c) => {
		const { email, displayName, publicKey, wrappedKey } = c.req.valid("json");
		const address = email.toLowerCase();
		const on = await verifiedDomain(c.get("userId"), address);
		if (!on) return c.json({ error: "Add and verify this address's domain first (Settings, Domains)." }, 422);
		const pub = Buffer.from(publicKey, "base64");
		if (pub.length !== 32) return c.json({ error: "That's not an account key." }, 422);
		const id = crypto.randomUUID();
		const taken = await db.transaction(async (tx) => {
			// One mailbox per address; locked so two at once can't both take it.
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${address}))`);
			const [there] = await tx.select().from(addressTable).where(eq(addressTable.address, address));
			if (there) return true;
			await tx.insert(mailAccount).values({
				id,
				userId: c.get("userId"),
				email: address,
				displayName: displayName ?? "",
				kind: "hosted",
				imapHost: "",
				imapPort: 0,
				smtpHost: "",
				smtpPort: 0,
				username: "",
				secret: new Uint8Array(),
				sealedTo: pub,
			});
			await tx.insert(accountKey).values({ accountId: id, version: 1, publicKey: pub });
			await tx.insert(accountMember).values({
				accountId: id,
				userId: c.get("userId"),
				role: "owner",
				keyVersion: 1,
				wrappedKey: Buffer.from(wrappedKey, "base64"),
			});
			await tx.insert(addressTable).values({ address, accountId: id, domainId: on.id, kind: "primary" });
			return false;
		});
		if (taken) return c.json({ error: `${address} is taken.` }, 422);
		await sync(id);
		return c.json({ id }, 201);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/webhooks/ses",
		operationId: "sesEvents",
		description:
			"Amazon SES's bounces and complaints, through SNS (text/plain JSON, signed by AWS). Only SES_TOPIC_ARN is taken.",
		responses: { 200: { description: "Taken" }, 403: { description: "Not signed by AWS, or not our topic" } },
	}),
	async (c) => {
		const m = JSON.parse(await c.req.text()) as Sns;
		if (!process.env.SES_TOPIC_ARN || m.TopicArn !== process.env.SES_TOPIC_ARN || !(await verify(m)))
			return c.body(null, 403);
		if (m.Type === "SubscriptionConfirmation") {
			if (!fromAws(m.SubscribeURL)) return c.body(null, 403);
			await snsDeps.fetch(m.SubscribeURL as string);
			return c.body(null, 200);
		}
		const said = m.Type === "Notification" ? report(m.Message) : undefined;
		if (!said) return c.body(null, 200);
		const [acc] = await db.select({ id: mailAccount.id }).from(mailAccount).where(eq(mailAccount.id, said.accountId));
		if (!acc) return c.body(null, 200);
		await db.insert(sendEvent).values({ id: crypto.randomUUID(), accountId: acc.id, kind: said.report.kind });
		// Over 30 days, more than 0.1% complaints, or more than 5% bounces (5 at least), pause sending outside Nouvex
		// until someone has looked (docs/deploy.md, Hosted mail).
		await db.execute(sql`
			UPDATE mail_account SET sending_paused_at = now()
			WHERE id = ${acc.id} AND sending_paused_at IS NULL AND EXISTS (
				SELECT 1 FROM
					(SELECT count(*) FILTER (WHERE kind = 'complaint') AS complaints, count(*) FILTER (WHERE kind = 'bounce') AS bounces
					FROM send_event WHERE account_id = ${acc.id} AND created_at > now() - interval '30 days') e,
					(SELECT coalesce(sum(count), 0) AS sent FROM send_count WHERE account_id = ${acc.id} AND day > current_date - 30) s
				WHERE e.complaints > 0.001 * s.sent OR (e.bounces >= 5 AND e.bounces > 0.05 * s.sent))`);
		// It names who the mail went to, so it travels sealed until the engine seals it for the sender.
		const cmd: SendFeedback = {
			accountId: acc.id,
			sealed: (await seal(JSON.stringify(said.report))).toString("base64"),
		};
		const { js } = await nats();
		await js.publish("cmd.send.feedback", JSON.stringify(cmd));
		return c.body(null, 200);
	},
);

// Domains: added by anyone, verified by one (a TXT record), then they take hosted mailboxes and aliases.
const DomainOut = z.object({
	id: z.string(),
	name: z.string(),
	verified: z.boolean(),
	catchAllAccountId: z.string().nullable(),
	checkedAt: z.string().nullable(),
	// Amazon SES's view once verified: "ready", what it waits for, or what went wrong; null before it's asked.
	sesStatus: z.string().nullable(),
	// What the domain's DNS needs, with what the last check found (ok is null before the first).
	records: z.array(
		z.object({
			key: z.string(),
			type: z.enum(["TXT", "MX"]),
			name: z.string(),
			value: z.string(),
			priority: z.int().optional(),
			ok: z.boolean().nullable(),
			found: z.array(z.string()),
		}),
	),
});
const shown = (d: typeof domain.$inferSelect) => ({
	id: d.id,
	name: d.name,
	verified: !!d.verifiedAt,
	catchAllAccountId: d.catchAllAccountId,
	checkedAt: d.checkedAt?.toISOString() ?? null,
	sesStatus: d.sesStatus,
	records: records(d).map((r) => ({
		...r,
		ok: d.dnsCheck?.[r.key]?.ok ?? null,
		found: d.dnsCheck?.[r.key]?.found ?? [],
	})),
});
const ownDomain = async (userId: string, id: string) =>
	(
		await db
			.select()
			.from(domain)
			.where(and(eq(domain.id, id), eq(domain.userId, userId)))
	)[0];
const DomainParam = z.object({ domainId: z.string() });
const Problem = { "application/json": { schema: z.object({ error: z.string() }) } };

// Looks the records up and keeps what was found; the first time the TXT record shows, the domain is the user's.
async function recheck(d: typeof domain.$inferSelect) {
	const result = await check(records(d), dnsDeps.lookup());
	let verifiedAt = d.verifiedAt;
	if (!verifiedAt && result.verify?.ok) {
		verifiedAt = new Date();
		await db.transaction(async (tx) => {
			// Others who added the name without verifying it lose their claim.
			await tx.delete(domain).where(and(eq(domain.name, d.name), ne(domain.id, d.id), sql`verified_at IS NULL`));
			await tx.update(domain).set({ verifiedAt }).where(eq(domain.id, d.id));
		});
	}
	const [row] = await db
		.update(domain)
		.set({ dnsCheck: result, checkedAt: new Date() })
		.where(eq(domain.id, d.id))
		.returning();
	// A verified domain gets set up with SES, and each check after asks it how far it is.
	if (verifiedAt) {
		const cmd: DomainSetup = { domainId: d.id };
		const { js } = await nats();
		await js.publish("cmd.domain.setup", JSON.stringify(cmd));
	}
	return row ?? { ...d, verifiedAt };
}

app.openapi(
	createRoute({
		method: "get",
		path: "/domains",
		operationId: "listDomains",
		responses: {
			200: { description: "The user's domains", content: { "application/json": { schema: z.array(DomainOut) } } },
		},
	}),
	async (c) =>
		c.json(
			(
				await db
					.select()
					.from(domain)
					.where(eq(domain.userId, c.get("userId")))
					.orderBy(domain.name)
			).map(shown),
			200,
		),
);

app.openapi(
	createRoute({
		method: "post",
		path: "/domains",
		operationId: "addDomain",
		request: { body: { content: { "application/json": { schema: z.object({ name: z.string() }) } } } },
		responses: {
			201: { description: "Added; it receives once verified", content: { "application/json": { schema: DomainOut } } },
			422: { description: "Not a domain, or someone verified it already", content: Problem },
		},
	}),
	async (c) => {
		const name = c.req.valid("json").name.trim().toLowerCase().replace(/\.$/, "");
		if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name))
			return c.json({ error: "That's not a domain." }, 422);
		const [taken] = await db
			.select({ userId: domain.userId })
			.from(domain)
			.where(and(eq(domain.name, name), isNotNull(domain.verifiedAt)));
		if (taken) return c.json({ error: `${name} is already set up with Nouvex.` }, 422);
		const [mine] = await db
			.select()
			.from(domain)
			.where(and(eq(domain.name, name), eq(domain.userId, c.get("userId"))));
		if (mine) return c.json(shown(mine), 201);
		const key = await dkimKey();
		const [row] = await db
			.insert(domain)
			.values({
				id: crypto.randomUUID(),
				userId: c.get("userId"),
				name,
				verifyToken: crypto.getRandomValues(new Uint8Array(16)).toHex(),
				dkimPublic: key.publicKey,
				dkimPrivate: await seal(key.privateKey),
			})
			.returning();
		if (!row) throw new Error("domain not added");
		return c.json(shown(row), 201);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/domains/{domainId}/check",
		operationId: "checkDomain",
		request: { params: DomainParam },
		responses: {
			200: {
				description: "Its DNS as the internet sees it now",
				content: { "application/json": { schema: DomainOut } },
			},
			404: { description: "Not the user's" },
		},
	}),
	async (c) => {
		const d = await ownDomain(c.get("userId"), c.req.valid("param").domainId);
		if (!d) return c.body(null, 404);
		return c.json(shown(await recheck(d)), 200);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/domains/{domainId}/cloudflare",
		operationId: "setUpDomainInCloudflare",
		description:
			"Adds the records with a Cloudflare API token (Zone DNS edit), used for this request only and never kept.",
		request: {
			params: DomainParam,
			body: {
				content: {
					"application/json": {
						// replaceMx moves where the domain's mail goes: other MX records are removed.
						schema: z.object({ token: z.string().min(1), replaceMx: z.boolean() }),
					},
				},
			},
		},
		responses: {
			200: {
				description: "What was done per record, then checked",
				content: {
					"application/json": {
						schema: z.object({
							applied: z.record(z.string(), z.enum(["created", "updated", "there", "conflict"])),
							domain: DomainOut,
						}),
					},
				},
			},
			404: { description: "Not the user's" },
			422: { description: "Cloudflare refused", content: Problem },
		},
	}),
	async (c) => {
		const d = await ownDomain(c.get("userId"), c.req.valid("param").domainId);
		if (!d) return c.body(null, 404);
		const { token, replaceMx } = c.req.valid("json");
		try {
			const applied = await applyCloudflare(cloudflare(token, dnsDeps.fetch), d.name, records(d), replaceMx);
			return c.json({ applied, domain: shown(await recheck(d)) }, 200);
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Cloudflare refused." }, 422);
		}
	},
);

app.openapi(
	createRoute({
		method: "patch",
		path: "/domains/{domainId}",
		operationId: "updateDomain",
		request: {
			params: DomainParam,
			body: {
				content: {
					"application/json": {
						// Mail to an address nobody has goes to this mailbox instead of being refused; null refuses it.
						schema: z.object({ catchAllAccountId: z.string().nullable() }),
					},
				},
			},
		},
		responses: {
			200: { description: "Changed", content: { "application/json": { schema: DomainOut } } },
			404: { description: "Not the user's" },
			422: { description: "Not a hosted mailbox of the user", content: Problem },
		},
	}),
	async (c) => {
		const d = await ownDomain(c.get("userId"), c.req.valid("param").domainId);
		if (!d) return c.body(null, 404);
		const { catchAllAccountId } = c.req.valid("json");
		if (catchAllAccountId) {
			const [mine] = await db
				.select({ id: mailAccount.id })
				.from(mailAccount)
				.where(
					and(
						eq(mailAccount.id, catchAllAccountId),
						eq(mailAccount.userId, c.get("userId")),
						eq(mailAccount.kind, "hosted"),
					),
				);
			if (!mine) return c.json({ error: "Pick one of your mailboxes Nouvex hosts." }, 422);
		}
		const [row] = await db.update(domain).set({ catchAllAccountId }).where(eq(domain.id, d.id)).returning();
		return c.json(shown(row ?? d), 200);
	},
);

app.openapi(
	createRoute({
		method: "delete",
		path: "/domains/{domainId}",
		operationId: "removeDomain",
		request: { params: DomainParam },
		responses: {
			204: { description: "Removed" },
			404: { description: "Not the user's" },
			409: { description: "Mailboxes or aliases still use it", content: Problem },
		},
	}),
	async (c) => {
		const d = await ownDomain(c.get("userId"), c.req.valid("param").domainId);
		if (!d) return c.body(null, 404);
		const [used] = await db.select().from(addressTable).where(eq(addressTable.domainId, d.id)).limit(1);
		if (used) return c.json({ error: "Remove its mailboxes and aliases first." }, 409);
		await db.delete(domain).where(eq(domain.id, d.id));
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/aliases",
		operationId: "addAlias",
		description: "Another address of a hosted mailbox, on one of the user's verified domains.",
		request: {
			params: z.object({ accountId: z.string() }),
			body: { content: { "application/json": { schema: z.object({ address: z.email() }) } } },
		},
		responses: { 204: { description: "Added" }, 422: { description: "Not possible", content: Problem } },
	}),
	async (c) => {
		const { accountId } = c.req.valid("param");
		const address = c.req.valid("json").address.toLowerCase();
		const [acc] = await db.select({ kind: mailAccount.kind }).from(mailAccount).where(eq(mailAccount.id, accountId));
		if (acc?.kind !== "hosted") return c.json({ error: "Only mailboxes Nouvex hosts have aliases." }, 422);
		const on = await verifiedDomain(c.get("userId"), address);
		if (!on) return c.json({ error: "Add and verify this address's domain first (Settings, Domains)." }, 422);
		const added = await db
			.insert(addressTable)
			.values({ address, accountId, domainId: on.id, kind: "alias" })
			.onConflictDoNothing()
			.returning();
		if (!added.length) return c.json({ error: `${address} is taken.` }, 422);
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "delete",
		path: "/accounts/{accountId}/aliases/{address}",
		operationId: "removeAlias",
		request: { params: z.object({ accountId: z.string(), address: z.string() }) },
		responses: { 204: { description: "Removed; mail to it is refused from now on" } },
	}),
	async (c) => {
		const { accountId, address } = c.req.valid("param");
		await db
			.delete(addressTable)
			.where(
				and(
					eq(addressTable.accountId, accountId),
					eq(addressTable.address, address.toLowerCase()),
					eq(addressTable.kind, "alias"),
				),
			);
		return c.body(null, 204);
	},
);

// Importing: mail from another of the user's accounts (an IMAP one) moves into a hosted mailbox, folder by folder,
// into the folders the user picked. The source stays as it was.
const ImportOut = z.object({
	id: z.string(),
	sourceId: z.string(),
	done: z.int(),
	// Null until the engine has counted the source folders.
	total: z.int().nullable(),
	error: z.string().nullable(),
	createdAt: z.string(),
	finishedAt: z.string().nullable(),
});
const hostedRoles = ["inbox", "archive", "sent", "drafts", "junk", "trash"] as const;

app.openapi(
	createRoute({
		method: "get",
		path: "/accounts/{accountId}/imports",
		operationId: "listImports",
		request: { params: z.object({ accountId: z.string() }) },
		responses: {
			200: { description: "Newest first", content: { "application/json": { schema: z.array(ImportOut) } } },
		},
	}),
	async (c) => {
		const rows = await db
			.select()
			.from(importJob)
			.where(eq(importJob.accountId, c.req.valid("param").accountId))
			.orderBy(desc(importJob.createdAt));
		return c.json(
			rows.map((j) => ({
				id: j.id,
				sourceId: j.sourceId,
				done: j.done,
				total: j.total,
				error: j.error,
				createdAt: j.createdAt.toISOString(),
				finishedAt: j.finishedAt?.toISOString() ?? null,
			})),
			200,
		);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/imports",
		operationId: "startImport",
		description:
			"Moves the mail of the source account's folders into this hosted mailbox: each into a folder for a role, or into a folder of its own by name. Folders left out stay behind.",
		request: {
			params: z.object({ accountId: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							sourceId: z.string(),
							folders: z
								.array(
									z.object({
										from: z.string(),
										role: z.enum([...hostedRoles, ""]),
										name: z.string().trim().max(100),
									}),
								)
								.min(1)
								.max(500),
						}),
					},
				},
			},
		},
		responses: {
			201: { description: "Started", content: { "application/json": { schema: z.object({ id: z.string() }) } } },
			422: { description: "Not possible", content: Problem },
		},
	}),
	async (c) => {
		const { accountId } = c.req.valid("param");
		const { sourceId, folders } = c.req.valid("json");
		const [acc] = await db.select({ kind: mailAccount.kind }).from(mailAccount).where(eq(mailAccount.id, accountId));
		if (acc?.kind !== "hosted") return c.json({ error: "Mail can only be imported into mailboxes Nouvex hosts." }, 422);
		const [source] = await db
			.select({ kind: mailAccount.kind })
			.from(mailAccount)
			.where(and(eq(mailAccount.id, sourceId), eq(mailAccount.userId, c.get("userId"))));
		if (source?.kind !== "imap") return c.json({ error: "Import from one of your other mail accounts." }, 422);
		const known = new Set(
			(await db.select({ name: mailbox.name }).from(mailbox).where(eq(mailbox.accountId, sourceId))).map((b) => b.name),
		);
		if (folders.some((f) => !known.has(f.from) || (f.role === "" && !f.name)))
			return c.json({ error: "Pick folders of that account, and name the ones of your own." }, 422);
		const [running] = await db
			.select({ id: importJob.id })
			.from(importJob)
			.where(and(eq(importJob.accountId, accountId), isNull(importJob.finishedAt), isNull(importJob.error)));
		if (running) return c.json({ error: "An import into this mailbox is still running." }, 422);
		const id = crypto.randomUUID();
		await db.insert(importJob).values({ id, accountId, sourceId, folders });
		const cmd: ImportRun = { accountId, jobId: id };
		const { js } = await nats();
		await js.publish("cmd.import.run", JSON.stringify(cmd));
		return c.json({ id }, 201);
	},
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
				content: {
					"application/json": {
						schema: z.object({
							email: z.string(),
							// After a reset: the key that was, wrapped with the recovery key only its owner has. Opening it
							// keeps the key and everything sealed to it.
							recovery: z.object({ publicKey: z.string(), wrapped: z.string() }).nullable(),
						}),
					},
				},
			},
			404: { description: "Used or expired" },
		},
	}),
	async (c) => {
		const ctx = await auth.$context;
		const row = await ctx.internalAdapter.findVerificationValue(`invite:${c.req.valid("param").token}`);
		const user = row && row.expiresAt > new Date() && (await ctx.internalAdapter.findUserById(row.value));
		if (!user) return c.body(null, 404);
		const [kept] = await db.select().from(userKey).where(eq(userKey.userId, user.id));
		const recovery = kept?.recoveryWrapped
			? { publicKey: kept.publicKey.toBase64(), wrapped: kept.recoveryWrapped.toBase64() }
			: null;
		return c.json({ email: user.email, recovery }, 200);
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
		const [before] = await db.select().from(userKey).where(eq(userKey.userId, userId));
		const keys = {
			publicKey: Uint8Array.fromBase64(publicKey),
			wrappedPrivate: Uint8Array.fromBase64(wrappedPrivate),
			// The same key, opened with the recovery key, keeps its recovery; a new one has none yet.
			recoveryWrapped:
				before && Buffer.from(before.publicKey).equals(Buffer.from(publicKey, "base64"))
					? before.recoveryWrapped
					: null,
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
		method: "post",
		path: "/devices",
		operationId: "registerDevice",
		description: "An iPhone that gets a push for new mail. Registering a token again updates it.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							/** The APNs device token, hex. */
							token: z.string().regex(/^[0-9a-f]{64,200}$/),
							/** From a debug build: pushed through APNs' sandbox. */
							sandbox: z.boolean(),
							/** Where the device is, for focus times, like Europe/Berlin. */
							timeZone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz)),
						}),
					},
				},
			},
		},
		responses: { 204: { description: "Saved" } },
	}),
	async (c) => {
		const { token, sandbox, timeZone } = c.req.valid("json");
		const userId = c.get("userId");
		// A token belongs to whoever signed in on the device last.
		await db
			.insert(device)
			.values({ token, userId, sandbox, timeZone })
			.onConflictDoUpdate({ target: device.token, set: { userId, sandbox, timeZone } });
		return c.body(null, 204);
	},
);

app.openapi(
	createRoute({
		method: "delete",
		path: "/devices/{token}",
		operationId: "removeDevice",
		description: "No more pushes for this device, on signing out.",
		request: { params: z.object({ token: z.string() }) },
		responses: { 204: { description: "Removed, or wasn't there" } },
	}),
	async (c) => {
		await db
			.delete(device)
			.where(and(eq(device.token, c.req.valid("param").token), eq(device.userId, c.get("userId"))));
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
				description: "The user's key pair, the private half wrapped, and whether a recovery key is set",
				content: { "application/json": { schema: Keys.extend({ recovery: z.boolean() }) } },
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
		return c.json(
			{
				publicKey: row.publicKey.toBase64(),
				wrappedPrivate: row.wrappedPrivate.toBase64(),
				recovery: !!row.recoveryWrapped,
			},
			200,
		);
	},
);

app.openapi(
	createRoute({
		method: "put",
		path: "/keys/recovery",
		operationId: "setRecovery",
		description:
			"Keeps the private key wrapped with a new recovery key, made on the device; an older one stops working.",
		request: {
			body: {
				content: {
					"application/json": {
						// password is the authKey, asked again because a recovery key opens everything.
						schema: z.object({ password: z.string(), recoveryWrapped: z.base64() }),
					},
				},
			},
		},
		responses: {
			204: { description: "Kept" },
			400: {
				description: "The password is wrong",
				content: { "application/json": { schema: z.object({ message: z.string() }) } },
			},
		},
	}),
	async (c) => {
		const { password, recoveryWrapped } = c.req.valid("json");
		const ok = await auth.api
			.verifyPassword({ body: { password }, headers: c.req.raw.headers })
			.then(() => true)
			.catch(() => false);
		if (!ok) return c.json({ message: "That's not your password." }, 400);
		await db
			.update(userKey)
			.set({ recoveryWrapped: Uint8Array.fromBase64(recoveryWrapped) })
			.where(eq(userKey.userId, c.get("userId")));
		return c.body(null, 204);
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
						({ accountId: _, uid: __, refs: ___, messageId: ____, sentAt, key, sealed, category, ...m }) => ({
							...m,
							// The Apple app drops a whole page over a tab it doesn't know.
							category: Category.safeParse(category).data ?? "primary",
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

// An address, or one with a name: "Lena Hartmann <lena@x.example>". No line breaks, they would end the header.
const Recipient = z
	.string()
	.max(320)
	.regex(/^(?:[^<>\r\n]*<\s*)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+(?:\s*>)?$/, "Not an email address");
const MessageId = z
	.string()
	.max(998)
	.regex(/^<?[^\s<>]+>?$/, "Not a Message-ID");
const Attachments = z.array(z.object({ id: z.uuid(), name: z.string().max(255), type: z.string().max(255) })).max(20);
// The limits keep a command below what one NATS message holds (1 MB), quote included.
const maxFiles = 25 * 1024 * 1024;

const Outgoing = z
	.object({
		to: z.array(Recipient).default([]),
		cc: z.array(Recipient).default([]),
		bcc: z.array(Recipient).default([]),
		subject: z
			.string()
			.max(998)
			.regex(/^[^\r\n]*$/),
		text: z.string().max(200_000),
		html: z.string().max(600_000).optional().describe("A version with formatting, like a forwarded message"),
		inReplyTo: MessageId.optional().describe("Message-ID header of the message this answers"),
		references: z.array(MessageId).max(20).optional().describe("Message-IDs of the conversation, oldest first"),
		draftId: z
			.uuid()
			.optional()
			.describe("The draft it was written in, the key of the send: a draft goes out once, however often it's sent"),
		sendAt: z.iso.datetime().optional(),
		attachments: Attachments.optional(),
		from: z.email().optional().describe("An alias of a hosted account to send from; the engine checks it's theirs"),
	})
	.refine((m) => m.to.length + m.cc.length + m.bcc.length > 0, "Nobody to send it to")
	.refine((m) => m.to.length + m.cc.length + m.bcc.length <= 100, "At most 100 recipients");

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/send",
		operationId: "sendMessage",
		description:
			"Sends a message, now or at sendAt. The outcome arrives as an evt.message.sent event on /ws, with the draftId. A message that can't be sent comes back to Drafts.",
		request: {
			params: z.object({ accountId: z.string() }),
			body: { content: { "application/json": { schema: Outgoing } } },
		},
		responses: {
			202: {
				description: "Queued for sending",
				content: { "application/json": { schema: z.object({ draftId: z.uuid() }) } },
			},
			404: { description: "No such account" },
			413: { description: "The attachments are over 25 MB together" },
			422: { description: "An attachment isn't there (anymore)" },
		},
	}),
	async (c) => {
		const { accountId } = c.req.valid("param");
		const body = c.req.valid("json");
		const cmd: MessageSend = { accountId, ...body, draftId: body.draftId ?? crypto.randomUUID() };
		const sizes = await Promise.all(
			(cmd.attachments ?? []).map((a) =>
				s3
					.file(`upload/${accountId}/${a.id}`)
					.stat()
					.then((st) => st.size)
					.catch(() => undefined),
			),
		);
		if (sizes.includes(undefined)) return c.body(null, 422);
		if (sizes.reduce<number>((a, b) => a + (b ?? 0), 0) > maxFiles) return c.body(null, 413);
		const { js } = await nats();
		await js.publish("cmd.message.send", JSON.stringify(cmd));
		return c.json({ draftId: cmd.draftId }, 202);
	},
);

app.openapi(
	createRoute({
		method: "post",
		path: "/accounts/{accountId}/unsend",
		operationId: "unsendMessage",
		description:
			"Takes a sent message back out of the Nouvex mailboxes it went into directly. Mail that left Nouvex can't come back.",
		request: {
			params: z.object({ accountId: z.string() }),
			body: { content: { "application/json": { schema: z.object({ messageId: z.string().min(1).max(998) }) } } },
		},
		responses: { 202: { description: "Queued" } },
	}),
	async (c) => {
		const cmd: MessageUnsend = { accountId: c.req.valid("param").accountId, messageId: c.req.valid("json").messageId };
		const { js } = await nats();
		await js.publish("cmd.message.unsend", JSON.stringify(cmd));
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
	to: z.array(Recipient).max(100),
	cc: z.array(Recipient).max(100).default([]),
	bcc: z.array(Recipient).max(100).default([]),
	subject: z
		.string()
		.max(998)
		.regex(/^[^\r\n]*$/),
	text: z.string().max(200_000),
	html: z.string().max(600_000).optional(),
	inReplyTo: MessageId.optional().describe("Message-ID header of the message this answers"),
	rev: z.int().optional().describe("When the client wrote this version, in milliseconds: a late older one is dropped"),
	attachments: Attachments.optional().describe("Uploaded files the draft keeps"),
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

const Waiting = z.object({
	draftId: z.string(),
	state: z.enum(["scheduled", "failed"]),
	runAt: z.iso.datetime().nullable(),
	error: z.string().nullable().describe("Why it couldn't be sent; it's back in Drafts"),
	to: z.array(z.string()),
	subject: z.string(),
});

app.openapi(
	createRoute({
		method: "get",
		path: "/accounts/{accountId}/outbox",
		operationId: "listOutbox",
		description: "Messages waiting to go out later, and ones that couldn't be sent, newest first.",
		request: { params: z.object({ accountId: z.string() }) },
		responses: {
			200: { description: "The outbox", content: { "application/json": { schema: z.array(Waiting) } } },
			404: { description: "No such account" },
		},
	}),
	async (c) => {
		const rows = await db
			.select()
			.from(outbox)
			.where(and(eq(outbox.accountId, c.req.valid("param").accountId), inArray(outbox.state, ["scheduled", "failed"])))
			.orderBy(desc(outbox.updatedAt));
		const list = await Promise.all(
			rows.map(async (r) => {
				const cmd = JSON.parse(await open(new Uint8Array(r.payload))) as MessageSend;
				return {
					draftId: r.draftId,
					state: r.state as "scheduled" | "failed",
					runAt: r.runAt?.toISOString() ?? null,
					error: r.error,
					to: [...cmd.to, ...cmd.cc, ...cmd.bcc],
					subject: cmd.subject,
				};
			}),
		);
		return c.json(list, 200);
	},
);

app.openapi(
	createRoute({
		method: "delete",
		path: "/accounts/{accountId}/outbox/{draftId}",
		operationId: "cancelSend",
		description:
			"Takes a scheduled message out of the outbox and back into Drafts, or forgets that one couldn't be sent.",
		request: { params: z.object({ accountId: z.string(), draftId: z.string() }) },
		responses: {
			202: { description: "Back in Drafts, or forgotten" },
			404: { description: "Not in the outbox" },
			409: { description: "It's going out right now" },
		},
	}),
	async (c) => {
		const { accountId, draftId } = c.req.valid("param");
		const [gone] = await db
			.delete(outbox)
			.where(
				and(
					eq(outbox.accountId, accountId),
					eq(outbox.draftId, draftId),
					inArray(outbox.state, ["scheduled", "failed"]),
				),
			)
			.returning();
		if (!gone) {
			const [busy] = await db.select({ state: outbox.state }).from(outbox).where(eq(outbox.draftId, draftId));
			return c.body(null, busy?.state === "sending" ? 409 : 404);
		}
		// A failed one is back in Drafts already.
		if (gone.state === "failed") return c.body(null, 202);
		const cmd = JSON.parse(await open(new Uint8Array(gone.payload))) as MessageSend;
		// Its files wait under outbox/ while it's scheduled; a draft keeps them where uploads are.
		for (const a of cmd.attachments ?? []) {
			const kept = s3.file(`outbox/${draftId}/${a.id}`);
			await s3.file(`upload/${accountId}/${a.id}`).write(kept);
			await kept.delete();
		}
		const { draftId: _, sendAt: __, references: ___, ...rest } = cmd;
		await draft({ ...rest, draftId, rev: Date.now() });
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
