// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { cn } from "../lib";

type Field = HTMLInputElement | HTMLTextAreaElement;

// Everything that changes where text lands, copied onto the mirror.
const copied = [
	"box-sizing",
	"width",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"border-top-width",
	"border-right-width",
	"border-bottom-width",
	"border-left-width",
	"border-style",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"font-variant",
	"letter-spacing",
	"word-spacing",
	"line-height",
	"text-transform",
	"text-indent",
	"tab-size",
];

/**
 * A caret that glides instead of jumping. The native caret is hidden and an element is moved to where it would be,
 * measured with an invisible mirror of the field. Fields that don't expose a caret position (email, number) keep
 * the native one.
 */
export function useCaret<T extends Field>(forwarded?: Ref<T>) {
	const field = useRef<T | null>(null);
	const caret = useRef<HTMLSpanElement>(null);
	const mirror = useRef<HTMLSpanElement>(null);
	const [custom, setCustom] = useState(false);

	useEffect(() => {
		const el = field.current;
		const c = caret.current;
		const m = mirror.current;
		if (!el || !c || !m) return;
		let frame = 0;
		let idle: ReturnType<typeof setTimeout> | undefined;

		const place = () => {
			const start = el.selectionStart;
			const visible = document.activeElement === el && start !== null && start === el.selectionEnd;
			if (!visible) {
				c.hidden = true;
				return;
			}
			const cs = getComputedStyle(el);
			for (const p of copied) m.style.setProperty(p, cs.getPropertyValue(p));
			m.style.whiteSpace = el instanceof HTMLTextAreaElement ? "pre-wrap" : "pre";
			const value = el.type === "password" ? "•".repeat(el.value.length) : el.value;
			m.textContent = value.slice(0, start);
			const marker = document.createElement("span");
			marker.textContent = "​";
			m.append(marker);

			const box = m.getBoundingClientRect();
			const at = marker.getBoundingClientRect();
			const height = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2;
			const x = el.offsetLeft + at.left - box.left - el.scrollLeft;
			const y =
				el instanceof HTMLTextAreaElement
					? el.offsetTop + at.top - box.top - el.scrollTop
					: el.offsetTop + (el.offsetHeight - height) / 2;

			// Coming back into view: appear in place instead of gliding in from the last spot.
			if (c.hidden) {
				c.dataset.jump = "";
				requestAnimationFrame(() => delete c.dataset.jump);
			}
			c.hidden = false;
			c.style.height = `${height}px`;
			c.style.transform = `translate(${x}px, ${y}px)`;
			// Solid while typing, blinks once the hand rests.
			delete c.dataset.idle;
			clearTimeout(idle);
			idle = setTimeout(() => {
				c.dataset.idle = "";
			}, 500);
		};

		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(place);
		};
		const focus = () => {
			setCustom(el.selectionStart !== null);
			update();
		};

		const events = ["input", "blur", "scroll", "keydown", "pointerup"] as const;
		for (const e of events) el.addEventListener(e, update);
		el.addEventListener("focus", focus);
		document.addEventListener("selectionchange", update);
		const resize = new ResizeObserver(update);
		resize.observe(el);
		return () => {
			for (const e of events) el.removeEventListener(e, update);
			el.removeEventListener("focus", focus);
			document.removeEventListener("selectionchange", update);
			resize.disconnect();
			cancelAnimationFrame(frame);
			clearTimeout(idle);
		};
	}, []);

	const ref = (el: T | null) => {
		field.current = el;
		if (typeof forwarded === "function") forwarded(el);
		else if (forwarded) forwarded.current = el;
	};

	const wrap = (input: ReactNode, className?: string) => (
		<span className={cn("relative block", className)}>
			{input}
			<span ref={mirror} aria-hidden className="invisible pointer-events-none absolute top-0 left-0 overflow-hidden" />
			<span
				ref={caret}
				aria-hidden
				hidden
				className="text-caret pointer-events-none absolute top-0 left-0 w-0.5 rounded-full bg-ink"
			/>
		</span>
	);

	return { ref, wrap, caretClass: custom ? "caret-transparent" : "" };
}
