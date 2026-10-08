// SPDX-License-Identifier: AGPL-3.0-only
import { httpInstrumentationMiddleware } from "@hono/otel";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Subscription } from "@nats-io/transport-node";
import type { MailboxSync } from "@nouvex/schema";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { nats } from "./nats";

export const app = new OpenAPIHono();

app.use("*", httpInstrumentationMiddleware({ serviceName: "nouvex-api" }));
app.use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

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
		path: "/accounts/{accountId}/sync",
		operationId: "syncAccount",
		request: { params: z.object({ accountId: z.string() }) },
		responses: { 202: { description: "Sync queued" } },
	}),
	async (c) => {
		const cmd: MailboxSync = { accountId: c.req.valid("param").accountId };
		const { js } = await nats();
		await js.publish("cmd.mailbox.sync", JSON.stringify(cmd));
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
