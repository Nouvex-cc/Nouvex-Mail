// SPDX-License-Identifier: Apache-2.0
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, X } from "lucide-react";
import { cn, field, item, label, popup, type Styled } from "../lib";
import { Highlight } from "./highlight";

// Multiple selection: wrap Chips around Chip items plus the Input, inside <Combobox.Value>{(v) => ...}</Combobox.Value>.
export const Combobox = {
	Root: BaseCombobox.Root,
	Value: BaseCombobox.Value,
	Input: ({ className, ...props }: Styled<BaseCombobox.Input.Props>) => (
		<BaseCombobox.Input className={cn(field, className)} {...props} />
	),
	Chips: ({ className, ...props }: Styled<BaseCombobox.Chips.Props>) => (
		<BaseCombobox.Chips
			className={cn(
				"flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line-strong bg-paper px-1.5 py-1 focus-within:border-ink [&_input]:h-6 [&_input]:min-w-16 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:px-1 [&_input]:outline-none [&_input]:placeholder:text-faint",
				className,
			)}
			{...props}
		/>
	),
	// Unstyled input that sits inside Chips; Chips styles it.
	ChipsInput: BaseCombobox.Input,
	Chip: ({ className, children, ...props }: Styled<BaseCombobox.Chip.Props>) => (
		<BaseCombobox.Chip
			className={cn(
				"flex h-6 cursor-default items-center gap-1 rounded-sm bg-selected pr-0.5 pl-2 text-sm outline-none highlighted:bg-ink highlighted:text-on-ink focus-within:bg-ink focus-within:text-on-ink",
				className,
			)}
			{...props}
		>
			{children}
			<BaseCombobox.ChipRemove className="grid size-5 place-items-center rounded-sm hover:bg-hover hover:text-ink">
				<X className="size-3.5" strokeWidth={1.75} />
			</BaseCombobox.ChipRemove>
		</BaseCombobox.Chip>
	),
	Popup: ({ className, children, ...props }: Styled<BaseCombobox.Popup.Props>) => (
		<BaseCombobox.Portal>
			<BaseCombobox.Positioner sideOffset={4} className="outline-none">
				<BaseCombobox.Popup
					className={cn(
						popup,
						"relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) overflow-y-auto overscroll-contain p-1",
						className,
					)}
					{...props}
				>
					<Highlight />
					{children}
				</BaseCombobox.Popup>
			</BaseCombobox.Positioner>
		</BaseCombobox.Portal>
	),
	List: ({ className, ...props }: Styled<BaseCombobox.List.Props>) => (
		<BaseCombobox.List className={cn("outline-none data-empty:hidden", className)} {...props} />
	),
	Item: ({ className, children, ...props }: Styled<BaseCombobox.Item.Props>) => (
		<BaseCombobox.Item className={cn(item, className)} {...props}>
			{children}
			<BaseCombobox.ItemIndicator className="ml-auto">
				<Check strokeWidth={1.75} />
			</BaseCombobox.ItemIndicator>
		</BaseCombobox.Item>
	),
	Empty: ({ className, ...props }: Styled<BaseCombobox.Empty.Props>) => (
		<BaseCombobox.Empty className={cn("px-2 py-1.5 text-sm text-muted empty:hidden", className)} {...props} />
	),
	Group: BaseCombobox.Group,
	GroupLabel: ({ className, ...props }: Styled<BaseCombobox.GroupLabel.Props>) => (
		<BaseCombobox.GroupLabel className={cn(label, className)} {...props} />
	),
};
