// SPDX-License-Identifier: AGPL-3.0-only
import "./instrument";
import { websocket } from "hono/bun";
import { app } from "./app";
import { startPush } from "./push";

void startPush();

export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch, websocket };
