// SPDX-License-Identifier: Apache-2.0
import { Autocomplete as BaseAutocomplete } from "@base-ui/react/autocomplete";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { cn, item, label, type Styled } from "../lib";
import { backdrop, dialogPopup } from "./dialog";

// Always open and rendered inline: the list is the palette, not a dropdown.
const CommandRoot = ((props: BaseAutocomplete.Root.Props<unknown>) => (
	<BaseAutocomplete.Root open inline autoHighlight="always" keepHighlight {...props} />
)) as typeof BaseAutocomplete.Root;

function CommandInput({ className, ...props }: Styled<BaseAutocomplete.Input.Props>) {
	return (
		<BaseAutocomplete.InputGroup className="flex items-center gap-2 border-b border-line px-3 text-muted [&_svg]:size-4 [&_svg]:shrink-0">
			<Search strokeWidth={1.75} />
			<BaseAutocomplete.Input
				className={cn("h-11 w-full bg-transparent text-ink outline-none placeholder:text-faint", className)}
				{...props}
			/>
		</BaseAutocomplete.InputGroup>
	);
}

function CommandList({ className, ...props }: Styled<BaseAutocomplete.List.Props>) {
	return (
		<div className="max-h-80 overflow-y-auto overscroll-contain">
			<BaseAutocomplete.List className={cn("p-1 empty:p-0", className)} {...props} />
		</div>
	);
}

function CommandItem({ className, ...props }: Styled<BaseAutocomplete.Item.Props>) {
	return <BaseAutocomplete.Item className={cn(item, "scroll-my-1", className)} {...props} />;
}

function CommandGroupLabel({ className, ...props }: Styled<BaseAutocomplete.GroupLabel.Props>) {
	return <BaseAutocomplete.GroupLabel className={cn(label, "pt-2", className)} {...props} />;
}

function CommandEmpty({ className, ...props }: Styled<BaseAutocomplete.Empty.Props>) {
	return (
		<BaseAutocomplete.Empty
			className={cn("px-3 text-center text-sm text-muted not-empty:py-6", className)}
			{...props}
		/>
	);
}

export const Command = {
	Root: CommandRoot,
	Input: CommandInput,
	List: CommandList,
	Item: CommandItem,
	Group: BaseAutocomplete.Group,
	GroupLabel: CommandGroupLabel,
	Collection: BaseAutocomplete.Collection,
	Empty: CommandEmpty,
};

export type CommandDialogProps = {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	label?: string;
	children: ReactNode;
};

export function CommandDialog({ open, onOpenChange, label = "Command palette", children }: CommandDialogProps) {
	return (
		<BaseDialog.Root open={open} onOpenChange={onOpenChange}>
			<BaseDialog.Portal>
				<BaseDialog.Backdrop className={backdrop} />
				<BaseDialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24">
					<BaseDialog.Popup aria-label={label} className={cn(dialogPopup, "max-w-lg overflow-hidden")}>
						{children}
						<BaseDialog.Close className="sr-only">Close</BaseDialog.Close>
					</BaseDialog.Popup>
				</BaseDialog.Viewport>
			</BaseDialog.Portal>
		</BaseDialog.Root>
	);
}
