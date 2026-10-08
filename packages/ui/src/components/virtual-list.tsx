// SPDX-License-Identifier: Apache-2.0
import { useVirtualizer } from "@tanstack/react-virtual";
import { type Key, type ReactNode, useRef } from "react";
import { cn } from "../lib";

export type VirtualListProps<T> = {
	items: T[];
	estimateSize: number;
	renderItem: (item: T, index: number) => ReactNode;
	getKey: (item: T) => Key;
	className?: string;
};

// Rows are measured after render, so estimateSize only needs to be close.
export function VirtualList<T>({ items, estimateSize, renderItem, getKey, className }: VirtualListProps<T>) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const v = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => estimateSize,
		getItemKey: (i) => getKey(items[i] as T),
	});
	return (
		<div ref={scrollRef} className={cn("min-h-0 overflow-auto overscroll-contain", className)}>
			{/* oxlint-disable-next-line shadcn/no-inline-styles */}
			<div className="relative w-full" style={{ height: v.getTotalSize() }}>
				{v.getVirtualItems().map((row) => (
					<div
						key={row.key}
						ref={v.measureElement}
						data-index={row.index}
						className="absolute top-0 left-0 w-full"
						// oxlint-disable-next-line shadcn/no-inline-styles
						style={{ transform: `translateY(${row.start}px)` }}
					>
						{renderItem(items[row.index] as T, row.index)}
					</div>
				))}
			</div>
		</div>
	);
}
