// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";

/**
 * Children of the returned element glide to their new place when siblings come or go, instead of jumping.
 * `enter` scales new children in, `leave` keeps a short-lived copy of a removed child fading out where it was.
 * Used by chips. The element must be positioned (relative).
 */
export function useGlide<T extends HTMLElement>({
	enter = false,
	leave = false,
}: {
	enter?: boolean;
	leave?: boolean;
} = {}) {
	const ref = useRef<T>(null);
	useEffect(() => {
		const box = ref.current;
		if (!box) return;
		const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
		const ghost = (n: Node) => n instanceof HTMLElement && "ghost" in n.dataset;
		// Layout positions (offsets) placed on the page via the container's own box: a glide in progress must not look
		// like a change to the next update, but the container itself may move (a toast stack anchored at the bottom
		// shrinks when one leaves), and that has to count.
		let positions = new Map<Element, { x: number; y: number }>();
		const place = (c: HTMLElement, origin: DOMRect) => ({ x: origin.left + c.offsetLeft, y: origin.top + c.offsetTop });
		const snap = () => {
			const origin = box.getBoundingClientRect();
			positions = new Map();
			for (const c of box.children) if (c instanceof HTMLElement && !ghost(c)) positions.set(c, place(c, origin));
		};

		const watch = new MutationObserver((records) => {
			if (matchMedia("(prefers-reduced-motion: reduce)").matches) return snap();
			const origin = box.getBoundingClientRect();
			for (const record of records) {
				for (const n of leave ? record.removedNodes : []) {
					const old = positions.get(n as Element);
					if (!(n instanceof HTMLElement) || ghost(n) || !old) continue;
					const copy = n.cloneNode(true) as HTMLElement;
					copy.dataset.ghost = "";
					copy.inert = true;
					copy.setAttribute("aria-hidden", "true");
					Object.assign(copy.style, {
						position: "absolute",
						margin: "0",
						left: `${old.x - origin.left}px`,
						top: `${old.y - origin.top}px`,
					});
					box.append(copy);
					copy.animate(
						{ opacity: [1, 0], scale: [1, 0.9] },
						{ duration: 120, easing: "ease-in", fill: "forwards" },
					).onfinish = () => copy.remove();
				}
				for (const n of enter ? record.addedNodes : [])
					if (n instanceof HTMLElement && !ghost(n) && n.tagName !== "INPUT")
						n.animate({ opacity: [0, 1], scale: [0.9, 1] }, { duration: 140, easing });
			}
			for (const c of box.children) {
				const old = positions.get(c);
				if (!(c instanceof HTMLElement) || ghost(c) || !old) continue;
				const now = place(c, origin);
				const dx = old.x - now.x;
				const dy = old.y - now.y;
				if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
				// Start from where it is on screen, which includes a glide that's still running.
				const running = new DOMMatrix(getComputedStyle(c).transform);
				for (const a of c.getAnimations()) if (a.id === "glide") a.cancel();
				c.animate(
					{ transform: [`translate(${dx + running.e}px, ${dy + running.f}px)`, "none"] },
					{ duration: 160, easing, id: "glide" },
				);
			}
			snap();
		});
		watch.observe(box, { childList: true });
		const resize = new ResizeObserver(snap);
		resize.observe(box);
		snap();
		return () => {
			watch.disconnect();
			resize.disconnect();
		};
	}, [enter, leave]);
	return ref;
}
