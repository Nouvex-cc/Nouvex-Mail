// SPDX-License-Identifier: Apache-2.0
import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import { cn, type Styled } from "../lib";

export function Toggle({ className, ...props }: Styled<BaseToggle.Props>) {
	return (
		<BaseToggle
			className={cn(
				"inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-muted outline-none transition duration-100 hover:bg-hover hover:text-ink checked:bg-selected checked:text-ink disabled:opacity-50 [&_svg]:size-4",
				className,
			)}
			{...props}
		/>
	);
}

export function ToggleGroup({ className, ...props }: Styled<BaseToggleGroup.Props>) {
	return <BaseToggleGroup className={cn("flex items-center gap-0.5", className)} {...props} />;
}
