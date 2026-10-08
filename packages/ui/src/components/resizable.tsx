// SPDX-License-Identifier: Apache-2.0
import type { ComponentProps } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "../lib";

// The library already widens the hit area (resizeTargetMinimumSize), so the visible line stays 1px.
function Handle({ className, ...props }: ComponentProps<typeof Separator>) {
	return (
		<Separator
			className={cn(
				"relative shrink-0 bg-line outline-none transition-colors duration-100 aria-[orientation=horizontal]:h-px aria-[orientation=vertical]:w-px data-[separator=active]:bg-ink data-[separator=focus]:bg-ink data-[separator=hover]:bg-ink",
				className,
			)}
			{...props}
		/>
	);
}

export const Resizable = { Group, Panel, Handle };
