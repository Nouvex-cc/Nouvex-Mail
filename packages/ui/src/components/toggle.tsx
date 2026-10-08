// SPDX-License-Identifier: Apache-2.0
import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import { cn, type Styled } from "../lib";
import { Highlight } from "./highlight";

export function Toggle({ className, ...props }: Styled<BaseToggle.Props>) {
	return (
		<BaseToggle
			className={cn(
				"relative inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-muted outline-none transition duration-100 hover:bg-hover hover:text-ink active:scale-95 checked:bg-selected checked:text-ink disabled:opacity-50 [&_svg]:size-4 [[data-slide]_&]:checked:bg-transparent",
				className,
			)}
			{...props}
		/>
	);
}

// With a single choice, one pill slides to the active option instead of options lighting up one by one.
export function ToggleGroup({ className, children, ...props }: Styled<BaseToggleGroup.Props>) {
	const slide = !props.multiple;
	return (
		<BaseToggleGroup
			data-slide={slide || undefined}
			className={cn("relative flex items-center gap-0.5", className)}
			{...props}
		>
			{slide && <Highlight attr="data-pressed" className="rounded-md bg-selected" />}
			{children}
		</BaseToggleGroup>
	);
}
