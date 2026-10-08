// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "../../lib";

/**
 * The frame of the app: logo, sidebar and header are one surface, and the content sits in it as a lighter panel
 * with a rounded corner where they meet. The logo takes the top left, the sidebar starts below it.
 */
export function AppShell({
	logo,
	sidebar,
	header,
	children,
	className,
}: {
	logo?: ReactNode;
	sidebar: ReactNode;
	header: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid grid-cols-[15rem_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] bg-sunken", className)}>
			<div className="flex h-16 items-center px-4">{logo}</div>
			<header className="flex h-16 items-center gap-3 pr-3">{header}</header>
			<div className="min-h-0">{sidebar}</div>
			<main className="min-h-0 overflow-auto rounded-tl-xl border-t border-l border-line bg-paper">{children}</main>
		</div>
	);
}
