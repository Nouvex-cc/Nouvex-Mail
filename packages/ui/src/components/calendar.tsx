// SPDX-License-Identifier: Apache-2.0
import { Popover } from "@base-ui/react/popover";
import { Select as BaseSelect } from "@base-ui/react/select";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { DayPicker, type DayPickerProps } from "react-day-picker";
import { cn, popup } from "../lib";
import { Button } from "./button";
import { Select } from "./select";
import { TextMorph } from "./text-morph";

const nav =
	"inline-flex size-7 items-center justify-center rounded-md text-muted outline-none hover:bg-hover hover:text-ink disabled:opacity-40";

// First day of the week for the user's region (Monday in most of Europe, Sunday in the US).
function weekStart(): DayPickerProps["weekStartsOn"] {
	if (typeof navigator === "undefined") return undefined;
	const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
		getWeekInfo?: () => { firstDay: number };
		weekInfo?: { firstDay: number };
	};
	const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
	return first === undefined ? undefined : ((first % 7) as DayPickerProps["weekStartsOn"]);
}

const shift = (date: Date, months: number) => new Date(date.getFullYear(), date.getMonth() + months, 1);

// The year is a button that turns into a field: type a year, Enter or click away to jump, Escape to cancel,
// arrow keys to step.
function Year({ year, onChange }: { year: number; onChange: (year: number) => void }) {
	const [editing, setEditing] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const width = useRef(0);

	useLayoutEffect(() => {
		if (!editing || !input.current) return;
		input.current.style.width = `${width.current}px`;
		input.current.select();
	}, [editing]);

	const commit = () => {
		const next = Number(input.current?.value);
		setEditing(false);
		if (Number.isInteger(next) && next >= 1000 && next <= 9999 && next !== year) onChange(next);
	};

	const box = "-mx-1 rounded-sm px-1 font-semibold tabular-nums outline-none";
	if (editing)
		return (
			<input
				ref={input}
				defaultValue={year}
				inputMode="numeric"
				maxLength={4}
				aria-label="Year"
				className={cn(box, "bg-paper text-ink ring-1 ring-line-strong")}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						setEditing(false);
					} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						e.preventDefault();
						const next = year + (e.key === "ArrowUp" ? 1 : -1);
						e.currentTarget.value = String(next);
						onChange(next);
					}
				}}
			/>
		);
	return (
		<button
			ref={button}
			type="button"
			aria-label={`${year}, change year`}
			className={cn(box, "hover:bg-hover focus-visible:outline-2")}
			onClick={() => {
				width.current = button.current?.offsetWidth ?? 0;
				setEditing(true);
			}}
		>
			<TextMorph>{String(year)}</TextMorph>
		</button>
	);
}

// The month name opens a list of all months around itself, the current one staying in place.
function Month({ date, onChange }: { date: Date; onChange: (month: number) => void }) {
	const names = Array.from({ length: 12 }, (_, m) =>
		new Date(2000, m, 1).toLocaleDateString(undefined, { month: "long" }),
	);
	return (
		<Select.Root value={date.getMonth()} onValueChange={(m) => m !== null && onChange(m)}>
			<BaseSelect.Trigger
				aria-label={`${names[date.getMonth()]}, change month`}
				className="-mx-1 rounded-sm px-1 outline-none hover:bg-hover focus-visible:outline-2 open:bg-hover"
			>
				<BaseSelect.Value>{(m: number) => <TextMorph by="text">{names[m] ?? ""}</TextMorph>}</BaseSelect.Value>
			</BaseSelect.Trigger>
			<Select.Popup>
				{names.map((name, m) => (
					<Select.Item key={name} value={m}>
						{name}
					</Select.Item>
				))}
			</Select.Popup>
		</Select.Root>
	);
}

// The header is ours, not the library's: its caption is rebuilt on every month change and couldn't animate across
// it. Here the month name crossfades while the year stays and glides.
export function Calendar({ className, classNames, month, defaultMonth, onMonthChange, ...props }: DayPickerProps) {
	const [shown, setShown] = useState(() => month ?? defaultMonth ?? new Date());
	const current = month ?? shown;
	const go = (date: Date) => {
		setShown(date);
		onMonthChange?.(date);
	};
	const monthName = current.toLocaleDateString(undefined, { month: "long" });

	// Month and year are separate elements now, so the year glides by hand when the month name changes width.
	const yearBox = useRef<HTMLSpanElement>(null);
	const yearLeft = useRef<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the month name changes
	useLayoutEffect(() => {
		const el = yearBox.current;
		if (!el) return;
		const left = el.offsetLeft;
		if (
			yearLeft.current !== null &&
			yearLeft.current !== left &&
			!matchMedia("(prefers-reduced-motion: reduce)").matches
		)
			el.animate(
				{ transform: [`translateX(${yearLeft.current - left}px)`, "none"] },
				{ duration: 400, easing: "cubic-bezier(0.19, 1, 0.22, 1)" },
			);
		yearLeft.current = left;
	}, [monthName]);

	return (
		<div className={cn("grid gap-2 p-3 select-none", className)}>
			<div className="flex h-7 items-center justify-between pl-1">
				<span aria-live="polite" className="relative flex items-baseline gap-1 font-semibold">
					<Month date={current} onChange={(m) => go(new Date(current.getFullYear(), m, 1))} />
					<span ref={yearBox} className="inline-flex">
						<Year year={current.getFullYear()} onChange={(year) => go(new Date(year, current.getMonth(), 1))} />
					</span>
				</span>
				<span className="flex gap-0.5">
					<button type="button" aria-label="Previous month" className={nav} onClick={() => go(shift(current, -1))}>
						<ChevronLeft strokeWidth={1.75} className="size-4" />
					</button>
					<button type="button" aria-label="Next month" className={nav} onClick={() => go(shift(current, 1))}>
						<ChevronRight strokeWidth={1.75} className="size-4" />
					</button>
				</span>
			</div>
			<DayPicker
				showOutsideDays
				animate
				hideNavigation
				weekStartsOn={weekStart()}
				month={current}
				onMonthChange={go}
				classNames={{
					months: "relative",
					month: "overflow-hidden",
					month_caption: "sr-only",
					month_grid: "border-collapse",
					weekdays: "flex",
					weekday: "w-8 text-xs font-medium text-muted",
					week: "mt-0.5 flex",
					day: "size-8 p-0 text-center",
					day_button:
						"inline-flex size-8 items-center justify-center rounded-md outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2",
					selected: "[&>button]:bg-ink [&>button]:text-on-ink [&>button]:hover:bg-ink",
					today:
						"relative font-semibold after:pointer-events-none after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-current",
					outside: "text-faint",
					disabled: "text-faint [&>button]:pointer-events-none",
					hidden: "invisible",
					weeks_before_enter: "calendar-in-left",
					weeks_before_exit: "calendar-out-left",
					weeks_after_enter: "calendar-in-right",
					weeks_after_exit: "calendar-out-right",
					caption_before_exit: "hidden",
					caption_after_exit: "hidden",
					...classNames,
				}}
				{...props}
			/>
		</div>
	);
}

export type DatePickerProps = {
	value: Date | undefined;
	onChange: (date: Date | undefined) => void;
	placeholder?: string;
	className?: string;
};

export function DatePicker({ value, onChange, placeholder = "Pick a date", className }: DatePickerProps) {
	const [open, setOpen] = useState(false);
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
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
						<Calendar
							mode="single"
							defaultMonth={value}
							selected={value}
							onSelect={(date) => {
								onChange(date);
								setOpen(false);
							}}
							autoFocus
						/>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
