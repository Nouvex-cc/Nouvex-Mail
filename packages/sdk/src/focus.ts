// SPDX-License-Identifier: Apache-2.0

/** A group's focus times: days 0 (Sunday) to 6, times as HH:MM on the reader's clock. Outside them it rests. */
export type Focus = { days: number[]; from: string; to: string };

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Whether a weekday and minute of the day fall into the focus times. Over midnight they belong to the day they start. */
export function within(f: Focus, day: number, minute: number) {
	const [from, to] = [minutes(f.from), minutes(f.to)];
	if (from < to) return f.days.includes(day) && minute >= from && minute < to;
	return (f.days.includes(day) && minute >= from) || (f.days.includes((day + 6) % 7) && minute < to);
}
