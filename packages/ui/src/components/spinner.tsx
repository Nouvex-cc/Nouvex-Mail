// SPDX-License-Identifier: Apache-2.0
import { cn } from "../lib";

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
	return (
		<span
			role="status"
			aria-label={label}
			className={cn(
				"inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent text-muted",
				className,
			)}
		/>
	);
}
