// SPDX-License-Identifier: Apache-2.0
import { Popover } from "@base-ui/react/popover";
import { Select as BaseSelect } from "@base-ui/react/select";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DayPicker, type DayPickerProps } from "react-day-picker";
import { cn, field, popup } from "../lib";
import { parseDate } from "../parse-date";
import { useCaret } from "./caret";
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
			<Select.Trigger
				bare
				aria-label={`${label}, change ${name}`}
				className="-mx-1 rounded-sm px-1 tabular-nums outline-none hover:bg-hover focus-visible:outline-2 open:bg-hover"
			>
				<BaseSelect.Value data-fold-hide>{() => <TextMorph by="text">{label}</TextMorph>}</BaseSelect.Value>
			</Select.Trigger>
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

export type DateRange = { from: Date | undefined; to?: Date | undefined };

const dayFromCell = (iso: string | undefined) => {
	const [y, m, d] = (iso ?? "").split("-").map(Number);
	return y && m && d ? new Date(y, m - 1, d) : null;
};
const span = (a: Date, b: Date): DateRange => (a <= b ? { from: a, to: b } : { from: b, to: a });

/**
 * Pick a range by clicking start and end, or by pressing on a day and dragging across others (like selecting
 * several photos at once). Keyboard selection goes through the day picker's own range logic.
 */
export function RangeCalendar({
	value,
	onChange,
	className,
}: {
	value: DateRange | undefined;
	onChange: (range: DateRange | undefined) => void;
	className?: string;
}) {
	const drag = useRef<{ anchor: Date; moved: boolean } | null>(null);
	// The day under the pointer, also when a finger slides across cells.
	const dayAt = (x: number, y: number) =>
		dayFromCell(document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-day]")?.dataset.day);

	return (
		<div
			className={cn("touch-none", className)}
			onPointerDown={(e) => {
				const day = e.button === 0 ? dayAt(e.clientX, e.clientY) : null;
				if (!day) return;
				drag.current = { anchor: day, moved: false };
				e.currentTarget.setPointerCapture(e.pointerId);
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				const day = d && dayAt(e.clientX, e.clientY);
				if (!d || !day || (!d.moved && day.getTime() === d.anchor.getTime())) return;
				d.moved = true;
				onChange(span(d.anchor, day));
			}}
			onPointerUp={() => {
				const d = drag.current;
				drag.current = null;
				if (!d || d.moved) return;
				// A plain click: first one starts a new range, the second one closes it.
				if (!value?.from || value.to) onChange({ from: d.anchor, to: undefined });
				else onChange(span(value.from, d.anchor));
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
		>
			<Calendar
				mode="range"
				selected={value}
				defaultMonth={value?.from}
				// Pointer clicks are handled above; a click with detail 0 comes from the keyboard.
				onSelect={(range, _day, _modifiers, e) => {
					if (e.detail === 0) onChange(range);
				}}
				classNames={{
					range_start: "rounded-l-md bg-selected",
					range_end: "rounded-r-md bg-selected",
					// The band wraps by week, so it gets round ends wherever a row starts or stops.
					range_middle:
						"bg-selected first:rounded-l-md last:rounded-r-md [&>button]:bg-transparent! [&>button]:text-ink! [&>button]:hover:bg-hover!",
				}}
			/>
		</div>
	);
}

type Part = "day" | "month" | "year";
const numeric = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
const isPart = (type: string): type is Part => type === "day" || type === "month" || type === "year";

// Day, month and year in the order the user's locale writes them, e.g. month, day, year for en-US.
const dateOrder = (): Part[] =>
	numeric
		.formatToParts(new Date(2000, 10, 22))
		.map((p) => p.type)
		.filter(isPart);

const formatDate = (date: Date) => numeric.format(date);

const datePattern = () => {
	const separator = numeric.formatToParts(new Date()).find((p) => p.type === "literal")?.value ?? "/";
	return dateOrder()
		.map((t) => ({ day: "DD", month: "MM", year: "YYYY" })[t])
		.join(separator);
};

export type DatePickerProps = {
	value: Date | undefined;
	onChange: (date: Date | undefined) => void;
	placeholder?: string;
	className?: string;
};

/**
 * Typing first: the field takes a date as text, the button on its right opens the calendar. Enter or leaving the
 * field applies the text; something that isn't a date stays visible and marked so it can be fixed, Escape restores.
 */
export function DatePicker({ value, onChange, placeholder, className }: DatePickerProps) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState(value ? formatDate(value) : "");
	const [invalid, setInvalid] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const caret = useCaret<HTMLInputElement>();

	// Follow value changes from outside (or from the calendar).
	const shown = useRef(value);
	if (shown.current !== value) {
		shown.current = value;
		setText(value ? formatDate(value) : "");
		setInvalid(false);
	}

	const apply = () => {
		if (!text.trim()) {
			setInvalid(false);
			if (value) onChange(undefined);
			return;
		}
		const date = parseDate(text);
		if (!date) return setInvalid(true);
		setInvalid(false);
		setText(formatDate(date));
		if (date.getTime() !== value?.getTime()) onChange(date);
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<div ref={box} className={cn("relative", className)}>
				{caret.wrap(
					<input
						ref={caret.ref}
						value={text}
						placeholder={placeholder ?? datePattern()}
						inputMode="numeric"
						aria-invalid={invalid || undefined}
						data-invalid={invalid || undefined}
						className={cn(field, "pr-9 tabular-nums", caret.caretClass)}
						onChange={(e) => {
							setText(e.target.value);
							setInvalid(false);
						}}
						onBlur={apply}
						onKeyDown={(e) => {
							if (e.key === "Enter") apply();
							else if (e.key === "Escape" && !open) {
								setText(value ? formatDate(value) : "");
								setInvalid(false);
							} else if (e.key === "ArrowDown" && e.altKey) {
								e.preventDefault();
								setOpen(true);
							}
						}}
					/>,
				)}
				<Popover.Trigger
					aria-label="Open calendar"
					className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 open:bg-hover open:text-ink"
				>
					<CalendarDays strokeWidth={1.75} className="size-4" />
				</Popover.Trigger>
			</div>
			<Popover.Portal>
				<Popover.Positioner anchor={box} sideOffset={6} align="start">
					<Popover.Popup className={popup}>
						<Calendar
							mode="single"
							defaultMonth={value ?? parseDate(text) ?? undefined}
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
