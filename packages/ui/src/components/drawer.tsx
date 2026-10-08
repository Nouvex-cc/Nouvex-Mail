// SPDX-License-Identifier: Apache-2.0
import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import { cn, type Styled } from "../lib";
import { backdrop } from "./dialog";

// Bottom sheet. Swipe down to dismiss.
function DrawerPopup({ className, children, ...props }: Styled<BaseDrawer.Popup.Props>) {
	return (
		<BaseDrawer.Portal>
			<BaseDrawer.Backdrop className={backdrop} />
			<BaseDrawer.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
				<BaseDrawer.Popup
					className={cn(
						"max-h-[85dvh] w-full translate-y-(--drawer-swipe-movement-y) overflow-y-auto overscroll-contain rounded-t-lg border-t border-line bg-raised px-4 pt-3 pb-8 text-ink shadow-dialog outline-none transition duration-300 ease-out starting:translate-y-full ending:translate-y-full ending:duration-200 data-swiping:select-none data-swiping:duration-0",
						className,
					)}
					{...props}
				>
					<div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />
					<BaseDrawer.Content className="mx-auto grid w-full max-w-lg gap-3">{children}</BaseDrawer.Content>
				</BaseDrawer.Popup>
			</BaseDrawer.Viewport>
		</BaseDrawer.Portal>
	);
}

function DrawerTitle({ className, ...props }: Styled<BaseDrawer.Title.Props>) {
	return <BaseDrawer.Title className={cn("text-xl font-semibold", className)} {...props} />;
}

function DrawerDescription({ className, ...props }: Styled<BaseDrawer.Description.Props>) {
	return <BaseDrawer.Description className={cn("text-muted", className)} {...props} />;
}

export const Drawer = {
	Root: BaseDrawer.Root,
	Trigger: BaseDrawer.Trigger,
	Close: BaseDrawer.Close,
	Popup: DrawerPopup,
	Title: DrawerTitle,
	Description: DrawerDescription,
};
