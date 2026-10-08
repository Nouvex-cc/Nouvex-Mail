// SPDX-License-Identifier: Apache-2.0
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn, type Styled } from "../lib";

export function Switch({ className, ...props }: Styled<BaseSwitch.Root.Props>) {
	return (
		<BaseSwitch.Root
			className={cn(
				"inline-flex h-5 w-8 shrink-0 rounded-full bg-line-strong p-0.5 outline-none transition duration-150 checked:bg-ink disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<BaseSwitch.Thumb className="size-4 rounded-full bg-paper transition duration-150 ease-out checked:translate-x-3" />
		</BaseSwitch.Root>
	);
}
