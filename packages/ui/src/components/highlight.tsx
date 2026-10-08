// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import { cn } from "../lib";

/**
 * One highlight behind a list that slides to whichever item Base UI marks as highlighted, instead of each item
 * lighting up on its own. Place it as the first child of the positioned element the items scroll in.
 * `attr` picks which item it follows, e.g. data-pressed for the active option of a toggle group.
 */
export function Highlight({ attr = "data-highlighted", className }: { attr?: string; className?: string }) {
	const ref = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const el = ref.current;
		const list = el?.parentElement;
		if (!el || !list) return;
		let shown = false;

		const move = () => {
			const item = list.querySelector<HTMLElement>(`[${attr}]`);
			if (!item) {
				el.style.opacity = "0";
				shown = false;
				return;
			}
			// First highlight appears in place; only moves between items slide.
			if (!shown) {
				el.dataset.jump = "";
				requestAnimationFrame(() => requestAnimationFrame(() => delete el.dataset.jump));
			}
			shown = true;
			el.style.opacity = "1";
			el.style.width = `${item.offsetWidth}px`;
			el.style.height = `${item.offsetHeight}px`;
			el.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
		};

		const watch = new MutationObserver(move);
		watch.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: [attr] });
		// Popups often get their final width after the first highlight (positioning), so follow size changes too.
		const resize = new ResizeObserver(move);
		resize.observe(list);
		move();
		return () => {
			watch.disconnect();
			resize.disconnect();
		};
	}, [attr]);

	return (
		<span
			ref={ref}
			aria-hidden
			className={cn("list-highlight pointer-events-none absolute top-0 left-0 rounded-sm bg-hover", className)}
		/>
	);
}
