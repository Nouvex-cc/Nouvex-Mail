// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useEffect, useRef } from "react";
import { Archive, Clock, MailOpen, Trash2, X } from "../../icons";
import { cn } from "../../lib";
import { TextMorph } from "../text-morph";
import { Tooltip } from "../tooltip";

export type BulkBarProps = {
	count: number;
	onArchive?: () => void;
	onSnooze?: () => void;
	onDelete?: () => void;
	onMarkRead?: () => void;
	onClear: () => void;
};

const action =
	"grid size-8 place-items-center rounded-md text-muted outline-none hover:bg-hover hover:text-ink active:scale-95 focus-visible:outline-2 [&_svg]:size-4";

/** Actions for the selected messages. Rises from the bottom of its (positioned) container; Escape clears. */
export function BulkBar({ count, onArchive, onSnooze, onDelete, onMarkRead, onClear }: BulkBarProps) {
	// Keep the last count while the bar slides away, so its label doesn't morph to "0 selected" on the way out.
	const shown = useRef(count);
	if (count > 0) shown.current = count;

	useEffect(() => {
		if (!count) return;
		const key = (e: KeyboardEvent) => e.key === "Escape" && onClear();
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [count, onClear]);

	const button = (label: string, icon: ReactNode, onClick?: () => void) =>
		onClick && (
			<Tooltip content={label}>
				<button type="button" aria-label={label} className={action} onClick={onClick}>
					{icon}
				</button>
			</Tooltip>
		);

	return (
		<div
			role="toolbar"
			aria-label="Selected messages"
			aria-hidden={!count}
			inert={!count}
			data-open={count > 0 || undefined}
			className={cn(
				"absolute inset-x-0 bottom-3 z-10 mx-auto flex w-max items-center gap-1 rounded-lg border border-line bg-raised py-1 pr-1 pl-3 shadow-pop",
				"pointer-events-none translate-y-3 opacity-0 transition duration-200 ease-out data-[open]:pointer-events-auto data-[open]:translate-y-0 data-[open]:opacity-100",
			)}
		>
			<span className="mr-2 text-sm font-medium tabular-nums">
				<TextMorph>{`${shown.current} selected`}</TextMorph>
			</span>
			{button("Archive", <Archive strokeWidth={1.75} />, onArchive)}
			{button("Snooze", <Clock strokeWidth={1.75} />, onSnooze)}
			{button("Mark as read", <MailOpen strokeWidth={1.75} />, onMarkRead)}
			{button("Delete", <Trash2 strokeWidth={1.75} />, onDelete)}
			<span className="mx-1 h-5 w-px bg-line" />
			{button("Clear selection", <X strokeWidth={1.75} />, onClear)}
		</div>
	);
}
