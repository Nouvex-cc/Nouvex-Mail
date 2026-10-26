// SPDX-License-Identifier: AGPL-3.0-only
// How a reply or forward is addressed and titled, the same rules as the Apple apps (Answering.swift).

export type Kind = "reply" | "replyAll" | "forward";

// Prefixes other mail apps put in front, in English, German and Nordic ones; one is enough.
const replies = ["re", "aw", "antw", "sv", "vs"];
const forwards = ["fwd", "fw", "wg", "vb", "tr"];

/** "Re: Plan" for a reply, "Fwd: Plan" for a forward, without stacking "Re: Aw: Plan". */
export function subject(kind: Kind, subject: string) {
	const trimmed = subject.trim();
	const head = trimmed.split(":")[0]?.toLowerCase() ?? "";
	if (trimmed.includes(":") && (kind === "forward" ? forwards : replies).includes(head)) return trimmed;
	return `${kind === "forward" ? "Fwd:" : "Re:"} ${trimmed}`;
}

/**
 * Who an answer goes to. A reply goes to Reply-To where there is one, else to the sender, and to whoever one of our
 * own messages went to; Reply all keeps the others in Cc, as they were, without our own addresses.
 */
export function addresses(
	kind: Kind,
	m: { fromAddr: string; replyTo?: string; to: string[]; cc: string[] },
	mine: Set<string>,
): { to: string[]; cc: string[] } {
	if (kind === "forward") return { to: [], cc: [] };
	const ours = mine.has(m.fromAddr.toLowerCase());
	const to = ours ? m.to : [m.replyTo ?? m.fromAddr];
	if (kind !== "replyAll") return { to, cc: [] };
	const seen = new Set([...to, ...mine].map((a) => a.toLowerCase()));
	const cc = [...(ours ? [] : m.to), ...m.cc].filter((a) => !seen.has(a.toLowerCase()) && !!seen.add(a.toLowerCase()));
	return { to: to.filter((a) => !mine.has(a.toLowerCase())), cc };
}

/** The References of an answer: the conversation's Message-IDs, oldest first, the newest 20. */
export const references = (thread: string[]) => thread.filter(Boolean).slice(-20);

/** A mail as plain text for quoting, its paragraphs and line breaks kept. */
export function text(html: string) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const el of doc.querySelectorAll("style, script, head")) el.remove();
	for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
	for (const el of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote")) el.append("\n");
	return (doc.body.textContent ?? "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
