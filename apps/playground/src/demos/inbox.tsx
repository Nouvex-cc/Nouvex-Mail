// SPDX-License-Identifier: AGPL-3.0-only
import { BulkBar, type MailLabel, MessageList, MessageRow, useToast } from "@nouvex/ui";
import { useState } from "react";

const now = new Date();
const ago = (days: number, hours = 0, minutes = 0) =>
	new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hours || now.getHours() - 1, minutes);

type Message = {
	id: number;
	from: string;
	subject: string;
	snippet: string;
	date: Date;
	unread?: boolean;
	attachments?: number;
	labels?: MailLabel[];
};

const initial: Message[] = [
	{
		id: 1,
		from: "Lena Hartmann",
		subject: "Keys for the new flat",
		snippet: "I left them with the neighbour on the second floor, she is home after six.",
		date: ago(0, 9, 42),
		unread: true,
	},
	{
		id: 2,
		from: "Deutsche Bahn",
		subject: "Your ticket Karlsruhe → Berlin",
		labels: [{ name: "Travel", color: "blue" }],
		snippet: "ICE 374, Fri 07:12, seat 54 in car 7. Have a good trip.",
		date: ago(0, 8, 15),
		unread: true,
		attachments: 1,
	},
	{
		id: 3,
		from: "Jonas Weber",
		subject: "Re: Saturday",
		snippet: "Works for me. I'll bring the projector if you sort out snacks.",
		date: ago(0, 7, 3),
	},
	{
		id: 4,
		from: "Mira Okafor",
		subject: "Design review notes",
		snippet: "Attached the notes from Tuesday, the sidebar question is still open.",
		date: ago(1, 17, 30),
		unread: true,
		attachments: 2,
	},
	{
		id: 5,
		from: "Hetzner Online",
		subject: "Invoice R0012345678",
		labels: [{ name: "Receipts", color: "green" }],
		snippet: "Your invoice for September is ready.",
		date: ago(1, 6, 0),
		attachments: 1,
	},
	{
		id: 6,
		from: "Paul Schneider",
		subject: "Climbing on Thursday?",
		snippet: "The new hall in Durlach opens at 4, I could pick you up.",
		date: ago(2, 19, 12),
	},
	{
		id: 7,
		from: "GitHub",
		subject: "[Nouvex-cc/Nouvex-Mail] CI passed on yslate/ui",
		snippet: "All checks have passed for your pull request.",
		date: ago(3, 11, 45),
	},
	{
		id: 8,
		from: "Sofia Rossi",
		subject: "Photos from the wedding",
		labels: [{ name: "Family", color: "orange" }],
		snippet: "Finally sorted through them, here's the shared album.",
		date: ago(4, 21, 5),
		unread: true,
	},
	{
		id: 9,
		from: "Stadtwerke Karlsruhe",
		subject: "Meter reading reminder",
		snippet: "Please submit your reading by the end of the month.",
		date: ago(9, 10, 0),
	},
	{
		id: 10,
		from: "Lena Hartmann",
		subject: "Re: Rent for October",
		snippet: "Transferred, thanks for the reminder.",
		date: ago(12, 14, 20),
	},
	{
		id: 11,
		from: "Figma",
		subject: "Mira invited you to Nouvex",
		snippet: "Mira Okafor invited you to edit the file Nouvex.",
		date: ago(20, 9, 0),
	},
	{
		id: 12,
		from: "Jonas Weber",
		subject: "Tax documents",
		snippet: "Here are the forms from last year, the deadline is in two weeks.",
		date: ago(400, 16, 0),
		attachments: 3,
	},
];

export function InboxDemo() {
	const [messages, setMessages] = useState(initial);
	const [selected, setSelected] = useState<Set<number>>(new Set());
	const toast = useToast();

	const remove = (ids: number[], title: string) => {
		const gone = messages.filter((m) => ids.includes(m.id));
		setMessages((ms) => ms.filter((m) => !ids.includes(m.id)));
		setSelected(new Set());
		toast.add({
			title,
			actionProps: {
				children: "Undo",
				onClick: () => setMessages((ms) => [...ms, ...gone].sort((a, b) => b.date.getTime() - a.date.getTime())),
			},
		});
	};

	return (
		<div className="relative w-full">
			<div className="h-120 overflow-y-auto rounded-lg border border-line p-1">
				<MessageList onSelectionChange={(rows) => setSelected(new Set(rows.map((i) => messages[i]?.id ?? -1)))}>
					{messages.map((m) => (
						<MessageRow
							key={m.id}
							{...m}
							selected={selected.has(m.id)}
							selecting={selected.size > 0}
							onOpen={() => setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, unread: false } : x)))}
							onArchive={() => remove([m.id], "Archived")}
							onDelete={() => remove([m.id], "Deleted")}
							onSnooze={(until) =>
								remove(
									[m.id],
									`Snoozed until ${until.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
								)
							}
						/>
					))}
				</MessageList>
			</div>
			<BulkBar
				count={selected.size}
				onArchive={() => remove([...selected], `Archived ${selected.size}`)}
				onDelete={() => remove([...selected], `Deleted ${selected.size}`)}
				onMarkRead={() => {
					setMessages((ms) => ms.map((m) => (selected.has(m.id) ? { ...m, unread: false } : m)));
					setSelected(new Set());
				}}
				onClear={() => setSelected(new Set())}
			/>
		</div>
	);
}
