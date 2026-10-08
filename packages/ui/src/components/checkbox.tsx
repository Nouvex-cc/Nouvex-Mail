// SPDX-License-Identifier: Apache-2.0
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckboxGroup as BaseCheckboxGroup } from "@base-ui/react/checkbox-group";
import { Check, Minus } from "lucide-react";
import { cn, type Styled } from "../lib";

export function Checkbox({ className, ...props }: Styled<BaseCheckbox.Root.Props>) {
	return (
		<BaseCheckbox.Root
			className={cn(
				"group grid size-4 shrink-0 place-items-center rounded-sm border border-line-strong bg-paper text-on-ink outline-none transition duration-100 focus-visible:outline-2 checked:border-ink checked:bg-ink data-indeterminate:border-ink data-indeterminate:bg-ink disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<BaseCheckbox.Indicator className="grid place-items-center">
				<Check className="size-3 group-data-indeterminate:hidden" strokeWidth={2.5} />
				<Minus className="hidden size-3 group-data-indeterminate:block" strokeWidth={2.5} />
			</BaseCheckbox.Indicator>
		</BaseCheckbox.Root>
	);
}

export function CheckboxGroup({ className, ...props }: Styled<BaseCheckboxGroup.Props>) {
	return <BaseCheckboxGroup className={cn("grid gap-2", className)} {...props} />;
}
