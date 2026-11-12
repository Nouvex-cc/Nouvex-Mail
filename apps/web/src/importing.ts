// SPDX-License-Identifier: AGPL-3.0-only
// Where an import puts each folder of the old account (POST /accounts/{id}/imports). A hosted mailbox has one folder
// per role and the user's own folders next to them, flat.

export type Target = "inbox" | "archive" | "sent" | "drafts" | "junk" | "trash" | "folder" | "skip";

export type Plan = { from: string; to: Target; name: string; count: number };

/** What the old account's folders become, at first: special folders their role, the user's own folders a flat folder
 * of the same name, and nothing from empty folders, trash, spam or Gmail's views of other folders. */
export function suggest(boxes: { name: string; role: string; count: number }[]): Plan[] {
	return boxes
		.map((b): Plan => {
			const name =
				b.name
					.replace(/^INBOX[./]/i, "")
					.split("/")
					.at(-1) ?? b.name;
			const plan = { from: b.name, name, count: b.count };
			if (b.count === 0 || b.role === "trash" || b.role === "junk") return { ...plan, to: "skip" };
			if (b.role === "snoozed") return { ...plan, to: "inbox" };
			if (b.role) return { ...plan, to: b.role as Target };
			if (b.name.startsWith("[Gmail]/") || b.name.startsWith("[Google Mail]/")) return { ...plan, to: "skip" };
			return { ...plan, to: "folder" };
		})
		.toSorted((a, b) => order.indexOf(a.to) - order.indexOf(b.to) || a.name.localeCompare(b.name));
}

const order: Target[] = ["inbox", "archive", "sent", "drafts", "folder", "junk", "trash", "skip"];

/** The folders the API takes; skipped ones stay behind. */
export const folders = (plans: Plan[]) =>
	plans
		.filter((p) => p.to !== "skip")
		.map((p) => ({ from: p.from, role: p.to === "folder" ? "" : p.to, name: p.to === "folder" ? p.name : "" }));
