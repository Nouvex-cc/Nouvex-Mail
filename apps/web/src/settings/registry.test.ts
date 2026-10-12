// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { find, type Page } from "./registry";

const page = (id: string, title: string, entries: Page["entries"] = []): Page => ({
	id,
	title,
	icon: null,
	entries,
	render: () => null,
});

test("find matches every word across label, keywords and page title", () => {
	const pages = [
		page("appearance", "Appearance", [{ id: "mode", label: "Mode", keywords: "dark light" }]),
		page("a@x.cc", "a@x.cc", [{ id: "signature", label: "Signature" }]),
	];
	expect(find(pages, "")).toEqual([]);
	expect(find(pages, "dark").map((h) => h.entry?.id)).toEqual(["mode"]);
	expect(find(pages, "appear").map((h) => h.entry?.id)).toEqual([undefined, "mode"]);
	expect(find(pages, "SIGN a@x")).toEqual([{ page: pages[1], entry: { id: "signature", label: "Signature" } }]);
	expect(find(pages, "dark signature")).toEqual([]);
});
