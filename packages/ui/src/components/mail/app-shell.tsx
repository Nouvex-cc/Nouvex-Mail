// SPDX-License-Identifier: Apache-2.0
import { ScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode } from "react";
import { cn } from "../../lib";

/**
 * Logo, header and sidebar as one surface; the content sits in it as a panel with rounded top corners. The panel
 * scrolls without a native scrollbar: a thin line in the gap to the window's right edge shows where you are, never
 * over the content. It brightens while scrolling and widens under the pointer to be dragged.
 */
export function AppShell({
	logo,
	sidebar,
	header,
	backdrop,
	children,
	className,
}: {
	logo?: ReactNode;
	sidebar: ReactNode;
	header: ReactNode;
	/** Behind the content panel and fixed while it scrolls, e.g. a <Backdrop>; the panel turns see-through. */
	backdrop?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid grid-cols-[15rem_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] bg-sunken", className)}>
			{/* Spans the whole width so the header is centered in the window. */}
			<div
				data-frame
				className="col-span-2 grid h-16 grid-cols-[minmax(0,1fr)_minmax(0,36rem)_minmax(0,1fr)] items-center gap-3 px-4"
			>
				{logo}
				<header className="flex items-center">{header}</header>
			</div>
			<div data-frame className="min-h-0">
				{sidebar}
			</div>
			<ScrollArea.Root className="relative min-h-0 pr-2.5">
				{backdrop && <div className="absolute inset-y-0 right-2.5 left-0 overflow-hidden rounded-t-xl">{backdrop}</div>}
				<ScrollArea.Viewport
					render={<main />}
					className={cn(
						"relative h-full overscroll-contain rounded-t-xl border-x border-t border-line outline-none",
						!backdrop && "bg-paper",
					)}
				>
					{children}
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar
					orientation="vertical"
					className="group/rail absolute top-3 right-0 bottom-3 hidden w-2.5 cursor-grab touch-none justify-center active:cursor-grabbing data-has-overflow-y:flex"
				>
					<ScrollArea.Thumb className="w-0.5 rounded-full bg-line-strong transition-[width,background-color] duration-200 ease-out group-hover/rail:w-1.5 group-hover/rail:bg-muted group-active/rail:w-1.5 group-active/rail:bg-ink group-data-scrolling/rail:w-1 group-data-scrolling/rail:bg-muted" />
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>
		</div>
	);
}
