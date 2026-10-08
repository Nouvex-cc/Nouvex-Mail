// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useRef } from "react";
import { cn } from "../../lib";
import { Highlight } from "../highlight";

export type MessageListProps = {
	children: ReactNode;
	/**
	 * Called while the pointer, pressed on a row's checkbox, drags across other rows (like selecting several photos
	 * at once). Indices are row positions in the list, `from` ≤ `to`; select that range.
	 */
	onSelectRange?: (from: number, to: number) => void;
	className?: string;
};

/**
 * Holds MessageRows: one highlight slides to the hovered or focused row, ↑/↓ or j/k move focus between rows,
 * and dragging from a checkbox selects every row it passes.
 */
export function MessageList({ children, onSelectRange, className }: MessageListProps) {
	const list = useRef<HTMLDivElement>(null);
	const drag = useRef<number | null>(null);
	const rows = () => [...(list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
	const rowAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-row]") ?? null;
	const activate = (row: HTMLElement | null) => {
		for (const r of rows()) if (r !== row) r.removeAttribute("data-active");
		row?.setAttribute("data-active", "");
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
				const all = rows();
				const i = all.indexOf(document.activeElement as HTMLElement);
				const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
				if (!step || i < 0) return;
				e.preventDefault();
				all[Math.min(all.length - 1, Math.max(0, i + step))]?.focus();
			}}
			onPointerDown={(e) => {
				if (!(e.target as HTMLElement).closest("[data-select-handle]")) return;
				const row = rowAt(e.clientX, e.clientY);
				if (row) drag.current = rows().indexOf(row);
			}}
			onPointerMove={(e) => {
				if (drag.current === null || !e.buttons) return;
				const row = rowAt(e.clientX, e.clientY);
				const i = row ? rows().indexOf(row) : -1;
				if (i < 0 || i === drag.current) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				onSelectRange?.(Math.min(drag.current, i), Math.max(drag.current, i));
			}}
			onPointerUp={() => {
				drag.current = null;
			}}
		>
			<Highlight attr="data-active" className="rounded-md" />
			{children}
		</div>
	);
}
