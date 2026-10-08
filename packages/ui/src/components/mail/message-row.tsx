// SPDX-License-Identifier: Apache-2.0
import { Archive, Clock, Paperclip, Trash2 } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib";
import { formatMailDate, formatMailDateLong } from "../../mail-date";
import { Checkbox } from "../checkbox";
import { Tooltip } from "../tooltip";
import { SnoozePicker } from "./snooze-picker";

export type MessageRowProps = {
	from: string;
	subject: string;
	snippet?: string;
	date: Date;
	unread?: boolean;
	selected?: boolean;
	/** Some row in the list is selected: checkboxes stay visible on every row. */
	selecting?: boolean;
	attachments?: number;
	onSelectedChange?: (selected: boolean, shiftKey: boolean) => void;
	onOpen?: () => void;
	onArchive?: () => void;
	onSnooze?: (until: Date) => void;
	onDelete?: () => void;
};

const action =
	"grid size-7 place-items-center rounded-md text-muted outline-none hover:bg-hover hover:text-ink active:scale-95 focus-visible:outline-2 [&_svg]:size-4";

/**
 * One message in a list. Hovering (or focusing) swaps the date for quick actions; on touch, swiping left archives
 * and swiping right opens snooze. Shortcuts while focused: Enter open, E archive, H snooze, # delete, X select.
 */
export function MessageRow({
	from,
	subject,
	snippet,
	date,
	unread = false,
	selected = false,
	selecting = false,
	attachments = 0,
	onSelectedChange,
	onOpen,
	onArchive,
	onSnooze,
	onDelete,
}: MessageRowProps) {
	const [snoozing, setSnoozing] = useState(false);
	const [dx, setDx] = useState(0);
	const swipe = useRef<{ x: number; y: number; axis?: "x" | "y" } | null>(null);
	const shift = useRef(false);
	const content = useRef<HTMLDivElement>(null);
	// The content follows the finger; set directly instead of through a style prop.
	useLayoutEffect(() => {
		if (content.current) content.current.style.transform = dx ? `translateX(${dx}px)` : "";
	}, [dx]);

	// Touch only: a mouse drag over rows is selection, not a swipe.
	const release = () => {
		const el = content.current;
		const width = el?.offsetWidth ?? 1;
		swipe.current = null;
		if (Math.abs(dx) < width * 0.35 || !el) {
			el?.animate(
				{ transform: [`translateX(${dx}px)`, "none"] },
				{ duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
			);
			setDx(0);
			return;
		}
		const out = dx < 0 ? -width : width;
		el.animate(
			{ transform: [`translateX(${dx}px)`, `translateX(${out}px)`] },
			{ duration: 160, easing: "ease-in", fill: "forwards" },
		).finished.then(() => {
			if (dx < 0) onArchive?.();
			else {
				for (const a of el.getAnimations()) a.cancel();
				setDx(0);
				setSnoozing(true);
			}
		});
	};

	const icon = (label: string, shortcut: string, children: ReactNode, onClick?: () => void) => (
		<Tooltip content={label} shortcut={shortcut}>
			<button
				type="button"
				aria-label={label}
				className={action}
				onClick={(e) => {
					e.stopPropagation();
					onClick?.();
				}}
			>
				{children}
			</button>
		</Tooltip>
	);

	return (
		<div
			data-row
			role="option"
			tabIndex={0}
			aria-selected={selected}
			aria-label={`${unread ? "Unread, " : ""}${from}, ${subject}, ${formatMailDateLong(date)}`}
			className={cn(
				"group relative touch-pan-y overflow-hidden rounded-md outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2",
				selected && "bg-selected",
			)}
			onClick={() => onOpen?.()}
			onKeyDown={(e) => {
				if (e.target !== e.currentTarget) return;
				const key = e.key.toLowerCase();
				if (key === "enter") onOpen?.();
				else if (key === "e") onArchive?.();
				else if (key === "h") setSnoozing(true);
				else if (key === "#") onDelete?.();
				else if (key === "x") onSelectedChange?.(!selected, e.shiftKey);
				else return;
				e.preventDefault();
			}}
			onPointerDown={(e) => {
				if (e.pointerType === "touch") swipe.current = { x: e.clientX, y: e.clientY };
			}}
			onPointerMove={(e) => {
				const s = swipe.current;
				if (!s) return;
				const mx = e.clientX - s.x;
				const my = e.clientY - s.y;
				s.axis ??= Math.abs(mx) > 8 ? "x" : Math.abs(my) > 8 ? "y" : undefined;
				if (s.axis === "y") swipe.current = null;
				else if (s.axis === "x") setDx(mx);
			}}
			onPointerUp={() => swipe.current?.axis === "x" && release()}
			onPointerCancel={() => {
				swipe.current = null;
				setDx(0);
			}}
		>
			{/* What a swipe reveals: archive on the right (swiping left), snooze on the left (swiping right). */}
			{dx !== 0 && (
				<div
					className={cn(
						"absolute inset-0 flex items-center px-4 text-on-ink [&_svg]:size-4",
						dx < 0 ? "justify-end bg-positive" : "bg-ink",
					)}
				>
					{dx < 0 ? <Archive strokeWidth={1.75} /> : <Clock strokeWidth={1.75} />}
				</div>
			)}
			<div ref={content} className={cn("relative flex h-11 items-center gap-3 px-2", dx !== 0 && "bg-paper")}>
				{/* Pressing here and dragging across rows selects them (handled by MessageList). */}
				<span
					data-select-handle
					className={cn(
						"flex touch-none opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
						(selecting || selected) && "opacity-100",
					)}
					onClickCapture={(e) => {
						shift.current = e.shiftKey;
						e.stopPropagation();
					}}
				>
					<Checkbox
						aria-label={`Select message from ${from}`}
						checked={selected}
						onCheckedChange={(checked) => onSelectedChange?.(checked, shift.current)}
					/>
				</span>
				<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-ink", !unread && "invisible")} />
				<span className={cn("w-40 shrink-0 truncate", unread && "font-semibold")}>{from}</span>
				<span className="min-w-0 flex-1 truncate">
					<span className={cn(unread && "font-semibold")}>{subject}</span>
					{snippet && <span className="text-muted"> · {snippet}</span>}
				</span>
				{attachments > 0 && (
					<Paperclip
						aria-label={`${attachments} attachments`}
						strokeWidth={1.75}
						className="size-4 shrink-0 text-muted"
					/>
				)}
				{/* Date and actions share one slot and crossfade, so nothing around them moves. */}
				<span className="relative grid w-24 shrink-0 justify-items-end">
					<span
						className={cn(
							"col-start-1 row-start-1 self-center text-sm text-muted tabular-nums transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0",
							snoozing && "opacity-0",
							unread && "text-ink",
						)}
					>
						{formatMailDate(date)}
					</span>
					<span
						className={cn(
							"pointer-events-none col-start-1 row-start-1 flex opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100",
							snoozing && "pointer-events-auto opacity-100",
						)}
					>
						{icon("Archive", "E", <Archive strokeWidth={1.75} />, onArchive)}
						<SnoozePicker
							open={snoozing}
							onOpenChange={setSnoozing}
							onSnooze={(until) => onSnooze?.(until)}
							trigger={
								<button
									type="button"
									aria-label="Snooze"
									title="Snooze (H)"
									className={action}
									onClick={(e) => {
										e.stopPropagation();
										setSnoozing(true);
									}}
								>
									<Clock strokeWidth={1.75} />
								</button>
							}
						/>
						{icon("Delete", "#", <Trash2 strokeWidth={1.75} />, onDelete)}
					</span>
				</span>
			</div>
		</div>
	);
}
