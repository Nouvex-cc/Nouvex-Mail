// SPDX-License-Identifier: AGPL-3.0-only
import type { SearchQuery } from "@nouvex/ui";
import type { Message } from "./db";

// Whether a message matches what the search field produced. Dates are YYYY-MM-DD in local time.
// ponytail: "to:" matches nothing yet, recipients aren't stored.
export function matches(m: Message, q: SearchQuery) {
	const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
	const haystack = `${m.subject} ${m.snippet} ${m.fromName} ${m.fromAddr}`.toLowerCase();
	const day = new Date(m.sentAt).toLocaleDateString("sv");
	return (
		words.every((w) => haystack.includes(w)) &&
		q.filters.every(({ key, value }) => {
			if (key === "from") return m.fromAddr.toLowerCase().includes(value.toLowerCase());
			if (key === "after") return day >= value;
			if (key === "before") return day < value;
			if (key === "is" && value === "unread") return !m.flags.includes("\\Seen");
			if (key === "is" && value === "starred") return m.flags.includes("\\Flagged");
			if (key === "has" && value === "attachment") return m.attachments.length > 0;
			return false;
		})
	);
}
