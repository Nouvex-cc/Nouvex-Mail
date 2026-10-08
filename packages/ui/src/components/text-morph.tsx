// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib";

type Glyph = { key: number; char: string };

// Motion follows torph (github.com/lochie/torph): strong ease-out, letters scale from 95% and travel with the flow.
const duration = 400;
const easing = "cubic-bezier(0.19, 1, 0.22, 1)";

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

export function TextMorph({
	children,
	icon,
	fade = false,
	className,
}: {
	children: string;
	icon?: ReactNode;
	/** Crossfade whole texts instead of morphing letters; calmer for longer labels. */
	fade?: boolean;
	className?: string;
}) {
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
		const { next, removed } = fade ? { next: glyphs(id), removed: state.glyphs } : diff(state.glyphs, id);
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
		const els = [...root.querySelectorAll<HTMLElement>("[data-key]")];
		const key = (el: HTMLElement) => Number(el.dataset.key);

		// Letters both texts share: where they were and where they are now.
		const kept: { from: number; to: number }[] = [];
		for (const el of els) {
			const from = before.current.get(key(el));
			if (from === undefined || exiting.has(key(el))) continue;
			for (const a of el.getAnimations()) a.cancel();
			const to = el.getBoundingClientRect().left - x;
			kept.push({ from, to });
			if (animate && Math.abs(from - to) > 0.1)
				el.animate({ transform: [`translateX(${from - to}px)`, "none"] }, { duration, easing });
		}
		// New and leaving letters travel with their nearest shared neighbour, so nothing stands still while the rest moves.
		const shift = (pos: number, side: "from" | "to") => {
			const left = kept.filter((k) => k[side] <= pos).at(-1) ?? kept.find((k) => k[side] > pos);
			return left ? left.to - left.from : 0;
		};

		for (const el of els) {
			const old = before.current.get(key(el));
			if (exiting.has(key(el))) {
				if (el.dataset.leaving) continue;
				el.dataset.leaving = "1";
				el.style.left = `${(old ?? rootLeft) - rootLeft}px`;
				const done = () => setState((s) => ({ ...s, exiting: s.exiting.filter((g) => g.key !== key(el)) }));
				if (!animate) {
					done();
					continue;
				}
				el.animate(
					{ transform: `translateX(${shift(old ?? 0, "from")}px) scale(0.95)`, offset: 1 },
					{ duration, easing, fill: "both" },
				);
				el.animate({ opacity: 0, offset: 1 }, { duration: duration * 0.25, fill: "both" }).onfinish = done;
			} else if (old === undefined && animate) {
				const to = el.getBoundingClientRect().left - x;
				el.animate(
					{ transform: [`translateX(${-shift(to, "to")}px) scale(0.95)`, "none"] },
					{ duration, easing, fill: "both" },
				);
				el.animate({ opacity: [0, 1] }, { duration: duration * 0.5, delay: duration * 0.25, fill: "both" });
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
