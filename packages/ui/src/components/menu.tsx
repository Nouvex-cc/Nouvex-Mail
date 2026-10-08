// SPDX-License-Identifier: Apache-2.0
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { Check, ChevronRight } from "../icons";
import { cn, item, popup, type Styled } from "../lib";
import { Highlight } from "./highlight";

type PopupProps = Styled<BaseMenu.Popup.Props> & Pick<BaseMenu.Positioner.Props, "side" | "align" | "sideOffset">;

const popupClass = "relative min-w-44 p-1";

function MenuPopup({ className, side, align = "start", sideOffset = 4, children, ...props }: PopupProps) {
	return (
		<BaseMenu.Portal>
			<BaseMenu.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50 outline-none">
				<BaseMenu.Popup className={cn(popup, popupClass, className)} {...props}>
					<Highlight />
					{children}
				</BaseMenu.Popup>
			</BaseMenu.Positioner>
		</BaseMenu.Portal>
	);
}

function ContextMenuPopup({ className, children, ...props }: Styled<BaseMenu.Popup.Props>) {
	return (
		<BaseContextMenu.Portal>
			<BaseContextMenu.Positioner className="z-50 outline-none">
				<BaseContextMenu.Popup className={cn(popup, popupClass, className)} {...props}>
					<Highlight />
					{children}
				</BaseContextMenu.Popup>
			</BaseContextMenu.Positioner>
		</BaseContextMenu.Portal>
	);
}

function MenuItem({ className, ...props }: Styled<BaseMenu.Item.Props>) {
	return <BaseMenu.Item className={cn(item, className)} {...props} />;
}

function MenuSeparator({ className, ...props }: Styled<BaseMenu.Separator.Props>) {
	return <BaseMenu.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

function MenuCheckboxItem({ className, children, ...props }: Styled<BaseMenu.CheckboxItem.Props>) {
	return (
		<BaseMenu.CheckboxItem className={cn(item, "relative pr-8 pl-7", className)} {...props}>
			<BaseMenu.CheckboxItemIndicator className="absolute left-2">
				<Check strokeWidth={1.75} />
			</BaseMenu.CheckboxItemIndicator>
			{children}
		</BaseMenu.CheckboxItem>
	);
}

function MenuSubmenuTrigger({ className, children, ...props }: Styled<BaseMenu.SubmenuTrigger.Props>) {
	return (
		<BaseMenu.SubmenuTrigger className={cn(item, "open:bg-hover", className)} {...props}>
			{children}
			<ChevronRight strokeWidth={1.75} className="ml-auto text-muted" />
		</BaseMenu.SubmenuTrigger>
	);
}

function MenuShortcut({ className, ...props }: ComponentProps<"span">) {
	return <span className={cn("ml-auto pl-4 text-xs text-muted", className)} {...props} />;
}

export const Menu = {
	Root: BaseMenu.Root,
	Trigger: BaseMenu.Trigger,
	Popup: MenuPopup,
	Item: MenuItem,
	Separator: MenuSeparator,
	CheckboxItem: MenuCheckboxItem,
	SubmenuRoot: BaseMenu.SubmenuRoot,
	SubmenuTrigger: MenuSubmenuTrigger,
	Shortcut: MenuShortcut,
};

export const ContextMenu = {
	...Menu,
	Root: BaseContextMenu.Root,
	Trigger: BaseContextMenu.Trigger,
	Popup: ContextMenuPopup,
};
