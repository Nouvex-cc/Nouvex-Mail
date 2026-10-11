// SPDX-License-Identifier: AGPL-3.0-only
import {
	AppShell,
	Button,
	Checkbox,
	MessageRow,
	SearchField,
	Sidebar,
	Switch,
	Thread,
	ThreadMessage,
	Toggle,
	ToggleGroup,
} from "@nouvex/ui";
import { Archive, ChevronLeft, Clock, File, Inbox, PenLine, Send, Star, Trash2 } from "@nouvex/ui/icons";
import { useState } from "react";

// Ways to bring color into the app, each applied to the real shell. The themes only set tokens (see index.css).

const day = (offset: number, h: number, m = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	d.setHours(h, m, 0, 0);
	return d;
};

const directions = [
	["ink", "Ink", "Today: no hue, the accent is ink."],
	["accent", "Accent", "One hue for what's on, chosen or new: buttons, the active folder, unread, checked controls."],
	["tinted", "Tinted", "The accent, and the frame around the content takes on a breath of the same hue."],
	["people", "People", "Chrome stays neutral; every person keeps a color, so senders are recognized at a glance."],
	["frame", "Frame", "The frame around the content is the color, deep and calm; the content stays paper."],
] as const;

const hues = [
	["255", "Blue"],
	["290", "Violet"],
	["160", "Green"],
	["60", "Amber"],
	["15", "Rose"],
] as const;

const rows = [
	["Lena Hartmann", "Keys for the new flat", "Friday is fine, see you at 18:00.", day(0, 9, 42), true],
	["Vivid Money", "15 days left to get €150", "Just a few steps left", day(0, 7, 15), true],
	["Jonas Weber", "Heating in the new flat", "I'll bring the meter key on Friday.", day(-1, 16, 2), false],
	["Mira Okafor", "Dinner next week?", "We finally have a free evening, Tuesday or Thursday?", day(-2, 20, 11), false],
	["Paul Schneider", "Invoice October", "Attached is the invoice for October.", day(-3, 10, 0), false],
	["GitHub", "Your weekly digest", "3 pull requests need your review.", day(-4, 8, 30), false],
] as const;

function List() {
	const [selected, setSelected] = useState("Heating in the new flat");
	return (
		<div role="listbox" aria-label="Inbox" className="p-2">
			{rows.map(([from, subject, snippet, date, unread]) => (
				<MessageRow
					key={subject}
					from={from}
					subject={subject}
					snippet={snippet}
					date={date}
					unread={unread}
					selected={selected === subject}
					onOpen={() => setSelected(subject)}
				/>
			))}
		</div>
	);
}

function Conversation() {
	return (
		<Thread
			subject="Keys for the new flat"
			back={
				<Button variant="ghost" size="sm">
					<ChevronLeft strokeWidth={1.75} />
					Inbox
				</Button>
			}
			reply={{ to: "Lena Hartmann", onReply() {}, onForward() {} }}
		>
			<ThreadMessage
				from="Jonas Weber"
				email="jonas@weber.example"
				to={["Lena Hartmann"]}
				date={day(-2, 9, 4)}
				snippet="I'll bring the meter key."
			>
				<p className="text-lg">I'll bring the meter key.</p>
			</ThreadMessage>
			<ThreadMessage
				from="Mateo Coerdts"
				email="mateo@nouvex.example"
				to={["Lena Hartmann"]}
				date={day(-2, 18, 4)}
				snippet="Could we move the handover to Friday?"
			>
				<p className="text-lg">Could we move the handover to Friday?</p>
			</ThreadMessage>
			<ThreadMessage
				from="Lena Hartmann"
				email="lena@hartmann.example"
				to={["Mateo Coerdts", "Jonas Weber"]}
				date={day(0, 9, 42)}
				snippet="Friday is fine, see you at 18:00."
			>
				<div className="grid gap-4 text-lg leading-relaxed">
					<p>Hi Mateo,</p>
					<p>Friday is fine, see you at 18:00. Jonas from the building management will join us for the heating.</p>
					<p>Best, Lena</p>
				</div>
			</ThreadMessage>
		</Thread>
	);
}

export function ColorsDemo() {
	const [direction, setDirection] = useState<string>("accent");
	const [hue, setHue] = useState<string>("255");
	const [view, setView] = useState("inbox");
	const [active, setActive] = useState("inbox");
	const about = directions.find(([id]) => id === direction)?.[2];

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<ToggleGroup value={[direction]} onValueChange={(v) => v[0] && setDirection(v[0])}>
					{directions.map(([id, name], i) => (
						<Toggle key={id} value={id}>
							{i + 1}. {name}
						</Toggle>
					))}
				</ToggleGroup>
				<ToggleGroup value={[hue]} onValueChange={(v) => v[0] && setHue(v[0])}>
					{hues.map(([h, name]) => (
						<Toggle key={h} value={h}>
							{name}
						</Toggle>
					))}
				</ToggleGroup>
				<ToggleGroup value={[view]} onValueChange={(v) => v[0] && setView(v[0])}>
					<Toggle value="inbox">List</Toggle>
					<Toggle value="mail">Conversation</Toggle>
				</ToggleGroup>
			</div>
			<p className="text-sm text-muted">{about}</p>
			<div
				data-tone={direction}
				data-people={direction === "people" ? "color" : undefined}
				style={{ "--hue": hue } as React.CSSProperties}
				className="grid gap-4"
			>
				<div className="flex items-center gap-4">
					<Button variant="primary">
						<PenLine strokeWidth={1.75} />
						Write
					</Button>
					<Button>Archive</Button>
					<Switch defaultChecked aria-label="Notifications" />
					<Checkbox defaultChecked aria-label="Selected" />
				</div>
				<div className="overflow-hidden rounded-xl border border-line">
					<AppShell
						className="h-180"
						logo={<span className="logo" />}
						header={<SearchField className="w-full" contacts={[]} onSearch={() => {}} />}
						sidebar={
							<Sidebar.Root>
								<Sidebar.Section>
									{[
										["write", "Write", PenLine],
										["inbox", "Inbox", Inbox],
										["starred", "Starred", Star],
										["snoozed", "Snoozed", Clock],
										["sent", "Sent", Send],
										["drafts", "Drafts", File],
										["archive", "Archive", Archive],
										["trash", "Trash", Trash2],
									].map(([id, label, Icon]) => {
										const I = Icon as typeof Inbox;
										return (
											<Sidebar.Item
												key={id as string}
												label={label as string}
												icon={<I strokeWidth={1.75} />}
												unread={id === "inbox"}
												active={active === id}
												onSelect={() => setActive(id as string)}
											/>
										);
									})}
								</Sidebar.Section>
								<Sidebar.Section title="Labels">
									{[
										["receipts", "Receipts", "green"],
										["travel", "Travel", "blue"],
										["family", "Family", "orange"],
									].map(([id, label, color]) => (
										<Sidebar.Label
											key={id}
											label={label as string}
											color={color as "green"}
											active={active === id}
											onSelect={() => setActive(id as string)}
										/>
									))}
								</Sidebar.Section>
							</Sidebar.Root>
						}
					>
						{view === "inbox" ? <List /> : <Conversation />}
					</AppShell>
				</div>
			</div>
		</div>
	);
}
