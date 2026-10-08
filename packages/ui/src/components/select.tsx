// SPDX-License-Identifier: Apache-2.0
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn, item, label, popup, type Styled } from "../lib";

export const Select = {
	Root: BaseSelect.Root,
	Trigger: ({ className, placeholder, ...props }: Styled<BaseSelect.Trigger.Props> & { placeholder?: string }) => (
		<BaseSelect.Trigger
			className={cn(
				"inline-flex h-8 min-w-36 items-center justify-between gap-2 rounded-md border border-line-strong bg-paper px-3 text-ink outline-none hover:bg-hover open:bg-hover disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<BaseSelect.Value className="truncate data-placeholder:text-faint" placeholder={placeholder} />
			<BaseSelect.Icon className="text-muted">
				<ChevronsUpDown className="size-4" strokeWidth={1.75} />
			</BaseSelect.Icon>
		</BaseSelect.Trigger>
	),
	Popup: ({ className, children, ...props }: Styled<BaseSelect.Popup.Props>) => (
		<BaseSelect.Portal>
			<BaseSelect.Positioner sideOffset={4} className="outline-none">
				<BaseSelect.Popup className={cn(popup, "min-w-(--anchor-width) p-1 ending:duration-0", className)} {...props}>
					<BaseSelect.List className="max-h-(--available-height) overflow-y-auto outline-none">
						{children}
					</BaseSelect.List>
				</BaseSelect.Popup>
			</BaseSelect.Positioner>
		</BaseSelect.Portal>
	),
	Item: ({ className, children, ...props }: Styled<BaseSelect.Item.Props>) => (
		<BaseSelect.Item className={cn(item, "data-selected:font-medium", className)} {...props}>
			<BaseSelect.ItemText>{children}</BaseSelect.ItemText>
			<BaseSelect.ItemIndicator className="ml-auto pl-4 text-ink">
				<Check strokeWidth={2} />
			</BaseSelect.ItemIndicator>
		</BaseSelect.Item>
	),
	Group: BaseSelect.Group,
	GroupLabel: ({ className, ...props }: Styled<BaseSelect.GroupLabel.Props>) => (
		<BaseSelect.GroupLabel className={cn(label, className)} {...props} />
	),
	Separator: ({ className, ...props }: Styled<BaseSelect.Separator.Props>) => (
		<BaseSelect.Separator className={cn("my-1 h-px bg-line", className)} {...props} />
	),
};
