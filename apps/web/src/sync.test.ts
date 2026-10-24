// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, vi } from "vitest";

const transaction = vi.fn();
const reload = vi.fn();
vi.mock("./db", () => ({ db: { cursor: { get: async () => ({ version: 7 }) }, transaction }, local: () => ({}) }));
vi.mock("./keys", () => ({ messageKey: () => Promise.reject(new Error("wrong key")), reload }));

test("a message that doesn't open keeps the cursor where it was", async () => {
	vi.stubGlobal("fetch", async () =>
		Response.json({
			version: 9,
			more: false,
			mailboxes: { upserted: [], deleted: [] },
			messages: { upserted: [{ id: "m", key: "", sealed: "" }], deleted: [] },
		}),
	);
	const { pull } = await import("./sync");
	await expect(pull("a")).rejects.toThrow("wrong key");
	expect(transaction).not.toHaveBeenCalled();
	expect(reload).toHaveBeenCalled();
});
