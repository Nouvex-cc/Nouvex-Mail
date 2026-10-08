// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "../../lib";
import { Highlight } from "../highlight";

export type MessageListProps = {
	children: ReactNode;
	/** Called with the positions of every selected row whenever the selection changes. */
	onSelectionChange?: (rows: number[]) => void;
	className?: string;
};

// One shape per run of selected rows, reused while the run grows or shrinks so it glides along.
function Selection() {
	const ref = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const layer = ref.current;
		const list = layer?.parentElement;
		if (!layer || !list) return;
		let shapes: { el: HTMLElement; rows: HTMLElement[] }[] = [];

		const update = () => {
			const runs: HTMLElement[][] = [];
			let run: HTMLElement[] = [];
			for (const row of list.querySelectorAll<HTMLElement>(":scope > [data-row]")) {
				if (row.getAttribute("aria-selected") === "true") run.push(row);
				else if (run.length) {
					runs.push(run);
					run = [];
				}
			}
			if (run.length) runs.push(run);

			const kept: typeof shapes = [];
			for (const rows of runs) {
				const old = shapes.find((s) => !kept.some((k) => k.el === s.el) && s.rows.some((r) => rows.includes(r)));
				const el = old?.el ?? layer.appendChild(document.createElement("span"));
				const first = rows[0] as HTMLElement;
				const last = rows.at(-1) as HTMLElement;
				if (!old) {
					el.className = "selection-run";
					el.animate({ opacity: [0, 1] }, { duration: 120, easing: "ease-out" });
				}
				el.style.left = `${first.offsetLeft}px`;
				el.style.width = `${first.offsetWidth}px`;
				el.style.top = `${first.offsetTop}px`;
				el.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop}px`;
				kept.push({ el, rows });
			}
			for (const s of shapes)
				if (!kept.some((k) => k.el === s.el))
					s.el.animate({ opacity: [1, 0] }, { duration: 120, easing: "ease-out" }).finished.then(() => s.el.remove());
			shapes = kept;
		};

		const watch = new MutationObserver(update);
		watch.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] });
		const resize = new ResizeObserver(update);
		resize.observe(list);
		update();
		return () => {
			watch.disconnect();
			resize.disconnect();
		};
	}, []);

	return <span ref={ref} aria-hidden className="contents" />;
}

/** Selection works like a file list: left edge toggles, drag, shift ranges, ⌘-click, X, ⌘A, Esc. */
export function MessageList({ children, onSelectionChange, className }: MessageListProps) {
	const list = useRef<HTMLDivElement>(null);
	const anchor = useRef<number | null>(null);
	const drag = useRef<{ from: number; select: boolean; before: boolean[] } | null>(null);
	const rows = () => [...(list.current?.querySelectorAll<HTMLElement>(":scope > [data-row]") ?? [])];
	const selection = () => rows().map((r) => r.getAttribute("aria-selected") === "true");
	const commit = (next: boolean[]) => onSelectionChange?.(next.flatMap((on, i) => (on ? [i] : [])));
	const activate = (row: HTMLElement | null) => {
		for (const r of rows()) if (r !== row) r.removeAttribute("data-active");
		row?.setAttribute("data-active", "");
	};
	const range = (base: boolean[], from: number, to: number, on: boolean) =>
		base.map((s, i) => (i >= Math.min(from, to) && i <= Math.max(from, to) ? on : s));
	// The row under a height on screen; how far left or right the pointer is doesn't matter.
	const rowAtY = (y: number) =>
		rows().findIndex((r) => {
			const b = r.getBoundingClientRect();
			return y >= b.top && y < b.bottom;
		});

	const toggle = (i: number, shift: boolean) => {
		const now = selection();
		const on = !now[i];
		commit(shift && anchor.current !== null ? range(now, anchor.current, i, true) : range(now, i, i, on));
		anchor.current = i;
	};

	return (
		<div
			ref={list}
			role="listbox"
			aria-multiselectable
			className={cn("relative grid", className)}
			onPointerOver={(e) => activate((e.target as HTMLElement).closest("[data-row]"))}
			onPointerLeave={() => activate(rows().find((r) => r === document.activeElement) ?? null)}
			onFocus={(e) => activate((e.target as HTMLElement).closest("[data-row]"))}
			onKeyDown={(e) => {
				// Keys typed in a row's popups (snooze) bubble up here too; only the rows themselves count.
				if (!(e.target as HTMLElement).matches("[data-row]")) return;
				const all = rows();
				const i = all.indexOf(document.activeElement as HTMLElement);
				const key = e.key.toLowerCase();
				if ((e.metaKey || e.ctrlKey) && key === "a") commit(all.map(() => true));
				else if (key === "escape" && selection().some(Boolean)) commit(all.map(() => false));
				else if (key === "x" && i >= 0) toggle(i, e.shiftKey);
				else {
					const step = key === "arrowdown" || key === "j" ? 1 : key === "arrowup" || key === "k" ? -1 : 0;
					if (!step || i < 0) return;
					all[Math.min(all.length - 1, Math.max(0, i + step))]?.focus();
				}
				e.preventDefault();
			}}
			onPointerDown={(e) => {
				if (e.button !== 0 || !(e.target as HTMLElement).closest("[data-select-handle]")) return;
				const i = rowAtY(e.clientY);
				if (i < 0) return;
				e.preventDefault();
				if (e.shiftKey) return toggle(i, true);
				const before = selection();
				drag.current = { from: i, select: !before[i], before };
				e.currentTarget.setPointerCapture(e.pointerId);
				toggle(i, false);
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d || !e.buttons) return;
				const i = rowAtY(e.clientY);
				if (i >= 0) commit(range(d.before, d.from, i, d.select));
			}}
			onPointerUp={() => {
				drag.current = null;
			}}
			// Selection clicks must not open the message.
			onClickCapture={(e) => {
				if ((e.target as HTMLElement).closest("[data-select-handle]")) return e.stopPropagation();
				if (!(e.shiftKey || e.metaKey || e.ctrlKey)) return;
				const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
				const i = row ? rows().indexOf(row) : -1;
				if (i < 0 || (e.target as HTMLElement).closest("button")) return;
				e.preventDefault();
				e.stopPropagation();
				toggle(i, e.shiftKey);
			}}
		>
			<Highlight attr="data-active" className="rounded-md" />
			<Selection />
			{children}
		</div>
	);
}
