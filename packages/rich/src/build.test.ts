// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { build, check, classic, maxSize, richType } from "./build";

const example = await Bun.file(new URL("../examples/groups.html", import.meta.url)).text();

const parts = (eml: string) => {
	const boundary = /boundary="([^"]+)"/.exec(eml)?.[1] ?? "";
	return eml
		.split(`--${boundary}`)
		.slice(1, -1)
		.map((p) => ({
			type: /Content-Type: ([^;\r\n]+)/.exec(p)?.[1],
			body: Buffer.from(p.split("\r\n\r\n").slice(1).join("").replace(/\s/g, ""), "base64").toString("utf8"),
		}));
};

test("plain, rich, then html, so other mail apps show the classic version", async () => {
	const eml = await build(example, { from: "Nouvex <hello@nouvex.cc>" });
	expect(eml).toContain("Subject: Your accounts, sorted the way you work");
	expect(eml).toContain("Content-Type: multipart/alternative");
	const [plain, rich, html] = parts(eml);
	expect([plain?.type, rich?.type, html?.type]).toEqual(["text/plain", richType, "text/html"]);
	expect(rich?.body).toContain("<nx-carousel");
	expect(rich?.body).toMatch(/\.rounded-3xl\{/);
	expect(html?.body).not.toContain("<nx-");
	expect(html?.body).toContain('href="https://mail.nouvex.cc/settings/order"');
	expect(plain?.body).toContain("Make your first group (https://mail.nouvex.cc/settings/order)");
});

test("the classic version lays components out flat", () => {
	const html = classic(example);
	expect(html).toContain("Focus times");
	expect(html).toContain("Do my other mail apps see groups?");
	expect(html).not.toContain("<textarea");
	expect(html).toContain("Tell us on the web");
	// Inlined for mail apps that drop <style>.
	expect(html).toMatch(/<h1 style="[^"]*font-size: 28px/);
});

test("what the client wouldn't run or load is refused", () => {
	expect(check(example)).toEqual([]);
	const bad = `<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://x"></iframe><nx-video></nx-video>`;
	expect(check(bad)).toEqual([
		"<script> isn't allowed; the client wouldn't run or load it.",
		"<iframe> isn't allowed; the client wouldn't run or load it.",
		"onclick on <p> won't run; there's no script.",
		"<nx-video> isn't a component (nx-carousel, nx-tabs, nx-tab, nx-accordion, nx-item, nx-form, nx-countdown, nx-action).",
	]);
	expect(check(`<p>${"x".repeat(maxSize)}</p>`)[0]).toContain("over 500 KB");
});
