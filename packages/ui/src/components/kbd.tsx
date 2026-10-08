// SPDX-License-Identifier: Apache-2.0
import type { ComponentProps } from "react";
import { cn } from "../lib";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
	return (
		<kbd
			className={cn(
				"inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line px-1 font-sans text-xs text-muted",
				className,
			)}
			{...props}
		/>
	);
}
