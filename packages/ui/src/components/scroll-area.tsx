// SPDX-License-Identifier: Apache-2.0
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { cn, type Styled } from "../lib";

const bar =
	"pointer-events-none flex p-0.5 opacity-0 transition-opacity duration-150 data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-scrolling:duration-0 data-[orientation=horizontal]:h-2.5 data-[orientation=vertical]:w-2.5";

export function ScrollArea({ className, children, ...props }: Styled<BaseScrollArea.Root.Props>) {
	return (
		<BaseScrollArea.Root className={cn("relative min-h-0 overflow-hidden", className)} {...props}>
			<BaseScrollArea.Viewport className="h-full overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2">
				{children}
			</BaseScrollArea.Viewport>
			<BaseScrollArea.Scrollbar orientation="vertical" className={bar}>
				<BaseScrollArea.Thumb className="w-full rounded-full bg-line-strong" />
			</BaseScrollArea.Scrollbar>
			<BaseScrollArea.Scrollbar orientation="horizontal" className={bar}>
				<BaseScrollArea.Thumb className="h-full rounded-full bg-line-strong" />
			</BaseScrollArea.Scrollbar>
		</BaseScrollArea.Root>
	);
}
