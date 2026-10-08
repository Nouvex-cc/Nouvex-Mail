// SPDX-License-Identifier: Apache-2.0
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn, type Styled } from "../lib";

export function Switch({ className, ...props }: Styled<BaseSwitch.Root.Props>) {
	return (
		<BaseSwitch.Root
			className={cn(
				"group inline-flex h-5 w-8 shrink-0 rounded-full bg-line-strong p-0.5 outline-none transition duration-150 checked:bg-ink disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{/* Stretches a little while pressed, like a finger pushing it; checked, it grows toward the left so it stays put. */}
			<BaseSwitch.Thumb className="h-4 w-4 rounded-full bg-paper transition-all duration-150 ease-out group-active:w-5 checked:translate-x-3 checked:group-active:translate-x-2" />
		</BaseSwitch.Root>
	);
}
