// SPDX-License-Identifier: Apache-2.0
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckboxGroup as BaseCheckboxGroup } from "@base-ui/react/checkbox-group";
import { cn, type Styled } from "../lib";

// Own paths instead of icons: drawn left to right with pathLength 1 so the mark can stroke itself in.
const mark = (d: string, className: string) => (
	<svg
		aria-hidden
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={3}
		strokeLinecap="round"
		strokeLinejoin="round"
		className={cn("checkbox-mark size-3", className)}
	>
		<path d={d} pathLength={1} />
	</svg>
);

export function Checkbox({ className, ...props }: Styled<BaseCheckbox.Root.Props>) {
	return (
		<BaseCheckbox.Root
			className={cn(
				"group grid size-4 shrink-0 place-items-center rounded-sm border border-line-strong bg-paper text-on-ink outline-none transition duration-150 ease-out focus-visible:outline-2 active:scale-92 checked:border-ink checked:bg-ink data-indeterminate:border-ink data-indeterminate:bg-ink disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<BaseCheckbox.Indicator className="grid place-items-center transition-opacity duration-100 ending:opacity-0">
				{mark("M5 12.5 10 17.5 19 7", "group-data-indeterminate:hidden")}
				{mark("M6 12h12", "hidden group-data-indeterminate:block")}
			</BaseCheckbox.Indicator>
		</BaseCheckbox.Root>
	);
}

export function CheckboxGroup({ className, ...props }: Styled<BaseCheckboxGroup.Props>) {
	return <BaseCheckboxGroup className={cn("grid gap-2", className)} {...props} />;
}
