// SPDX-License-Identifier: Apache-2.0
import { Popover as BasePopover } from "@base-ui/react/popover";
import { type ReactElement, useState } from "react";
import { CalendarDays } from "../../icons";
import { cn, field, popup } from "../../lib";
import { addDays, parseDate } from "../../parse-date";
import { Calendar } from "../calendar";
import { Highlight } from "../highlight";

const at = (day: Date, hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);

function quickOptions(now: Date) {
	const weekday = now.getDay();
	const options: { label: string; date: Date }[] = [];
	if (now.getHours() < 18)
		options.push({ label: "Later today", date: at(now, now.getHours() + 3 + (now.getMinutes() ? 1 : 0)) });
	options.push({ label: "Tomorrow", date: at(addDays(now, 1), 8) });
	if (weekday !== 0 && weekday !== 6) options.push({ label: "This weekend", date: at(addDays(now, 6 - weekday), 9) });
	options.push({ label: "Next week", date: at(addDays(now, (8 - weekday) % 7 || 7), 8) });
	return options;
}

// "tomorrow 3pm", "fri 15:00", "15.10. at 9", "in 2 days": a day parseDate understands plus an optional time.
// A time needs ":" , am/pm or "at" so it isn't mistaken for a date. Without a day it means today (tomorrow if
// that time has passed); without a time it means 8:00.
export function parseSnooze(text: string, now = new Date()): Date | null {
	const match = text.trim().match(/(?:^|\s)(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
	const isTime = !!match && (match[2] !== undefined || match[3] !== undefined || /at\s*\d/i.test(match[0]));
	const rest = isTime && match ? text.trim().slice(0, -match[0].length).trim() : text.trim();
	let hour = 8;
	let minute = 0;
	if (isTime && match) {
		const meridiem = match[3]?.toLowerCase();
		hour = Number(match[1]);
		minute = Number(match[2] ?? 0);
		if (meridiem) {
			if (hour < 1 || hour > 12) return null;
			hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
		}
		if (hour > 23 || minute > 59) return null;
	}
	const day = rest ? parseDate(rest, now) : now;
	if (!day) return null;
	const date = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
	if (!rest && isTime && date <= now) date.setDate(date.getDate() + 1);
	return date > now ? date : null;
}

function formatWhen(date: Date, now: Date) {
	const near = date.getTime() - now.getTime() < 6 * 86_400_000;
	return date.toLocaleString(undefined, {
		weekday: near ? "short" : undefined,
		day: near ? undefined : "numeric",
		month: near ? undefined : "short",
		hour: "numeric",
		minute: "2-digit",
	});
}

export type SnoozePickerProps = {
	onSnooze: (until: Date) => void;
	/** The button that opens the picker; leave out to control it with `open` (e.g. after a swipe). */
	trigger?: ReactElement;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
};

/** Quick snooze times, a field that takes typed dates and times, and the full calendar one click away. */
// Other props (from a wrapping Tooltip) go to the trigger.
export function SnoozePicker({ onSnooze, trigger, open, onOpenChange, ...props }: SnoozePickerProps) {
	const [innerOpen, setInnerOpen] = useState(false);
	const [text, setText] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [calendar, setCalendar] = useState(false);
	const isOpen = open ?? innerOpen;
	const now = new Date();
	const typed = text.trim() ? parseSnooze(text, now) : null;

	const setOpen = (next: boolean) => {
		setInnerOpen(next);
		onOpenChange?.(next);
		if (!next) {
			setText("");
			setInvalid(false);
			setCalendar(false);
		}
	};
	const choose = (date: Date) => {
		onSnooze(date);
		setOpen(false);
	};
	// Options and the field share the arrow keys; the highlight follows whichever has focus or the pointer.
	const move = (e: React.KeyboardEvent<HTMLElement>, step: number) => {
		const items = [
			...(e.currentTarget.closest("[data-snooze]")?.querySelectorAll<HTMLElement>("[data-snooze-item]") ?? []),
		];
		const next = items[(items.indexOf(e.currentTarget) + step + items.length) % items.length];
		if (!next) return;
		e.preventDefault();
		next.focus();
	};
	const mark = (el: HTMLElement) => {
		for (const item of el.closest("[data-snooze]")?.querySelectorAll("[data-active]") ?? [])
			item.removeAttribute("data-active");
		el.setAttribute("data-active", "");
	};

	return (
		<BasePopover.Root open={isOpen} onOpenChange={setOpen}>
			{trigger && <BasePopover.Trigger render={trigger} {...props} />}
			<BasePopover.Portal>
				<BasePopover.Positioner sideOffset={6} align="end" className="z-50">
					<BasePopover.Popup data-snooze className={cn(popup, "w-64 p-1")}>
						{calendar ? (
							<Calendar mode="single" onSelect={(day) => day && choose(at(day, 8))} autoFocus />
						) : (
							<>
								<div className="relative grid">
									<Highlight attr="data-active" />
									{quickOptions(now).map((o) => (
										<button
											key={o.label}
											type="button"
											data-snooze-item
											className="relative flex items-center justify-between rounded-sm px-2 py-1.5 text-left outline-none"
											onClick={() => choose(o.date)}
											onFocus={(e) => mark(e.currentTarget)}
											onPointerEnter={(e) => mark(e.currentTarget)}
											onKeyDown={(e) =>
												e.key === "ArrowDown" ? move(e, 1) : e.key === "ArrowUp" ? move(e, -1) : undefined
											}
										>
											{o.label}
											<span className="text-sm text-muted">{formatWhen(o.date, now)}</span>
										</button>
									))}
								</div>
								<div className="my-1 h-px bg-line" />
								<div className="grid gap-1 p-1">
									<input
										data-snooze-item
										value={text}
										placeholder="Tomorrow 3pm, fri 9:00…"
										aria-label="Snooze until"
										aria-invalid={invalid || undefined}
										data-invalid={invalid || undefined}
										className={cn(field, "h-7 text-sm")}
										onChange={(e) => {
											setText(e.target.value);
											setInvalid(false);
										}}
										onFocus={(e) => mark(e.currentTarget)}
										onKeyDown={(e) => {
											if (e.key === "ArrowDown") move(e, 1);
											else if (e.key === "ArrowUp") move(e, -1);
											else if (e.key === "Enter") {
												if (typed) choose(typed);
												else setInvalid(true);
											}
										}}
									/>
									<div className="flex h-5 items-center justify-between text-xs text-muted">
										<span>{typed ? formatWhen(typed, now) : ""}</span>
										<button
											type="button"
											className="inline-flex items-center gap-1 rounded-sm px-1 outline-none hover:text-ink focus-visible:outline-2"
											onClick={() => setCalendar(true)}
										>
											<CalendarDays strokeWidth={1.75} className="size-3.5" />
											Pick date
										</button>
									</div>
								</div>
							</>
						)}
					</BasePopover.Popup>
				</BasePopover.Positioner>
			</BasePopover.Portal>
		</BasePopover.Root>
	);
}
