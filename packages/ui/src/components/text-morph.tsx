// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib";

type Glyph = { key: number; char: string };

// Stands in for the optional icon inside the glyph list, so it enters, leaves and glides like a letter.
const ICON = "\u0000";

let nextKey = 0;
const glyphs = (text: string) => [...text].map((char) => ({ key: nextKey++, char }));

// Letters both texts share (longest common subsequence) keep their key so they can glide instead of being replaced.
function diff(prev: Glyph[], text: string) {
	const b = [...text];
	const w = b.length + 1;
	const lcs = new Uint16Array((prev.length + 1) * w);
	for (let i = prev.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			lcs[i * w + j] =
				prev[i]?.char === b[j]
					? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
					: Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);

	const next: Glyph[] = [];
	const removed: Glyph[] = [];
	let i = 0;
	let j = 0;
	while (i < prev.length || j < b.length) {
		const g = prev[i];
		if (g && g.char === b[j]) {
			next.push(g);
			i++;
			j++;
		} else if (g && (j >= b.length || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
			removed.push(g);
			i++;
		} else {
			next.push({ key: nextKey++, char: b[j] ?? "" });
			j++;
		}
	}
	return { next, removed };
}

const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export function TextMorph({ children, icon, className }: { children: string; icon?: ReactNode; className?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const before = useRef(new Map<number, number>());
	const measured = useRef<string | null>(null);
	const lastIcon = useRef(icon);
	if (icon) lastIcon.current = icon;
	const id = `${icon ? ICON : ""}${children}`;
	const [state, setState] = useState(() => ({ id, glyphs: glyphs(id), exiting: [] as Glyph[] }));

	// Where each letter is on screen right now (fractional, including any running glide), relative to the
	// offset parent, which stays put while this element re-centers.
	const positions = () => {
		const root = ref.current;
		const map = new Map<number, number>();
		if (!root?.offsetParent) return map;
		const x = root.offsetParent.getBoundingClientRect().left;
		for (const el of root.querySelectorAll<HTMLElement>("[data-key]"))
			if (!el.dataset.leaving) map.set(Number(el.dataset.key), el.getBoundingClientRect().left - x);
		return map;
	};

	if (id !== state.id) {
		// The DOM still shows the old text here, so this is the last chance to see where letters are.
		before.current = positions();
		const { next, removed } = diff(state.glyphs, id);
		setState({ id, glyphs: next, exiting: [...state.exiting, ...removed] });
	}

	useLayoutEffect(() => {
		const root = ref.current;
		// Runs again when a leaving letter is cleaned up; only a new text needs animating.
		if (!root?.offsetParent || measured.current === state.id) return;
		const animate = measured.current !== null && !matchMedia("(prefers-reduced-motion: reduce)").matches;
		measured.current = state.id;
		const x = root.offsetParent.getBoundingClientRect().left;
		const rootLeft = root.getBoundingClientRect().left - x;
		const exiting = new Set(state.exiting.map((g) => g.key));

		for (const el of root.querySelectorAll<HTMLElement>("[data-key]")) {
			const key = Number(el.dataset.key);
			const old = before.current.get(key);
			if (exiting.has(key)) {
				if (el.dataset.leaving) continue;
				el.dataset.leaving = "1";
				el.style.left = `${(old ?? rootLeft) - rootLeft}px`;
				const done = () => setState((s) => ({ ...s, exiting: s.exiting.filter((g) => g.key !== key) }));
				if (!animate) done();
				else
					el.animate(
						{ opacity: [1, 0], filter: ["blur(0)", "blur(2px)"] },
						{ duration: 120, easing: "ease-out", fill: "forwards" },
					).onfinish = done;
			} else if (old === undefined) {
				if (animate)
					el.animate(
						{ opacity: [0, 1], filter: ["blur(2px)", "blur(0)"] },
						{ duration: 220, delay: 100, easing: ease, fill: "backwards" },
					);
			} else if (animate) {
				for (const a of el.getAnimations()) a.cancel();
				const dx = old - (el.getBoundingClientRect().left - x);
				if (Math.abs(dx) > 0.1)
					el.animate(
						{ transform: [`translateX(${dx}px)`, "none"] },
						{ duration: 380, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
					);
			}
		}
	}, [state]);

	const render = (g: Glyph) => (g.char === ICON ? <span className="flex pr-1.5">{lastIcon.current}</span> : g.char);

	return (
		<span ref={ref} className={cn("relative inline-flex items-center whitespace-pre", className)}>
			{state.glyphs.map((g) => (
				<span key={g.key} data-key={g.key} className="inline-block">
					{render(g)}
				</span>
			))}
			{state.exiting.map((g) => (
				<span key={g.key} data-key={g.key} aria-hidden className="absolute top-1/2 -translate-y-1/2">
					{render(g)}
				</span>
			))}
		</span>
	);
}
