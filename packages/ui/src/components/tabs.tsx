// SPDX-License-Identifier: Apache-2.0
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cn, type Styled } from "../lib";

/** line: an underline under the active tab. chips: pills in a row that scrolls sideways, for filters over a list. */
type Variant = { variant?: "line" | "chips" };

function List({ className, children, variant = "line", ...props }: Styled<BaseTabs.List.Props> & Variant) {
	if (variant === "chips")
		return (
			<BaseTabs.List
				className={cn("flex gap-1.5 overflow-x-auto px-4 pt-3 pb-1 [scrollbar-width:none]", className)}
				{...props}
			>
				{children}
			</BaseTabs.List>
		);
	return (
		<BaseTabs.List className={cn("relative z-0 flex gap-1 border-b border-line", className)} {...props}>
			{children}
			<BaseTabs.Indicator className="absolute bottom-0 left-0 -z-1 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) bg-accent transition-all duration-150 ease-out" />
		</BaseTabs.List>
	);
}

function Tab({ className, variant = "line", ...props }: Styled<BaseTabs.Tab.Props> & Variant) {
	if (variant === "chips")
		return (
			<BaseTabs.Tab
				className={cn(
					"flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-sm font-medium text-muted outline-none transition-colors duration-100 select-none hover:text-ink focus-visible:outline-2 data-active:border-ink data-active:bg-ink data-active:text-on-ink",
					className,
				)}
				{...props}
			/>
		);
	return (
		<BaseTabs.Tab
			className={cn(
				"flex h-9 items-center gap-1.5 px-2 font-medium text-muted outline-none transition-colors duration-100 select-none hover:text-ink focus-visible:rounded-sm focus-visible:outline-2 data-active:text-ink disabled:text-faint [&_svg]:size-4",
				className,
			)}
			{...props}
		/>
	);
}

function Panel({ className, ...props }: Styled<BaseTabs.Panel.Props>) {
	return <BaseTabs.Panel className={cn("pt-4 outline-none", className)} {...props} />;
}

export const Tabs = { Root: BaseTabs.Root, List, Tab, Panel };
