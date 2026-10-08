// SPDX-License-Identifier: Apache-2.0
import { Separator as BaseSeparator } from "@base-ui/react/separator";
import { cn, type Styled } from "../lib";

export function Separator({ className, ...props }: Styled<BaseSeparator.Props>) {
	return (
		<BaseSeparator
			className={cn("shrink-0 bg-line data-[orientation=horizontal]:h-px data-[orientation=vertical]:w-px", className)}
			{...props}
		/>
	);
}
