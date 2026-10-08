// SPDX-License-Identifier: Apache-2.0
import { Popover } from "@base-ui/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, type DayPickerProps } from "react-day-picker";
import { cn, popup } from "../lib";
import { Button } from "./button";

const nav =
	"inline-flex size-7 items-center justify-center rounded-md text-muted outline-none hover:bg-hover hover:text-ink disabled:opacity-40";

export function Calendar({ className, classNames, ...props }: DayPickerProps) {
	return (
		<DayPicker
			showOutsideDays
			className={cn("p-3 select-none", className)}
			classNames={{
				months: "relative",
				month: "grid gap-2",
				month_caption: "flex h-7 items-center px-1",
				caption_label: "font-semibold",
				nav: "absolute top-0 right-0 flex gap-0.5",
				button_previous: nav,
				button_next: nav,
				month_grid: "border-collapse",
				weekdays: "flex",
				weekday: "w-8 text-xs font-medium text-muted",
				week: "mt-0.5 flex",
				day: "size-8 p-0 text-center",
				day_button:
					"inline-flex size-8 items-center justify-center rounded-md outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2",
				selected: "[&>button]:bg-ink [&>button]:text-on-ink [&>button]:hover:bg-ink",
				today: "font-semibold underline underline-offset-4",
				outside: "text-faint",
				disabled: "text-faint [&>button]:pointer-events-none",
				hidden: "invisible",
				...classNames,
			}}
			components={{
				Chevron: ({ orientation }) =>
					orientation === "left" ? (
						<ChevronLeft strokeWidth={1.75} className="size-4" />
					) : (
						<ChevronRight strokeWidth={1.75} className="size-4" />
					),
			}}
			{...props}
		/>
	);
}

export type DatePickerProps = {
	value: Date | undefined;
	onChange: (date: Date | undefined) => void;
	placeholder?: string;
	className?: string;
};

export function DatePicker({ value, onChange, placeholder = "Pick a date", className }: DatePickerProps) {
	return (
		<Popover.Root>
			<Popover.Trigger render={<Button className={cn("font-normal", className)} />}>
				<CalendarDays strokeWidth={1.75} className="text-muted" />
				{value ? (
					value.toLocaleDateString(undefined, { dateStyle: "medium" })
				) : (
					<span className="text-faint">{placeholder}</span>
				)}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner sideOffset={6} align="start">
					<Popover.Popup className={popup}>
						<Calendar mode="single" selected={value} onSelect={onChange} autoFocus />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
