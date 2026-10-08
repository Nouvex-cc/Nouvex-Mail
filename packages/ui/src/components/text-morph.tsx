// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib";

type Glyph = { key: number; char: string };

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

export function TextMorph({ children, className }: { children: string; className?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const lefts = useRef(new Map<number, number>());
	const width = useRef(0);
	const measured = useRef("");
	const [state, setState] = useState(() => ({ text: children, glyphs: glyphs(children), exiting: [] as Glyph[] }));

	if (children !== state.text) {
		const { next, removed } = diff(state.glyphs, children);
		setState({ text: children, glyphs: next, exiting: [...state.exiting, ...removed] });
	}

	useLayoutEffect(() => {
		const root = ref.current;
		// Runs again when a leaving letter is cleaned up; only a new text needs measuring.
		if (!root || measured.current === state.text) return;
		measured.current = state.text;
		for (const a of root.getAnimations()) a.cancel();
		const animate = width.current > 0 && !matchMedia("(prefers-reduced-motion: reduce)").matches;
		const exiting = new Set(state.exiting.map((g) => g.key));

		for (const el of root.querySelectorAll<HTMLElement>("[data-key]")) {
			const key = Number(el.dataset.key);
			const old = lefts.current.get(key);
			if (exiting.has(key)) {
				if (el.dataset.leaving) continue;
				el.dataset.leaving = "1";
				el.style.left = `${old ?? 0}px`;
				const done = () => setState((s) => ({ ...s, exiting: s.exiting.filter((g) => g.key !== key) }));
				if (!animate) done();
				else
					el.animate(
						{ opacity: [1, 0], filter: ["blur(0)", "blur(2px)"] },
						{ duration: 160, easing: "ease-in", fill: "forwards" },
					).onfinish = done;
			} else if (old === undefined) {
				if (animate)
					el.animate(
						{ opacity: [0, 1], filter: ["blur(2px)", "blur(0)"] },
						{ duration: 220, delay: 80, easing: ease, fill: "backwards" },
					);
			} else if (animate && old !== el.offsetLeft) {
				el.animate({ transform: [`translateX(${old - el.offsetLeft}px)`, "none"] }, { duration: 320, easing: ease });
			}
		}

		const w = root.offsetWidth;
		if (animate && width.current !== w)
			root.animate({ width: [`${width.current}px`, `${w}px`] }, { duration: 320, easing: ease });
		width.current = w;
		lefts.current = new Map(
			state.glyphs.map((g) => [g.key, root.querySelector<HTMLElement>(`[data-key="${g.key}"]`)?.offsetLeft ?? 0]),
		);
	}, [state]);

	return (
		<span ref={ref} className={cn("relative inline-block whitespace-pre", className)}>
			{state.glyphs.map((g) => (
				<span key={g.key} data-key={g.key} className="inline-block">
					{g.char}
				</span>
			))}
			{state.exiting.map((g) => (
				<span key={g.key} data-key={g.key} aria-hidden className="absolute top-0">
					{g.char}
				</span>
			))}
		</span>
	);
}
