// SPDX-License-Identifier: Apache-2.0
import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { useDark } from "../../dark";
import { cn } from "../../lib";
import { cssUrl, remote } from "./mail-frame";

export type RichFrameProps = {
	/** The designed part of a rich mail (docs/rich-mail.md), unsanitized. */
	html: string;
	/** packages/rich/runtime.js, the only script that runs in the frame. */
	runtime: string;
	/** A remote picture or font as a data: URI, through the proxy. Without it nothing remote shows. */
	load?(url: string): Promise<string | undefined>;
	/** The reader confirmed a form; whether the sender took it. */
	onForm(action: string, fields: Record<string, string | string[]>): Promise<boolean>;
	/** An nx-action, like nouvex:settings/order. */
	onAction?(href: string): void;
	className?: string;
};

// The mail's markup without anything that could run or load on its own; the components are allowed through.
function clean(html: string) {
	return DOMPurify.sanitize(html, {
		WHOLE_DOCUMENT: true,
		// DOMPurify's own list plus nouvex:, which nx-action opens.
		ALLOWED_URI_REGEXP:
			/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|nouvex):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
		FORBID_TAGS: ["form", "iframe", "object", "embed", "base", "link", "meta"],
		CUSTOM_ELEMENT_HANDLING: {
			tagNameCheck: /^nx-[a-z]+$/,
			attributeNameCheck: /^(label|href|web|to|action|selected|open)$/,
			allowCustomizedBuiltInElements: false,
		},
	});
}

// A sandboxed frame doesn't learn the app's theme, so the mail's prefers-color-scheme queries are decided here.
const scheme = (css: string, dark: boolean) =>
	css.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_, s: string) =>
		(s.toLowerCase() === "dark") === dark ? "(min-width: 0)" : "(max-width: -1px)",
	);

// Every remote picture and font becomes a data: URI before the frame sees it; the frame itself can load nothing.
async function inline(html: string, dark: boolean, load?: RichFrameProps["load"]) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	// Links open outside; inside the frame they'd load the page there.
	for (const a of doc.querySelectorAll("a[href]")) {
		a.setAttribute("target", "_blank");
		a.setAttribute("rel", "noopener noreferrer");
	}
	const urls = new Set<string>();
	for (const img of doc.querySelectorAll("img")) {
		img.removeAttribute("srcset");
		const src = img.getAttribute("src") ?? "";
		if (remote.test(src)) urls.add(src);
	}
	const css = [...doc.querySelectorAll<HTMLElement>("style, [style]")];
	for (const el of css)
		for (const m of (el instanceof HTMLStyleElement ? el.textContent : el.getAttribute("style"))?.matchAll(cssUrl) ??
			[])
			if (m[2]) urls.add(m[2]);
	// ponytail: at most 40 pictures and fonts, the rest stay out; a real mail rarely has more.
	const loaded = new Map(
		await Promise.all(
			[...urls].slice(0, 40).map(async (u) => [u, load ? await load(u).catch(() => undefined) : undefined] as const),
		),
	);
	const swap = (s: string) =>
		s.replace(cssUrl, (_, q, url) => (loaded.get(url) ? `url(${q}${loaded.get(url)}${q})` : "none"));
	for (const img of doc.querySelectorAll("img")) {
		const src = img.getAttribute("src") ?? "";
		if (!remote.test(src)) continue;
		const data = loaded.get(src);
		if (data) img.setAttribute("src", data);
		else img.remove();
	}
	for (const el of css)
		if (el instanceof HTMLStyleElement) el.textContent = scheme(swap(el.textContent ?? ""), dark);
		else el.setAttribute("style", swap(el.getAttribute("style") ?? ""));
	return doc;
}

/**
 * Shows a rich mail across the whole reading area. The frame is sandboxed without its own origin, its policy lets in
 * only our runtime and data: pictures, and the runtime asks the app through postMessage for forms and actions.
 */
export function RichFrame({ html, runtime, load, onForm, onAction, className }: RichFrameProps) {
	const dark = useDark();
	const frame = useRef<HTMLIFrameElement>(null);
	const [doc, setDoc] = useState<string>();
	const latest = useRef({ onForm, onAction });
	latest.current = { onForm, onAction };

	useEffect(() => {
		let stale = false;
		void inline(clean(html), dark, load).then((d) => {
			if (stale) return;
			const nonce = crypto.randomUUID();
			const policy = `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'`;
			const meta = d.createElement("meta");
			meta.httpEquiv = "Content-Security-Policy";
			meta.content = policy;
			// The mail's own metas are gone; without this one its dark CSS wouldn't follow the frame's color scheme.
			const scheme = d.createElement("meta");
			scheme.name = "color-scheme";
			scheme.content = "light dark";
			d.head.prepend(meta, scheme);
			const script = d.createElement("script");
			script.setAttribute("nonce", nonce);
			script.textContent = runtime;
			d.body.append(script);
			setDoc(`<!doctype html>${d.documentElement.outerHTML}`);
		});
		return () => {
			stale = true;
		};
	}, [html, runtime, load, dark]);

	useEffect(() => {
		const listen = async (e: MessageEvent) => {
			const win = frame.current?.contentWindow;
			if (!win || e.source !== win) return;
			const m = e.data as { id: number; type: string; action?: string; fields?: Record<string, string>; href?: string };
			if (m.type === "action" && m.href) latest.current.onAction?.(m.href);
			if (m.type === "form" && m.action) {
				const ok = await latest.current.onForm(m.action, m.fields ?? {}).catch(() => false);
				win.postMessage({ type: "answer", id: m.id, ok }, "*");
			}
		};
		addEventListener("message", listen);
		return () => removeEventListener("message", listen);
	}, []);

	return (
		<iframe
			ref={frame}
			title="Message"
			// No allow-same-origin: the frame can run our runtime but can't reach the app.
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
			srcDoc={doc}
			// The mail's own dark design follows the frame's color scheme.
			className={cn("block h-full w-full border-0", dark ? "scheme-dark" : "scheme-light", className)}
		/>
	);
}
