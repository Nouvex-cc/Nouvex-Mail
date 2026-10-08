// SPDX-License-Identifier: Apache-2.0
import { Popover as BasePopover } from "@base-ui/react/popover";
import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import { cn, popup, type Styled } from "../lib";

type Placement = Pick<BasePopover.Positioner.Props, "side" | "align" | "sideOffset">;

function PopoverPopup({
	className,
	side,
	align,
	sideOffset = 6,
	...props
}: Styled<BasePopover.Popup.Props> & Placement) {
	return (
		<BasePopover.Portal>
			<BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
				<BasePopover.Popup className={cn(popup, "grid max-w-80 gap-1 p-3", className)} {...props} />
			</BasePopover.Positioner>
		</BasePopover.Portal>
	);
}

function PopoverTitle({ className, ...props }: Styled<BasePopover.Title.Props>) {
	return <BasePopover.Title className={cn("font-semibold", className)} {...props} />;
}

function PopoverDescription({ className, ...props }: Styled<BasePopover.Description.Props>) {
	return <BasePopover.Description className={cn("text-sm text-muted", className)} {...props} />;
}

export const Popover = {
	Root: BasePopover.Root,
	Trigger: BasePopover.Trigger,
	Close: BasePopover.Close,
	Popup: PopoverPopup,
	Title: PopoverTitle,
	Description: PopoverDescription,
};

function PreviewCardPopup({
	className,
	side,
	align,
	sideOffset = 6,
	...props
}: Styled<BasePreviewCard.Popup.Props> & Pick<BasePreviewCard.Positioner.Props, "side" | "align" | "sideOffset">) {
	return (
		<BasePreviewCard.Portal>
			<BasePreviewCard.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
				<BasePreviewCard.Popup className={cn(popup, "w-72 p-3", className)} {...props} />
			</BasePreviewCard.Positioner>
		</BasePreviewCard.Portal>
	);
}

export const PreviewCard = {
	Root: BasePreviewCard.Root,
	Trigger: BasePreviewCard.Trigger,
	Popup: PreviewCardPopup,
};
