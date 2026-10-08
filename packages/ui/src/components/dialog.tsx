// SPDX-License-Identifier: Apache-2.0
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cn, type Styled } from "../lib";

export const backdrop =
	"fixed inset-0 z-50 bg-scrim transition duration-150 ease-out starting:opacity-0 ending:opacity-0";
export const dialogPopup =
	"relative w-full rounded-lg border border-line bg-raised text-ink shadow-dialog outline-none transition duration-200 ease-out starting:scale-96 starting:opacity-0 ending:scale-96 ending:opacity-0 ending:duration-150";

function DialogPopup({ className, ...props }: Styled<BaseDialog.Popup.Props>) {
	return (
		<BaseDialog.Portal>
			<BaseDialog.Backdrop className={backdrop} />
			<BaseDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
				<BaseDialog.Popup className={cn(dialogPopup, "grid max-w-md gap-3 p-5", className)} {...props} />
			</BaseDialog.Viewport>
		</BaseDialog.Portal>
	);
}

function DialogTitle({ className, ...props }: Styled<BaseDialog.Title.Props>) {
	return <BaseDialog.Title className={cn("text-xl font-semibold", className)} {...props} />;
}

function DialogDescription({ className, ...props }: Styled<BaseDialog.Description.Props>) {
	return <BaseDialog.Description className={cn("text-muted", className)} {...props} />;
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("flex justify-end gap-2 pt-2", className)} {...props} />;
}

export const Dialog = {
	Root: BaseDialog.Root,
	Trigger: BaseDialog.Trigger,
	Close: BaseDialog.Close,
	Popup: DialogPopup,
	Title: DialogTitle,
	Description: DialogDescription,
	Footer: DialogFooter,
};

export const AlertDialog = {
	...Dialog,
	Root: BaseAlertDialog.Root,
	Trigger: BaseAlertDialog.Trigger,
};
