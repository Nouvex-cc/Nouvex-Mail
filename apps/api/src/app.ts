// SPDX-License-Identifier: AGPL-3.0-only
import { httpInstrumentationMiddleware } from "@hono/otel";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Subscription } from "@nats-io/transport-node";
import type { MailboxSync } from "@nouvex/schema";
import { and, eq } from "drizzle-orm";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { db } from "./db";
import { mailAccount } from "./db/schema";
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
		const { accountId } = c.req.valid("param");
		const [own] = await db
			.select({ id: mailAccount.id })
			.from(mailAccount)
			.where(and(eq(mailAccount.id, accountId), eq(mailAccount.userId, c.get("userId"))));
		if (!own) return c.body(null, 404);
		await sync(accountId);
		return c.body(null, 202);
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

app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "Nouvex Mail API", version: "0.0.0" } });
