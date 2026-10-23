// SPDX-License-Identifier: Apache-2.0
// Builds a rich mail (docs/rich-mail.md): the designed version for Nouvex in a text/x-nouvex-html part, and a classic
// newsletter and plain text for every other mail app, in one multipart/alternative.
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import juice from "juice";
import { parseHTML } from "linkedom";

export const richType = "text/x-nouvex-html";
/** The rich part may be at most this big, CSS and inline images included. */
export const maxSize = 500_000;
export const components = [
	"nx-carousel",
	"nx-tabs",
	"nx-tab",
	"nx-accordion",
	"nx-item",
	"nx-form",
	"nx-countdown",
	"nx-action",
];
const forbidden = ["script", "iframe", "frame", "object", "embed", "form", "base", "link"];

/** What breaks the rules of the format, as sentences; empty when it's fine. */
export function check(rich: string) {
	const { document } = parseHTML(rich);
	const problems: string[] = [];
	if (new TextEncoder().encode(rich).length > maxSize) problems.push(`The rich part is over ${maxSize / 1000} KB.`);
	for (const tag of forbidden)
		if (document.querySelector(tag)) problems.push(`<${tag}> isn't allowed; the client wouldn't run or load it.`);
	if (document.querySelector('meta[http-equiv="refresh" i]')) problems.push("A meta refresh isn't allowed.");
	for (const el of document.querySelectorAll("*")) {
		const tag = el.tagName.toLowerCase();
		if (tag.startsWith("nx-") && !components.includes(tag))
			problems.push(`<${tag}> isn't a component (${components.join(", ")}).`);
		for (const a of el.attributes)
			if (/^on/i.test(a.name)) problems.push(`${a.name} on <${tag}> won't run; there's no script.`);
	}
	return [...new Set(problems)];
}

/** The Tailwind CSS the document uses, compiled and minified. */
export async function css(html: string) {
	const candidates = new Scanner({}).scanFiles([{ content: html, extension: "html" }]);
	const compiler = await compile(`@import "tailwindcss";`, { base: import.meta.dir, onDependency() {} });
	return optimize(compiler.build(candidates), { minify: true }).code;
}

/** The source with its Tailwind compiled into the head. */
export async function rich(source: string) {
	const { document } = parseHTML(source);
	const style = document.createElement("style");
	style.textContent = await css(source);
	document.head.append(style);
	return `<!doctype html>${document.documentElement.outerHTML}`;
}

const classicCss = `
body { margin: 0; background: #f4f3f1; }
.nx-page { width: 100%; background: #f4f3f1; }
.nx-card { width: 600px; max-width: 100%; background: #ffffff; }
.nx-card td { padding: 32px; font: 16px/1.6 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f1d1b; }
h1 { font-size: 28px; line-height: 1.25; margin: 0 0 16px; }
h2 { font-size: 22px; line-height: 1.3; margin: 24px 0 12px; }
h3 { font-size: 18px; margin: 20px 0 8px; }
p, ul, ol { margin: 0 0 16px; }
img { max-width: 100%; height: auto; border: 0; display: block; margin: 0 0 16px; }
a { color: #1f1d1b; }
a.nx-button { display: inline-block; padding: 12px 20px; background: #1f1d1b; color: #ffffff; text-decoration: none; border-radius: 8px; }
`;

/**
 * A classic newsletter from the rich source, for mail apps that don't know the format: one column, the content in
 * order, components laid out flat (slides one under another, every tab and answer open).
 */
export function classic(source: string) {
	const { document } = parseHTML(source);
	const body = document.body;
	for (const el of body.querySelectorAll("style, script, template")) el.remove();
	const heading = (text: string | null) => {
		const h = document.createElement("h3");
		h.textContent = text ?? "";
		return h;
	};
	for (const tab of body.querySelectorAll("nx-tab, nx-item")) tab.prepend(heading(tab.getAttribute("label")));
	for (const form of body.querySelectorAll("nx-form")) {
		const web = form.getAttribute("web");
		if (!web) {
			form.remove();
			continue;
		}
		const a = document.createElement("a");
		a.href = web;
		a.className = "nx-button";
		a.textContent = form.getAttribute("label") ?? "Answer on the web";
		form.replaceWith(a);
	}
	for (const c of body.querySelectorAll("nx-countdown")) {
		const to = new Date(c.getAttribute("to") ?? "");
		c.textContent = Number.isNaN(to.getTime()) ? "" : to.toUTCString().replace(/:\d\d GMT$/, " UTC");
	}
	for (const a of body.querySelectorAll("nx-action")) {
		const web = a.getAttribute("web");
		if (!web) {
			a.remove();
			continue;
		}
		const link = document.createElement("a");
		link.href = web;
		link.className = "nx-button";
		link.textContent = a.textContent?.trim() ?? "";
		a.replaceWith(link);
	}
	// Components become plain blocks, and the design's classes and inline styles don't apply here.
	for (const el of [...body.querySelectorAll("*")].reverse()) {
		if (el.tagName.toLowerCase().startsWith("nx-")) {
			const div = document.createElement("div");
			div.append(...el.childNodes);
			el.replaceWith(div);
		}
	}
	for (const el of body.querySelectorAll("[class], [style]")) {
		if (!el.classList.contains("nx-button")) el.removeAttribute("class");
		el.removeAttribute("style");
	}
	for (const el of body.querySelectorAll("input, textarea, select, button")) el.remove();
	const title = document.querySelector("title")?.textContent ?? "";
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${entities(title)}</title><style>${classicCss}</style></head><body><table role="presentation" class="nx-page" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" class="nx-card" cellpadding="0" cellspacing="0"><tr><td>${body.innerHTML}</td></tr></table></td></tr></table></body></html>`;
	return juice(html);
}

/** Plain text from the classic version: paragraphs, links after their text. */
export function text(html: string) {
	const { document } = parseHTML(html);
	for (const a of document.querySelectorAll("a[href]")) {
		const label = a.textContent?.trim() ?? "";
		const href = a.getAttribute("href") ?? "";
		a.textContent = label && label !== href ? `${label} (${href})` : href;
	}
	for (const el of document.querySelectorAll("p, h1, h2, h3, li, div, tr, br, img"))
		el.after(document.createTextNode("\n"));
	return (document.body.textContent ?? "")
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const entities = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// Base64 in lines of 76, which every mail path carries unchanged.
const base64 = (s: string) =>
	(
		Buffer.from(s, "utf8")
			.toString("base64")
			.match(/.{1,76}/g) ?? []
	).join("\r\n");
const header = (s: string) =>
	/^[\x20-\x7e]*$/.test(s) ? s : `=?utf-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

export type Options = {
	from: string;
	to?: string;
	subject?: string;
	/** The classic version; built from the rich one when left out. */
	fallback?: string;
	text?: string;
	date?: Date;
};

/**
 * The finished message. The rich part comes before text/html: mail apps show the last part they understand, so
 * everyone else shows the classic one, the way AMP for Email does it.
 */
export async function build(source: string, o: Options) {
	const problems = check(source);
	if (problems.length) throw new Error(problems.join("\n"));
	const designed = await rich(source);
	if (new TextEncoder().encode(designed).length > maxSize)
		throw new Error(`The rich part is over ${maxSize / 1000} KB with its CSS.`);
	const old = o.fallback ?? classic(source);
	const subject = o.subject ?? parseHTML(source).document.querySelector("title")?.textContent?.trim() ?? "";
	const boundary = `nx-${crypto.randomUUID()}`;
	const domain = o.from.split("@")[1]?.replace(/>.*/, "") ?? "nouvex.local";
	const part = (type: string, body: string) =>
		`--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(body)}\r\n`;
	return [
		`From: ${header(o.from)}`,
		...(o.to ? [`To: ${header(o.to)}`] : []),
		`Subject: ${header(subject)}`,
		`Date: ${(o.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${crypto.randomUUID()}@${domain}>`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		part("text/plain", o.text ?? text(old)) + part(richType, designed) + part("text/html", old) + `--${boundary}--\r\n`,
	].join("\r\n");
}
