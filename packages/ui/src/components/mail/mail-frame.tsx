// SPDX-License-Identifier: Apache-2.0
import DOMPurify from "dompurify";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useDark } from "../../dark";
import { FileImage, Moon, Sun } from "../../icons";
import { cn } from "../../lib";

export type MailFrameProps = {
	html: string;
	/** Routes remote images through the image proxy. With one they load right away, without one only on request. */
	proxy?(url: string): string;
	className?: string;
};

/**
 * Set by a ThreadMessage: the frame then sits flush in the message, its text in line with the header, and puts its
 * status pills next to the message's date.
 */
export const FrameSlot = createContext<HTMLElement | null | undefined>(undefined);

const remote = /^https?:\/\//i;
const cssUrl = /url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi;

// The frame is its own document and doesn't see the app's fonts, so it gets copies of the app's @font-face rules and
// the same font stack (--font-sans). Stylesheets from other origins can't be read and are skipped.
let font: { faces: string; stack: string } | undefined;
function appFont() {
	if (font) return font;
	const stack = getComputedStyle(document.documentElement).getPropertyValue("--font-sans") || "system-ui, sans-serif";
	const family = stack.split(",")[0]?.trim() ?? "";
	const faces = [...document.styleSheets]
		.flatMap((sheet) => {
			try {
				return [...sheet.cssRules];
			} catch {
				return [];
			}
		})
		.filter((rule) => rule instanceof CSSFontFaceRule && rule.style.getPropertyValue("font-family").trim() === family)
		.map((rule) => rule.cssText)
		.join("\n");
	font = { faces, stack };
	return font;
}

// Mails that bring their own dark design say so in their CSS.
const ownDark = /prefers-color-scheme\s*:\s*dark|color-scheme\s*:[^;"'}]*\bdark/i;

// In a dark app, a mail with its own dark design gets to use it; any other mail is turned dark by inverting lightness
// and turning hues back, the way Apple Mail does it. Pictures are inverted back so they look as sent; the slight
// contrast cut keeps white from glaring.
const flip = "invert(1) hue-rotate(180deg)";
const looks = {
	light: ":root { color-scheme: light; } html { background: oklch(0.993 0.002 75); color: #1f1d1b; }",
	own: ":root { color-scheme: dark; } html { background: oklch(0.175 0.005 60); color: oklch(0.94 0.004 75); }",
	// On body, not html: the page background behind html isn't filtered and would show as a white edge.
	flipped: `:root { color-scheme: light; } html { background: oklch(0.175 0.005 60); }
	body { background: #fff; color: #1f1d1b; filter: ${flip} contrast(0.82); }
	img, picture, video, canvas, svg, [style*="background-image"], [background] { filter: ${flip}; }`,
};

// Inside the frame: readable defaults in the chosen look, quotes hidden until the toggle outside shows them.
const base = ({ faces, stack }: { faces: string; stack: string }, look: keyof typeof looks) => `<style>
	${faces}
	${looks[look]}
	body { margin: 0; padding: 16px 20px; font: 16px/1.6 ${stack}; overflow-wrap: anywhere; }
	body:not(.layout) > * { max-width: 72ch; }
	body.flush { padding: 4px 0 8px; }
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
	const swap = (css: string) => css.replace(cssUrl, (_, q, url) => (allow ? `url(${q}${load(url)}${q})` : "none"));

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
		const style = el.getAttribute("style") ?? "";
		const swapped = swap(style);
		if (swapped !== style) {
			el.setAttribute("style", swapped);
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
		const swapped = swap(css);
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
	// Newsletters are built as one fixed-width table, usually 600px, meant to sit in the middle of the window.
	// Plain mails keep reading from the left edge.
	const layout = [...doc.querySelectorAll<HTMLElement>("table")].find((t) =>
		/^\d+(px)?$/.test(t.getAttribute("width") || t.style.width || t.style.maxWidth),
	);
	layout?.style.setProperty("margin-inline", "auto");
	// The parser moves a <style> that comes before any content into <head>; most HTML mail starts with one.
	const styles = [...doc.head.querySelectorAll("style")].map((style) => style.outerHTML).join("");
	return { body: styles + doc.body.innerHTML, blocked, quoted: !!quote, layout: !!layout };
}

/** Renders a mail in a sandboxed frame (no scripts) that grows with its content, so it never scrolls on its own. */
export function MailFrame({ html, proxy, className }: MailFrameProps) {
	const dark = useDark();
	const [original, setOriginal] = useState(false);
	const look = !dark || original ? "light" : ownDark.test(html) ? "own" : "flipped";
	// Through a proxy remote images can't reveal the reader, so they load right away.
	const [allow, setAllow] = useState(proxy !== undefined);
	const [showQuote, setShowQuote] = useState(false);
	const [ready, setReady] = useState(false);
	const frame = useRef<HTMLIFrameElement>(null);
	const { body, blocked, quoted, layout } = useMemo(() => prepare(html, allow, proxy), [html, allow, proxy]);

	const slot = useContext(FrameSlot);
	const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${base(appFont(), look)}</head><body class="${[layout && "layout", slot !== undefined && "flush"].filter(Boolean).join(" ")}">${body}</body></html>`;

	// Written straight into the frame instead of srcdoc: the frame's load event waits for every image, this way the
	// mail has its height in the first paint and images fill in after. The frame then follows the content's height.
	useLayoutEffect(() => {
		const el = frame.current;
		const d = el?.contentDocument;
		if (!el || !d) return;
		d.open();
		d.write(doc);
		d.close();
		const fit = () => {
			el.style.height = `${d.documentElement.scrollHeight}px`;
		};
		const resize = new ResizeObserver(fit);
		resize.observe(d.documentElement);
		fit();
		const raf = requestAnimationFrame(() => setReady(true));
		return () => {
			resize.disconnect();
			cancelAnimationFrame(raf);
		};
	}, [doc]);

	// Quotes toggle in place without rewriting the frame.
	useEffect(() => {
		frame.current?.contentDocument?.body.classList.toggle("show-quote", showQuote);
	}, [showQuote, doc]);

	const pills = (
		<>
			{blocked > 0 && !allow && (
				<StatusPill
					icon={<FileImage strokeWidth={1.75} />}
					label="Remote images hidden"
					action="Show"
					onClick={() => setAllow(true)}
				/>
			)}
			{dark && (
				<StatusPill
					icon={original ? <Sun strokeWidth={1.75} /> : <Moon strokeWidth={1.75} />}
					label={original ? "Original colors" : "Dark colors"}
					action={original ? "Show dark" : "Show original"}
					onClick={() => setOriginal((o) => !o)}
				/>
			)}
		</>
	);

	return (
		<div className={cn("grid gap-2", className)}>
			{/* In a message the mail sits flush; on its own it gets a border, outside the frame so it follows the app's
			    theme, not the frame's. */}
			<div className={slot !== undefined ? undefined : "overflow-hidden rounded-lg border border-line"}>
				<iframe
					ref={frame}
					title="Message"
					sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
					// The mail's own dark CSS only matches when the frame itself is dark.
					className={cn(
						"block h-0 w-full data-[ready]:transition-all data-[ready]:duration-150 data-[ready]:ease-out",
						look === "own" ? "scheme-dark" : "scheme-light",
					)}
					data-ready={ready || undefined}
				/>
			</div>
			{quoted && (
				<button
					type="button"
					aria-label={showQuote ? "Hide quoted text" : "Show quoted text"}
					aria-expanded={showQuote}
					onClick={() => setShowQuote((s) => !s)}
					className={cn(
						"inline-flex h-5 w-fit items-center rounded-full bg-hover px-2 text-xs text-muted outline-none transition-colors duration-100 hover:bg-selected hover:text-ink focus-visible:outline-2",
					)}
				>
					•••
				</button>
			)}
			{slot !== undefined ? slot && createPortal(pills, slot) : <div className="flex gap-1.5">{pills}</div>}
		</div>
	);
}

/** Just the icon until hovered or focused, then it opens to what it says and what a click does. */
function StatusPill({
	icon,
	label,
	action,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	action: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={`${label}. ${action}`}
			onClick={onClick}
			className="status-pill h-7 items-center rounded-full bg-sunken pr-2.5 pl-1.5 text-sm text-muted outline-none hover:text-ink focus-visible:outline-2 [&_svg]:size-4"
		>
			<span className="grid size-4 place-items-center">{icon}</span>
			<span>
				<span className="pl-1.5">{label}</span>
				<span className="pl-1.5 font-medium text-ink">{action}</span>
			</span>
		</button>
	);
}
