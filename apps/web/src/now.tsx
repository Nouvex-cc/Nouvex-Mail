// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Sidebar } from "@nouvex/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { type Action, db, type Message } from "./db";
import { usePref } from "./prefs";

const minute = 60_000;

export type Due = { message: Message; action: Action };

/**
 * What the sidebar shows at `now`: sign-in codes for `life` minutes after they arrive, meetings from `lead` minutes
 * before they start until they end. The newest invitation of a meeting wins, so an update moves it and a
 * cancellation hides it. At most three, the most urgent last, right above the profile.
 */
export function due(messages: Message[], now: number, lead: number, life: number): Due[] {
	const codes: Due[] = [];
	const meetings = new Map<string, Due>();
	for (const message of messages) {
		const sent = Date.parse(message.sentAt);
		for (const action of message.actions ?? []) {
			if (action.kind === "code" && now - sent < life * minute && sent < now + minute) codes.push({ message, action });
			if (action.kind !== "meeting") continue;
			const key = action.event || message.id;
			const had = meetings.get(key);
			if (!had || Date.parse(had.message.sentAt) < sent) meetings.set(key, { message, action });
		}
	}
	const start = (d: Due) => Date.parse(d.action.start ?? "");
	const soon = [...meetings.values()].filter((d) => {
		const end = d.action.end ? Date.parse(d.action.end) : start(d) + 30 * minute;
		return !d.action.cancelled && start(d) - lead * minute <= now && now < end;
	});
	soon.sort((a, b) => start(b) - start(a));
	codes.sort((a, b) => Date.parse(a.message.sentAt) - Date.parse(b.message.sentAt));
	return [...soon, ...codes].slice(-3);
}

function CopyCode({ code }: { code: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			size="sm"
			success={copied && "Copied"}
			labels={["Copied"]}
			onClick={async () => {
				await navigator.clipboard.writeText(code);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			Copy
		</Button>
	);
}

/** Sign-in codes and meetings about to start of the accounts in view, above the profile. */
export function Now({ accountIds, onOpen }: { accountIds: string[]; onOpen: (m: Message) => void }) {
	const [lead] = usePref("meetingLead");
	const [life] = usePref("codeLife");
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const tick = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(tick);
	}, []);
	const found =
		useLiveQuery(async () => {
			const away = new Set(
				(await db.mailboxes.toArray()).filter((b) => b.role === "trash" || b.role === "junk").map((b) => b.id),
			);
			return (await db.messages.where("acts").equals(1).toArray()).filter((m) => !away.has(m.mailboxId));
		}, []) ?? [];
	const cards = due(
		found.filter((m) => accountIds.includes(m.accountId)),
		now,
		lead,
		life,
	);
	if (!cards.length) return null;
	return (
		<Sidebar.Now>
			{cards.map(({ message: m, action: a }) => {
				if (a.kind === "code" && a.code) {
					const ago = Math.floor((now - Date.parse(m.sentAt)) / minute);
					return (
						<Sidebar.Card
							key={`${m.id}-code`}
							title={a.code.length === 6 ? `${a.code.slice(0, 3)} ${a.code.slice(3)}` : a.code}
							detail={`${m.fromName || m.fromAddr} · ${ago < 1 ? "just now" : `${ago} min ago`}`}
							action={<CopyCode code={a.code} />}
							onOpen={() => onOpen(m)}
						/>
					);
				}
				const left = Math.ceil((Date.parse(a.start ?? "") - now) / minute);
				return (
					<Sidebar.Card
						key={`${a.event || m.id}-meeting`}
						title={a.title || m.subject}
						detail={[left > 0 ? `In ${left} min` : "Now", a.provider].filter(Boolean).join(" · ")}
						action={
							a.url && (
								<Button size="sm" onClick={() => window.open(a.url, "_blank", "noopener,noreferrer")}>
									Join
								</Button>
							)
						}
						onOpen={() => onOpen(m)}
					/>
				);
			})}
		</Sidebar.Now>
	);
}
