// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "../../lib";

/**
 * The frame of the app: sidebar and header are one surface, and the content sits in it as a lighter panel with a
 * rounded corner where the two meet.
 */
export function AppShell({
	sidebar,
	header,
	children,
	className,
}: {
	sidebar: ReactNode;
	header: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid grid-cols-[15rem_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] bg-sunken", className)}>
			<div className="row-span-2 min-h-0">{sidebar}</div>
			{/* As tall as the sidebar's account picker (48px plus its 8px padding), so both line up. */}
			<header className="flex h-16 items-center gap-3 pr-3">{header}</header>
			<main className="min-h-0 overflow-auto rounded-tl-xl border-t border-l border-line bg-paper">{children}</main>
		</div>
	);
}
