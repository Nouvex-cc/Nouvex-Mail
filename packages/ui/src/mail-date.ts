// SPDX-License-Identifier: Apache-2.0

// How mail lists show a date: the time today, the weekday within the last week, otherwise day and month
// (with the year once it isn't this year).
export function formatMailDate(date: Date, now = new Date()): string {
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (date >= startOfToday) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const daysAgo = (startOfToday.getTime() - date.getTime()) / 86_400_000;
	if (daysAgo < 6) return date.toLocaleDateString(undefined, { weekday: "short" });
	return date.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
}

// Full date and time for headers and tooltips, e.g. "Thu, Oct 8, 2026, 9:42 AM".
export const formatMailDateLong = (date: Date) =>
	date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
