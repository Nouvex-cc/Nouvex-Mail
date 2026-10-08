// SPDX-License-Identifier: Apache-2.0
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { useRef } from "react";
import { cn, type Styled } from "../lib";

export function Switch({ className, onCheckedChange, ...props }: Styled<BaseSwitch.Root.Props>) {
	const thumb = useRef<HTMLSpanElement>(null);
	return (
		<BaseSwitch.Root
			className={cn(
				"inline-flex h-5 w-8 shrink-0 rounded-full bg-line-strong p-0.5 outline-none transition duration-150 checked:bg-ink disabled:opacity-50",
				className,
			)}
			onCheckedChange={(checked, details) => {
				// The thumb stretches once while it travels, started by the actual change so it's one continuous motion.
				if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
					thumb.current?.animate({ scale: ["1 1", "1.35 1", "1 1"] }, { duration: 200, easing: "ease-out" });
				onCheckedChange?.(checked, details);
			}}
			{...props}
		>
			<BaseSwitch.Thumb
				ref={thumb}
				className="size-4 rounded-full bg-paper transition-transform duration-200 ease-out checked:translate-x-3"
			/>
		</BaseSwitch.Root>
	);
}
