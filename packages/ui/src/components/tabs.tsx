// SPDX-License-Identifier: Apache-2.0
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cn, type Styled } from "../lib";

function List({ className, children, ...props }: Styled<BaseTabs.List.Props>) {
	return (
		<BaseTabs.List className={cn("relative z-0 flex gap-1 border-b border-line", className)} {...props}>
			{children}
			<BaseTabs.Indicator className="absolute bottom-0 left-0 -z-1 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) bg-ink transition-all duration-150 ease-out" />
		</BaseTabs.List>
	);
}

function Tab({ className, ...props }: Styled<BaseTabs.Tab.Props>) {
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
