// SPDX-License-Identifier: AGPL-3.0-only
import {
	AppShell,
	Avatar,
	Button,
	Composer,
	type Contact,
	Kbd,
	MessageRow,
	Sidebar,
	Thread,
	ThreadMessage,
	Toggle,
	ToggleGroup,
	Tooltip,
} from "@nouvex/ui";
import {
	Archive,
	ChevronLeft,
	ChevronsUpDown,
	Inbox,
	Mail,
	PenLine,
	Reply,
	Send,
	Star,
	Trash2,
	X,
} from "@nouvex/ui/icons";
import { type ReactNode, useState } from "react";

// Where the composer could live: five places for a new message in the inbox, five for a reply inside a mail.

const day = (offset: number, h: number, m = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	d.setHours(h, m, 0, 0);
	return d;
};

const contacts: Contact[] = [
	{ name: "Lena Hartmann", email: "lena@hartmann.example" },
	{ name: "Jonas Weber", email: "jonas@weber.example" },
	{ name: "Mira Okafor", email: "mira@okafor.example" },
	{ name: "Paul Schneider", email: "paul@schneider.example" },
];

const inbox = [
	["Lena Hartmann", "Keys for the new flat", "Friday is fine, see you at 18:00.", day(0, 9, 42), true],
	["Vivid Money", "15 days left to get €150", "Just a few steps left", day(0, 7, 15), true],
	["Jonas Weber", "Heating in the new flat", "I'll bring the meter key on Friday.", day(-1, 16, 2), false],
	["Mira Okafor", "Dinner next week?", "We finally have a free evening, Tuesday or Thursday?", day(-2, 20, 11), false],
	[
		"Paul Schneider",
		"Invoice October",
		"Attached is the invoice for October, payable within 14 days.",
		day(-3, 10, 0),
		false,
	],
	["GitHub", "Your weekly digest", "3 pull requests need your review.", day(-4, 8, 30), false],
	[
		"Lena Hartmann",
		"Handover protocol",
		"Draft attached, could you have a look before Friday?",
		day(-6, 14, 20),
		false,
	],
] as const;

const quote = `\n\nOn ${day(0, 9, 42).toLocaleString()}, Lena Hartmann wrote:\n> Friday is fine, see you at 18:00.`;

function From() {
	return (
		<>
			<span className="w-8">From</span>
			<span className="text-ink">Mateo Coerdts</span>
			<span>mateo@nouvex.example</span>
			<ChevronsUpDown strokeWidth={1.75} className="size-3.5" />
		</>
	);
}

// The composer as every placement shows it; only the surface around it changes.
function NewMessage({ variant = "plain", onClose }: { variant?: "plain" | "card"; onClose(): void }) {
	return (
		<Composer variant={variant} contacts={contacts} from={<From />} focus="to" onSend={onClose} onDiscard={onClose} />
	);
}

function ReplyTo({ variant = "plain", onClose }: { variant?: "plain" | "card"; onClose(): void }) {
	return (
		<Composer
			variant={variant}
			contacts={contacts}
			defaultTo={["lena@hartmann.example"]}
			defaultSubject="Re: Keys for the new flat"
			quote={quote}
			compact
			focus="body"
			onSend={onClose}
			onDiscard={onClose}
		/>
	);
}

function Head({ title, onClose, children }: { title: string; onClose(): void; children?: ReactNode }) {
	return (
		<div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
			<span className="flex-1 truncate font-medium">{title}</span>
			{children}
			<Tooltip content="Close (saved as draft)">
				<Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
					<X strokeWidth={1.75} />
				</Button>
			</Tooltip>
		</div>
	);
}

function List({ narrow }: { narrow?: boolean }) {
	return (
		<div role="listbox" aria-label="Inbox" className={narrow ? "p-1" : "p-2"}>
			{inbox.map(([from, subject, snippet, date, unread]) => (
				<MessageRow
					key={subject}
					from={from}
					subject={subject}
					snippet={narrow ? undefined : snippet}
					date={date}
					unread={unread}
				/>
			))}
		</div>
	);
}

// The overlay placements sit inside the demo frame, the way they'd sit over the app.
function Layer({ children, dim }: { children: ReactNode; dim?: boolean }) {
	return <div className={`absolute inset-0 z-20 ${dim ? "bg-scrim" : "pointer-events-none"}`}>{children}</div>;
}

const floating =
	"rounded-xl border border-line bg-raised shadow-pop transition duration-200 ease-out starting:scale-98 starting:opacity-0";

/* New message, in the inbox */

/** 1. Dialog: in the middle over the dimmed app, sized for writing, nothing else on screen. */
function NewDialog({ onClose }: { onClose(): void }) {
	return (
		<Layer dim>
			<div className="grid h-full place-items-center p-8">
				<div className={`flex h-full max-h-160 w-full max-w-2xl flex-col overflow-hidden ${floating}`}>
					<Head title="New message" onClose={onClose} />
					<NewMessage onClose={onClose} />
				</div>
			</div>
		</Layer>
	);
}

/** 2. Page: the message takes the content panel like a document; Back returns to the list. */
function NewPage({ onClose }: { onClose(): void }) {
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
				<Button variant="ghost" size="sm" onClick={onClose}>
					<ChevronLeft strokeWidth={1.75} />
					Inbox
				</Button>
				<h1 className="flex-1 font-semibold">New message</h1>
			</div>
			<div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
				<NewMessage onClose={onClose} />
			</div>
		</div>
	);
}

/** 3. Dock: a window in the bottom right over the list, so the inbox stays usable; it folds down to its title. */
function NewDock({ onClose }: { onClose(): void }) {
	const [folded, setFolded] = useState(false);
	return (
		<Layer>
			<div
				className={`pointer-events-auto absolute right-4 bottom-0 flex w-lg flex-col overflow-hidden rounded-b-none ${floating} ${folded ? "" : "h-120"}`}
			>
				<Head title="New message" onClose={onClose}>
					<Tooltip content={folded ? "Open" : "Fold down"}>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={folded ? "Open" : "Fold down"}
							onClick={() => setFolded(!folded)}
						>
							<ChevronsUpDown strokeWidth={1.75} />
						</Button>
					</Tooltip>
				</Head>
				{!folded && <NewMessage onClose={onClose} />}
			</div>
		</Layer>
	);
}

/** 4. Spotlight: opens where search opens, from the top, a card over the app; C from anywhere. */
function NewSpotlight({ onClose }: { onClose(): void }) {
	return (
		<Layer dim>
			<div className="flex justify-center px-8 pt-3">
				<div className={`flex max-h-140 w-full max-w-2xl flex-col overflow-hidden ${floating}`}>
					<NewMessage onClose={onClose} />
					<div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-xs text-muted">
						<span>
							<Kbd>⌘</Kbd> <Kbd>↵</Kbd> send
						</span>
						<span>
							<Kbd>Esc</Kbd> keep as draft
						</span>
					</div>
				</div>
			</div>
		</Layer>
	);
}

/** 5. Split: the list narrows to the left and the message opens beside it, so you can look things up while writing. */
function NewSplit({ onClose }: { onClose(): void }) {
	return (
		<div className="grid h-full grid-cols-[22rem_minmax(0,1fr)]">
			<div className="min-h-0 overflow-auto border-r border-line">
				<List narrow />
			</div>
			<div className="flex min-h-0 flex-col">
				<Head title="New message" onClose={onClose} />
				<NewMessage onClose={onClose} />
			</div>
		</div>
	);
}

/* Reply, inside a mail */

function Conversation({ onReply, composer, after }: { onReply?(): void; composer?: ReactNode; after?: ReactNode }) {
	return (
		<Thread
			subject="Keys for the new flat"
			back={
				<Button variant="ghost" size="sm">
					<ChevronLeft strokeWidth={1.75} />
					Inbox
				</Button>
			}
			actions={
				<div className="flex gap-1">
					{[
						["Star", Star],
						["Mark unread", Mail],
						["Archive", Archive],
						["Delete", Trash2],
					].map(([label, Icon]) => {
						const I = Icon as typeof Star;
						return (
							<Tooltip key={label as string} content={label as string}>
								<Button variant="ghost" size="icon" aria-label={label as string}>
									<I strokeWidth={1.75} />
								</Button>
							</Tooltip>
						);
					})}
				</div>
			}
			reply={onReply && { to: "Lena Hartmann", onReply, onForward: onReply }}
			composer={composer}
			after={after}
		>
			<ThreadMessage
				from="Mateo Coerdts"
				email="mateo@nouvex.example"
				to={["Lena Hartmann"]}
				date={day(-2, 18, 4)}
				snippet="Could we move the handover to Friday?"
			>
				<p className="text-lg">Could we move the handover to Friday? Thursday doesn't work for me after all.</p>
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
					<p>
						Friday is fine, see you at 18:00. I've attached the signed handover protocol and a photo of the meter
						readings, so we don't have to do that on the day.
					</p>
					<p>Jonas from the building management will join us for the heating.</p>
					<p>
						Best,
						<br />
						Lena
					</p>
				</div>
			</ThreadMessage>
		</Thread>
	);
}

/** 1. Grow: the reply bar itself grows into the composer, in the same place; Esc folds it back. */
function ReplyGrow({ open, setOpen }: { open: boolean; setOpen(o: boolean): void }) {
	const close = () => setOpen(false);
	return (
		<Conversation
			onReply={() => setOpen(true)}
			composer={
				open && (
					<div className={`flex max-h-120 flex-col overflow-hidden ${floating}`}>
						<Head title="Reply to Lena Hartmann" onClose={close} />
						<ReplyTo onClose={close} />
					</div>
				)
			}
		/>
	);
}

/** 2. Inline: the reply is written as the next message of the conversation, where it will end up. */
function ReplyInline({ open, setOpen }: { open: boolean; setOpen(o: boolean): void }) {
	const close = () => setOpen(false);
	return (
		<Conversation
			onReply={open ? undefined : () => setOpen(true)}
			after={
				open && (
					<section className="mt-2 grid gap-3 rounded-xl border border-line-strong p-3 transition duration-200 ease-out starting:opacity-0">
						<header className="flex items-center gap-3">
							<Avatar name="Mateo Coerdts" />
							<div className="grid flex-1">
								<span className="font-medium">Mateo Coerdts</span>
								<span className="text-sm text-muted">to Lena Hartmann</span>
							</div>
							<Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
								<X strokeWidth={1.75} />
							</Button>
						</header>
						<div className="flex min-h-64 flex-col">
							<ReplyTo onClose={close} />
						</div>
					</section>
				)
			}
		/>
	);
}

/** 3. Popover: like search, a card opens above the bar and the bar stays put to show who it's going to. */
function ReplyPopover({ open, setOpen }: { open: boolean; setOpen(o: boolean): void }) {
	const close = () => setOpen(false);
	return (
		<Conversation
			onReply={open ? undefined : () => setOpen(true)}
			composer={
				open && (
					<div className="grid gap-2">
						<div className={`flex max-h-110 flex-col overflow-hidden ${floating}`}>
							<ReplyTo onClose={close} />
						</div>
						<div className="flex items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2 text-sm text-muted shadow-pop">
							<Reply strokeWidth={1.75} className="size-4" />
							<span className="flex-1">
								Replying to <span className="text-ink">Lena Hartmann</span>
							</span>
							<Kbd>Esc</Kbd>
						</div>
					</div>
				)
			}
		/>
	);
}

/** 4. Side by side: the mail stays on the left to read along, the reply takes the right half. */
function ReplySide({ open, setOpen }: { open: boolean; setOpen(o: boolean): void }) {
	const close = () => setOpen(false);
	if (!open) return <Conversation onReply={() => setOpen(true)} />;
	return (
		<div className="grid h-full grid-cols-2">
			<div className="min-h-0 overflow-auto border-r border-line">
				<Conversation />
			</div>
			<div className="flex min-h-0 flex-col">
				<Head title="Reply to Lena Hartmann" onClose={close} />
				<ReplyTo onClose={close} />
			</div>
		</div>
	);
}

/** 5. Focus: the reply takes the panel, the mail it answers stays one click away above it. */
function ReplyFocus({ open, setOpen }: { open: boolean; setOpen(o: boolean): void }) {
	const close = () => setOpen(false);
	const [peek, setPeek] = useState(false);
	if (!open) return <Conversation onReply={() => setOpen(true)} />;
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
				<Button variant="ghost" size="sm" onClick={close}>
					<ChevronLeft strokeWidth={1.75} />
					Keys for the new flat
				</Button>
			</div>
			<div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
				<button
					type="button"
					onClick={() => setPeek(!peek)}
					className="m-3 mb-0 grid gap-1 rounded-lg bg-sunken px-3 py-2 text-left text-sm outline-none focus-visible:outline-2"
				>
					<span className="flex items-center gap-2">
						<Avatar name="Lena Hartmann" size="sm" />
						<span className="font-medium">Lena Hartmann</span>
						<span className="text-muted">wrote</span>
					</span>
					<span className={peek ? "whitespace-pre-line text-muted" : "truncate text-muted"}>
						{peek
							? "Hi Mateo,\nFriday is fine, see you at 18:00. I've attached the signed handover protocol and a photo of the meter readings, so we don't have to do that on the day.\nJonas from the building management will join us for the heating."
							: "Friday is fine, see you at 18:00. I've attached the signed handover protocol and a photo…"}
					</span>
				</button>
				<ReplyTo onClose={close} />
			</div>
		</div>
	);
}

const places = {
	inbox: [
		["Dialog", NewDialog],
		["Page", NewPage],
		["Dock", NewDock],
		["Spotlight", NewSpotlight],
		["Split", NewSplit],
	],
	mail: [
		["Grow", ReplyGrow],
		["Inline", ReplyInline],
		["Popover", ReplyPopover],
		["Side by side", ReplySide],
		["Focus", ReplyFocus],
	],
} as const;

export function ComposersDemo() {
	const [where, setWhere] = useState<"inbox" | "mail">("inbox");
	const [which, setWhich] = useState(0);
	const [open, setOpen] = useState(true);
	const [name, Place] = places[where][which] ?? places.inbox[0];
	const pick = (w: "inbox" | "mail", i: number) => {
		setWhere(w);
		setWhich(i);
		setOpen(true);
	};

	let content: ReactNode;
	if (where === "mail") {
		const Reply = Place as typeof ReplyGrow;
		content = <Reply key={name} open={open} setOpen={setOpen} />;
	} else {
		const New = Place as typeof NewDialog;
		const fills = name === "Page" || name === "Split";
		content = (
			<>
				{!(open && fills) && <List />}
				{open && <New key={name} onClose={() => setOpen(false)} />}
			</>
		);
	}

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<ToggleGroup value={[where]} onValueChange={(v) => v[0] && pick(v[0] as "inbox" | "mail", 0)}>
					<Toggle value="inbox">New message</Toggle>
					<Toggle value="mail">Reply</Toggle>
				</ToggleGroup>
				<ToggleGroup value={[String(which)]} onValueChange={(v) => v[0] && pick(where, Number(v[0]))}>
					{places[where].map(([label], i) => (
						<Toggle key={label} value={String(i)}>
							{i + 1}. {label}
						</Toggle>
					))}
				</ToggleGroup>
				{!open && (
					<Button variant="primary" size="sm" onClick={() => setOpen(true)}>
						{where === "inbox" ? <PenLine strokeWidth={1.75} /> : <Send strokeWidth={1.75} />}
						{where === "inbox" ? "Write" : "Reply"}
					</Button>
				)}
			</div>
			<div className="overflow-hidden rounded-xl border border-line">
				<AppShell
					className="h-200"
					logo={<span className="logo" />}
					header={null}
					sidebar={
						<Sidebar.Root>
							<Sidebar.Section>
								<Sidebar.Item
									icon={<PenLine strokeWidth={1.75} />}
									label="Write"
									onSelect={() => pick("inbox", which)}
								/>
								<Sidebar.Item icon={<Inbox strokeWidth={1.75} />} label="Inbox" active />
								<Sidebar.Item icon={<Star strokeWidth={1.75} />} label="Starred" />
								<Sidebar.Item icon={<Send strokeWidth={1.75} />} label="Sent" />
							</Sidebar.Section>
						</Sidebar.Root>
					}
				>
					<div className="relative h-full">{content}</div>
				</AppShell>
			</div>
		</div>
	);
}
