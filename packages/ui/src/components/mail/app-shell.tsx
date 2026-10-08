// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "../../lib";

/** Logo, header and sidebar as one surface; the content sits in it with a rounded corner. */
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
			{/* Spans the whole width so the header is centered in the window. */}
			<div className="col-span-2 grid h-16 grid-cols-[minmax(0,1fr)_minmax(0,36rem)_minmax(0,1fr)] items-center gap-3 px-4">
				{logo}
				<header className="flex items-center">{header}</header>
			</div>
			<div className="min-h-0">{sidebar}</div>
			<main className="min-h-0 overflow-auto rounded-tl-xl border-t border-l border-line bg-paper">{children}</main>
		</div>
	);
}
