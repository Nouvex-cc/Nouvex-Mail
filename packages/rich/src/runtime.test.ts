// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { enhance, type Outgoing } from "./runtime";

test("tabs, answers and a form work without the mail running any script", async () => {
	const { document, Event } = parseHTML(`<html><body>
		<nx-tabs><nx-tab label="One">first</nx-tab><nx-tab label="Two">second</nx-tab></nx-tabs>
		<nx-accordion><nx-item label="Why?">because</nx-item></nx-accordion>
		<nx-form action="https://example.com/a"><input name="mail" value="lena@example.com"><button type="submit">Send</button></nx-form>
		<nx-action href="nouvex:settings/order">Try it</nx-action>
	</body></html>`);
	// linkedom has no constraint validation; a browser checks required fields here.
	for (const f of document.querySelectorAll("input")) Object.assign(f, { checkValidity: () => true });
	const sent: Outgoing[] = [];
	enhance(document as unknown as Document, async (m) => {
		sent.push(m);
		return true;
	});
	const tabs = [...document.querySelectorAll("[role=tab]")];
	expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
	tabs[1]?.dispatchEvent(new Event("click"));
	expect(document.querySelectorAll("nx-tab")[0]?.hasAttribute("hidden")).toBe(true);

	const question = document.querySelector("nx-item button");
	expect(question?.getAttribute("aria-expanded")).toBe("false");
	question?.dispatchEvent(new Event("click"));
	expect(question?.getAttribute("aria-expanded")).toBe("true");

	document.querySelector("nx-action")?.dispatchEvent(new Event("click"));
	document.querySelector("nx-form button")?.dispatchEvent(new Event("click"));
	await Bun.sleep(0);
	expect(sent).toEqual([
		{ type: "action", href: "nouvex:settings/order" },
		{ type: "form", action: "https://example.com/a", fields: { mail: "lena@example.com" } },
	]);
	expect(document.querySelector("nx-form")?.getAttribute("data-state")).toBe("sent");
});
