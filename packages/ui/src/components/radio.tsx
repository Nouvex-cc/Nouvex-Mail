// SPDX-License-Identifier: Apache-2.0
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { cn, type Styled } from "../lib";

export function RadioGroup({ className, ...props }: Styled<BaseRadioGroup.Props>) {
	return <BaseRadioGroup className={cn("grid gap-2", className)} {...props} />;
}

export function Radio({ className, ...props }: Styled<BaseRadio.Root.Props>) {
	return (
		<BaseRadio.Root
			className={cn(
				"grid size-4 shrink-0 place-items-center rounded-full border border-line-strong bg-paper outline-none transition duration-150 ease-out active:scale-92 checked:border-ink disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<BaseRadio.Indicator className="size-2 rounded-full bg-ink transition-transform duration-150 ease-out starting:scale-0 ending:scale-0" />
		</BaseRadio.Root>
	);
}
