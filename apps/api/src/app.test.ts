// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test";
import { app } from "./app";

test("health", async () => {
	const res = await app.request("/health");
	expect(await res.json()).toEqual({ ok: true });
});
