// SPDX-License-Identifier: Apache-2.0
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib";
import { Button } from "../button";

export type MailFrameProps = {
	html: string;
	allowRemoteImages?: boolean;
	onAllowRemoteImages?(): void;
	/** Routes allowed remote images through the image proxy. */
	proxy?(url: string): string;
	className?: string;
};

const remote = /^https?:\/\//i;
const cssUrl = /url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi;

// Inside the frame: a light card in both themes (mails bring their own colors), readable defaults, quotes hidden
// until the toggle outside shows them.
const base = `<style>
	:root { color-scheme: light; }
	html { background: #fff; color: #1f1d1b; }
	body { margin: 0; padding: 16px 20px; font: 14px/1.55 "Schibsted Grotesk Variable", system-ui, -apple-system, sans-serif; overflow-wrap: anywhere; }
	body > * { max-width: 72ch; }
	img { max-width: 100%; height: auto; }
	img[data-src] { display: none; }
	a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
	blockquote { margin: 0 0 0 4px; padding-left: 12px; border-left: 2px solid #e2ded9; color: #6b655f; }
	body:not(.show-quote) [data-nx-quote] { display: none; }
</style>`;

/** Sanitizes the mail, blocks remote content unless allowed, and marks quoted history so it can fold away. */
function prepare(html: string, allow: boolean, proxy?: (url: string) => string) {
	// FORCE_BODY keeps a leading <style>, which most HTML mails rely on.
	const clean = DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["form"], FORCE_BODY: true });
	const doc = new DOMParser().parseFromString(clean, "text/html");
	let blocked = 0;
	const load = (url: string) => (proxy ? proxy(url) : url);

	for (const a of doc.querySelectorAll("a")) {
		a.setAttribute("target", "_blank");
		a.setAttribute("rel", "noopener noreferrer");
	}
	for (const img of doc.querySelectorAll("img")) {
		const src = img.getAttribute("src") ?? "";
		if (remote.test(src)) {
			if (allow) img.setAttribute("src", load(src));
			else {
				img.setAttribute("data-src", src);
				img.removeAttribute("src");
				blocked++;
			}
		}
		if (img.hasAttribute("srcset")) {
			if (!allow) blocked++;
			img.removeAttribute("srcset");
		}
	}
	for (const el of doc.querySelectorAll<HTMLElement>("[style], [background]")) {
		const style = el.getAttribute("style");
		if (style && cssUrl.test(style)) {
			cssUrl.lastIndex = 0;
			el.setAttribute(
				"style",
				style.replace(cssUrl, (_, q, url) => (allow ? `url(${q}${load(url)}${q})` : "none")),
			);
			if (!allow) blocked++;
		}
		const bg = el.getAttribute("background");
		if (bg && remote.test(bg)) {
			if (allow) el.setAttribute("background", load(bg));
			else {
				el.removeAttribute("background");
				blocked++;
			}
		}
	}

	for (const style of doc.querySelectorAll("style")) {
		const css = style.textContent ?? "";
		const swapped = css.replace(cssUrl, (_, q, url) => (allow ? `url(${q}${load(url)}${q})` : "none"));
		if (swapped !== css) {
			style.textContent = swapped;
			if (!allow) blocked++;
		}
	}

	const quote = doc.querySelector(".gmail_quote, blockquote[type='cite'], body > blockquote");
	if (quote) {
		quote.setAttribute("data-nx-quote", "");
		const before = quote.previousElementSibling;
		if (before && /^(on .+ wrote|am .+ schrieb .+):?\s*$/i.test(before.textContent?.trim() ?? ""))
			before.setAttribute("data-nx-quote", "");
	}
	return { body: doc.body.innerHTML, blocked, quoted: !!quote };
}

/** Renders a mail in a sandboxed frame (no scripts) that grows with its content, so it never scrolls on its own. */
export function MailFrame({ html, allowRemoteImages, onAllowRemoteImages, proxy, className }: MailFrameProps) {
	const [allowedHere, setAllowedHere] = useState(false);
	const allow = allowRemoteImages ?? allowedHere;
	const [showQuote, setShowQuote] = useState(false);
	const [ready, setReady] = useState(false);
	const frame = useRef<HTMLIFrameElement>(null);
	const { body, blocked, quoted } = useMemo(() => prepare(html, allow, proxy), [html, allow, proxy]);

	// Follow the content's height; quotes toggle in place without reloading the frame.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new body reloads the frame, so the observer reattaches
	useEffect(() => {
		const el = frame.current;
		if (!el) return;
		let resize: ResizeObserver | undefined;
		const onLoad = () => {
			const doc = el.contentDocument;
			if (!doc) return;
			doc.body.classList.toggle("show-quote", showQuote);
			const fit = () => {
				el.style.height = `${doc.documentElement.scrollHeight}px`;
			};
			resize?.disconnect();
			resize = new ResizeObserver(fit);
			resize.observe(doc.documentElement);
			fit();
			requestAnimationFrame(() => setReady(true));
		};
		el.addEventListener("load", onLoad);
		if (el.contentDocument?.readyState === "complete") onLoad();
		return () => {
			el.removeEventListener("load", onLoad);
			resize?.disconnect();
		};
	}, [body, showQuote]);

	return (
		<div className={cn("grid gap-2", className)}>
			{blocked > 0 && !allow && (
				<div className="flex items-center justify-between gap-3 rounded-md bg-sunken py-1 pr-1 pl-3 text-sm text-muted">
					Remote images are hidden
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setAllowedHere(true);
							onAllowRemoteImages?.();
						}}
					>
						Show
					</Button>
				</div>
			)}
			<iframe
				ref={frame}
				title="Message"
				srcDoc={`<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${base}</head><body>${body}</body></html>`}
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				className="block h-0 w-full overflow-hidden rounded-lg border border-line data-[ready]:transition-all data-[ready]:duration-150 data-[ready]:ease-out"
				data-ready={ready || undefined}
			/>
			{quoted && (
				<button
					type="button"
					aria-label={showQuote ? "Hide quoted text" : "Show quoted text"}
					aria-expanded={showQuote}
					onClick={() => setShowQuote((s) => !s)}
					className="inline-flex h-5 w-fit items-center rounded-full bg-hover px-2 text-xs text-muted outline-none transition-colors duration-100 hover:bg-selected hover:text-ink focus-visible:outline-2"
				>
					•••
				</button>
			)}
		</div>
	);
}
