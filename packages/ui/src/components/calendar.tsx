// SPDX-License-Identifier: Apache-2.0
import { Popover } from "@base-ui/react/popover";
import { Select as BaseSelect } from "@base-ui/react/select";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

type Option = { value: number; label: string };

// Month and year in the header: a list that opens around the current value, plus typing. While the list is open,
// the middle row (over the header) becomes the field showing what you type, and the first match is highlighted; Enter takes it, or takes a typed value that
// isn't in the list (a year like 1850, a month number like 3).
function Picker({
	value,
	options,
	onChange,
	parse,
	chars,
	name,
}: {
	value: number;
	options: Option[];
	onChange: (value: number) => void;
	parse: (typed: string) => number | null;
	chars: RegExp;
	name: string;
}) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	useEffect(() => {
		if (!typed) return;
		const t = setTimeout(() => setTyped(""), 1500);
		return () => clearTimeout(t);
	}, [typed]);
	const label = options.find((o) => o.value === value)?.label ?? String(value);

	return (
		<Select.Root
			value={value}
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setTyped("");
			}}
			onValueChange={(v) => v !== null && onChange(v)}
		>
			<BaseSelect.Trigger
				aria-label={`${label}, change ${name}`}
				className="-mx-1 rounded-sm px-1 tabular-nums outline-none hover:bg-hover focus-visible:outline-2 open:bg-hover"
			>
				<BaseSelect.Value>{() => <TextMorph by="text">{label}</TextMorph>}</BaseSelect.Value>
			</BaseSelect.Trigger>
			<Select.Popup
				onKeyDownCapture={(e) => {
					if (e.key === "Backspace") setTyped((t) => t.slice(0, -1));
					else if (e.key === "Enter" && typed) {
						const v = parse(typed);
						if (v === null) return;
						e.preventDefault();
						e.stopPropagation();
						onChange(v);
						setOpen(false);
					} else if (e.key.length === 1 && chars.test(e.key)) setTyped((t) => (t + e.key).slice(0, 12));
				}}
			>
				{options.map((o) => (
					// `label` keeps matching on the option itself while the middle row shows what's being typed.
					<Select.Item key={o.value} value={o.value} label={o.label}>
						{typed && o.value === value ? (
							<span className="-mx-1 inline-flex items-center rounded-sm bg-paper px-1 ring-1 ring-line-strong">
								{typed}
								<span data-idle className="text-caret ml-px inline-block h-4 w-0.5 rounded-full bg-ink" />
							</span>
						) : (
							o.label
						)}
					</Select.Item>
				))}
			</Select.Popup>
		</Select.Root>
	);
}

const months: Option[] = Array.from({ length: 12 }, (_, m) => ({
	value: m,
	label: new Date(2000, m, 1).toLocaleDateString(undefined, { month: "long" }),
}));
const parseMonth = (typed: string) => {
	const n = Number(typed);
	return Number.isInteger(n) && n >= 1 && n <= 12 ? n - 1 : null;
};
const parseYear = (typed: string) => (/^\d{4}$/.test(typed) ? Number(typed) : null);
// Three years either side; any other year is a few keystrokes away.
const years = (around: number): Option[] =>
	Array.from({ length: 7 }, (_, i) => ({ value: around - 3 + i, label: String(around - 3 + i) }));

// The header is ours, not the library's: its caption is rebuilt on every month change and couldn't animate across
// it. Here the month name crossfades while the year stays and glides.
export function Calendar({ className, classNames, month, defaultMonth, onMonthChange, ...props }: DayPickerProps) {
	const [shown, setShown] = useState(() => month ?? defaultMonth ?? new Date());
	const current = month ?? shown;
	const go = (date: Date) => {
		setShown(date);
		onMonthChange?.(date);
	};
	// Month and year are separate elements, so the year glides by hand whenever the month label changes width.
	const yearBox = useRef<HTMLSpanElement>(null);
	const yearLeft = useRef<number | null>(null);
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
	});

	return (
		<div className={cn("grid gap-2 p-3 select-none", className)}>
			<div className="flex h-7 items-center justify-between pl-1">
				<span aria-live="polite" className="relative flex items-baseline gap-1 font-semibold">
					<Picker
						name="month"
						value={current.getMonth()}
						options={months}
						parse={parseMonth}
						chars={/[\p{L}\d]/u}
						onChange={(m) => go(new Date(current.getFullYear(), m, 1))}
					/>
					<span ref={yearBox} className="inline-flex">
						<Picker
							name="year"
							value={current.getFullYear()}
							options={years(current.getFullYear())}
							parse={parseYear}
							chars={/\d/}
							onChange={(year) => go(new Date(year, current.getMonth(), 1))}
						/>
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
