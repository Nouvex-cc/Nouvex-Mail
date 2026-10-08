// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { createClient } from ".";

test("health hits /health", async () => {
	const urls: string[] = [];
	const fake = (async (url: string) => {
		urls.push(url);
		return Response.json({ ok: true });
	}) as typeof fetch;
	expect(await createClient("http://x", fake).health()).toEqual({ ok: true });
	expect(urls).toEqual(["http://x/health"]);
});
