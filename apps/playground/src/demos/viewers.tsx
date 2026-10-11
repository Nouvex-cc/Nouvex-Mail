// SPDX-License-Identifier: AGPL-3.0-only
import {
	AppShell,
	AttachmentList,
	AttachmentTile,
	Avatar,
	Button,
	formatMailDate,
	formatMailDateLong,
	Input,
	Kbd,
	MailFrame,
	Sidebar,
	Toggle,
	ToggleGroup,
	Tooltip,
} from "@nouvex/ui";
import { Archive, ChevronLeft, Clock, Forward, Inbox, MailOpen, Reply, Send, Star, Trash2 } from "@nouvex/ui/icons";
import { type ReactNode, useState } from "react";

// Five takes on the open conversation, side by side in the same frame, to pick one for the app.

const day = (offset: number, h: number, m = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	d.setHours(h, m, 0, 0);
	return d;
};

const preview = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c9b49e"/></svg>')}`;

type File = { name: string; size: number; previewUrl?: string };
type Msg = {
	from: string;
	email: string;
	to: string[];
	date: Date;
	snippet: string;
	text?: string[];
	html?: string;
	files?: File[];
	me?: boolean;
};

const conversation: { subject: string; messages: Msg[] } = {
	subject: "Keys for the new flat",
	messages: [
		{
			from: "Mateo Coerdts",
			email: "mateo@nouvex.example",
			to: ["Lena Hartmann"],
			date: day(-3, 9, 12),
			snippet: "Hi Lena, when can I pick up the keys?",
			text: ["Hi Lena,", "when can I pick up the keys? Any day this week works, ideally after work."],
			me: true,
		},
		{
			from: "Lena Hartmann",
			email: "lena@hartmann.example",
			to: ["Mateo Coerdts"],
			date: day(-3, 11, 40),
			snippet: "Thursday evening would work for me.",
			text: ["Thursday evening would work for me. I can be there from 18:00."],
		},
		{
			from: "Mateo Coerdts",
			email: "mateo@nouvex.example",
			to: ["Lena Hartmann"],
			date: day(-2, 18, 4),
			snippet: "Could we move the handover to Friday?",
			text: ["Could we move the handover to Friday? Thursday doesn't work for me after all, sorry."],
			me: true,
		},
		{
			from: "Lena Hartmann",
			email: "lena@hartmann.example",
			to: ["Mateo Coerdts", "Jonas Weber"],
			date: day(0, 9, 42),
			snippet: "Friday is fine. Here's the signed protocol and a photo of the meters.",
			text: [
				"Hi Mateo,",
				"Friday is fine, see you at 18:00. I've attached the signed handover protocol and a photo of the meter readings, so we don't have to do that on the day.",
				"Jonas from the building management will join us for the heating.",
				"Best,\nLena",
			],
			files: [
				{ name: "Handover-protocol-signed.pdf", size: 284_000 },
				{ name: "meters.jpg", size: 1_840_000, previewUrl: preview },
			],
		},
	],
};

const newsletterHtml = `<table width="600" cellpadding="0" cellspacing="0" style="font-family:Helvetica,Arial,sans-serif;color:#2b2b2b">
<tr><td style="background:#efe6ff;padding:48px 56px">
	<p style="margin:0 0 24px;font-size:13px;letter-spacing:.04em">VIVID BUSINESS</p>
	<h1 style="margin:0 0 12px;font-size:32px">Just a few steps left</h1>
	<p style="margin:0 0 28px;font-size:16px;line-height:1.5">Issue a business card, spend at least €50 before 25 October and collect your reward.</p>
	<a href="https://vivid.example" style="display:inline-block;background:#7c3aed;color:#fff;padding:14px 28px;border-radius:14px;text-decoration:none;font-weight:600">Complete the steps</a>
</td></tr>
<tr><td style="height:16px"></td></tr>
<tr><td style="background:#ffffff;padding:40px 56px;border:1px solid #eee">
	<h2 style="margin:0 0 12px;font-size:24px">Hello!</h2>
	<p style="margin:0 0 12px;font-size:15px;line-height:1.6">A special reward waits for you and your inviter if you meet the conditions before 25 October.</p>
	<ol style="font-size:15px;line-height:1.6;padding-left:20px"><li>Issue a virtual or physical card.</li><li>Spend €50 within 30 days.</li></ol>
</td></tr>
</table>`;

const newsletter: { subject: string; messages: Msg[] } = {
	subject: "15 days left to get €150",
	messages: [
		{
			from: "Vivid Money",
			email: "service@email.vivid.example",
			to: ["Mateo Coerdts"],
			date: day(0, 7, 15),
			snippet: "Just a few steps left",
			html: newsletterHtml,
		},
	],
};

const last = <T,>(list: T[]) => list[list.length - 1] as T;
const people = (messages: Msg[]) => [...new Map(messages.map((m) => [m.email, m])).values()];

function Body({ m, large }: { m: Msg; large?: boolean }) {
	if (m.html) return <MailFrame html={m.html} />;
	return (
		<div className={large ? "grid gap-4 text-lg leading-relaxed" : "grid gap-3"}>
			{m.text?.map((p) => (
				<p key={p} className="whitespace-pre-line">
					{p}
				</p>
			))}
		</div>
	);
}

function Files({ files }: { files?: File[] }) {
	if (!files?.length) return null;
	return (
		<AttachmentList>
			{files.map((f) => (
				<AttachmentTile key={f.name} {...f} onOpen={() => {}} />
			))}
		</AttachmentList>
	);
}

function When({ date }: { date: Date }) {
	return (
		<Tooltip content={formatMailDateLong(date)}>
			<span className="shrink-0 text-xs text-muted">{formatMailDate(date)}</span>
		</Tooltip>
	);
}

function IconAction({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Tooltip content={label}>
			<Button variant="ghost" size="icon" aria-label={label}>
				{children}
			</Button>
		</Tooltip>
	);
}

function Actions() {
	return (
		<div className="flex items-center">
			<IconAction label="Star">
				<Star strokeWidth={1.75} />
			</IconAction>
			<IconAction label="Mark as unread">
				<MailOpen strokeWidth={1.75} />
			</IconAction>
			<IconAction label="Snooze">
				<Clock strokeWidth={1.75} />
			</IconAction>
			<IconAction label="Archive">
				<Archive strokeWidth={1.75} />
			</IconAction>
			<IconAction label="Delete">
				<Trash2 strokeWidth={1.75} />
			</IconAction>
		</div>
	);
}

function Back() {
	return (
		<Button variant="ghost" size="sm">
			<ChevronLeft strokeWidth={1.75} />
			Inbox
		</Button>
	);
}

// A collapsed message: one line, opens on click.
function Folded({ m, onOpen }: { m: Msg; onOpen(): void }) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2"
		>
			<Avatar name={m.from} size="sm" />
			<span className="w-32 shrink-0 truncate font-medium">{m.from}</span>
			<span className="min-w-0 flex-1 truncate text-sm text-muted">{m.snippet}</span>
			<When date={m.date} />
		</button>
	);
}

const useOpen = (messages: Msg[]) => {
	const [open, setOpen] = useState(() => new Set([messages.length - 1]));
	return [open, (i: number) => setOpen((o) => new Set(o).add(i))] as const;
};

/** 1. Letter: one calm column like a printed page, no boxes, a reply field waiting at the end. */
function Letter({ subject, messages }: { subject: string; messages: Msg[] }) {
	const [open, show] = useOpen(messages);
	return (
		<div className="min-h-full">
			<div className="sticky top-0 z-10 flex items-center justify-between bg-paper px-4 py-2">
				<Back />
				<Actions />
			</div>
			<article className="mx-auto grid max-w-2xl gap-6 px-6 pt-6 pb-16">
				<h1 className="text-2xl font-semibold text-balance">{subject}</h1>
				<div className="grid">
					{messages.map((m, i) =>
						open.has(i) ? (
							<section key={m.date.getTime()} className="grid gap-5 border-t border-line py-6 first:border-t-0">
								<header className="flex items-start gap-3">
									<Avatar name={m.from} />
									<div className="grid min-w-0 flex-1">
										<span className="font-medium">{m.from}</span>
										<span className="truncate text-sm text-muted">to {m.to.join(", ")}</span>
									</div>
									<When date={m.date} />
								</header>
								<Body m={m} large />
								<Files files={m.files} />
							</section>
						) : (
							<div key={m.date.getTime()} className="-mx-3 border-t border-line py-1 first:border-t-0">
								<Folded m={m} onOpen={() => show(i)} />
							</div>
						),
					)}
				</div>
				<button
					type="button"
					className="flex items-center gap-3 rounded-lg border border-line-strong px-4 py-3 text-left text-muted outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2"
				>
					<Reply strokeWidth={1.75} />
					<span className="flex-1">Reply to {last(messages).from}…</span>
					<Kbd>R</Kbd>
				</button>
			</article>
		</div>
	);
}

// The denser takes share these: one bar for back, subject and actions, a one-line message header, and earlier
// messages folded into a single row until asked for.

function Bar({ subject, className }: { subject: string; className?: string }) {
	return (
		<div
			className={`sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-line px-2 ${className ?? "bg-paper"}`}
		>
			<Back />
			<h1 className="min-w-0 flex-1 truncate font-semibold">{subject}</h1>
			<Actions />
		</div>
	);
}

function Line({ m }: { m: Msg }) {
	return (
		<header className="flex min-w-0 items-center gap-2">
			<Avatar name={m.from} size="sm" />
			<span className="shrink-0 font-medium">{m.from}</span>
			<span className="min-w-0 flex-1 truncate text-sm text-muted">
				{m.email} to {m.to.join(", ")}
			</span>
			<When date={m.date} />
		</header>
	);
}

// Everything before the newest message as one row; opened, each is a one-line row that expands on click.
function Earlier({ messages, render }: { messages: Msg[]; render(m: Msg, i: number): ReactNode }) {
	const [all, setAll] = useState(false);
	const earlier = messages.slice(0, -1);
	if (earlier.length === 0) return null;
	if (all) return <>{earlier.map(render)}</>;
	return (
		<button
			type="button"
			onClick={() => setAll(true)}
			className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-ink focus-visible:outline-2"
		>
			<span className="flex gap-1">
				{people(earlier).map((m) => (
					<Avatar key={m.email} name={m.from} size="sm" />
				))}
			</span>
			{earlier.length} earlier {earlier.length === 1 ? "message" : "messages"}
		</button>
	);
}

function Expandable({ m, className = "border-b border-line" }: { m: Msg; className?: string }) {
	const [open, setOpen] = useState(false);
	return open ? (
		<section className={`grid gap-3 px-3 py-4 ${className}`}>
			<Line m={m} />
			<Body m={m} />
		</section>
	) : (
		<div className={className}>
			<Folded m={m} onOpen={() => setOpen(true)} />
		</div>
	);
}

function ReplyButtons() {
	return (
		<div className="flex items-center gap-2">
			<Button size="sm">
				<Reply strokeWidth={1.75} />
				Reply
			</Button>
			<Button size="sm">Reply all</Button>
			<Button size="sm">
				<Forward strokeWidth={1.75} />
				Forward
			</Button>
		</div>
	);
}

/** 2. Wide: Letter without the narrow column. The newest mail starts right under the bar and gets the full width. */
function Wide({ subject, messages }: { subject: string; messages: Msg[] }) {
	const m = last(messages);
	return (
		<div className="min-h-full">
			<Bar subject={subject} />
			<div className="px-3 py-2">
				<Earlier messages={messages} render={(e) => <Expandable key={e.date.getTime()} m={e} />} />
				<section className="grid gap-4 px-3 pt-3 pb-6">
					<Line m={m} />
					<div className="max-w-4xl">
						<Body m={m} large />
					</div>
					<Files files={m.files} />
					<ReplyButtons />
				</section>
			</div>
		</div>
	);
}

/** 3. Sheet: Cards tightened up. One sheet edge to edge, a thin sunken margin, the replies inside it. */
function Sheet({ subject, messages }: { subject: string; messages: Msg[] }) {
	const m = last(messages);
	return (
		<div className="min-h-full bg-sunken">
			<Bar subject={subject} className="bg-sunken" />
			<div className="grid gap-2 p-2">
				<Earlier
					messages={messages}
					render={(e) => (
						<Expandable key={e.date.getTime()} m={e} className="rounded-lg border border-line bg-paper p-1" />
					)}
				/>
				<section className="grid gap-4 rounded-lg border border-line bg-paper p-4">
					<Line m={m} />
					<div className="max-w-4xl">
						<Body m={m} large />
					</div>
					<Files files={m.files} />
					<div className="border-t border-line pt-3">
						<ReplyButtons />
					</div>
				</section>
			</div>
		</div>
	);
}

/** 6. Focus: the newest mail fills the panel, HTML edge to edge, and a one-line reply field is docked below. */
function Focus({ subject, messages }: { subject: string; messages: Msg[] }) {
	const m = last(messages);
	return (
		<div className="flex h-full flex-col">
			<Bar subject={subject} />
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="px-3 pt-2">
					<Earlier messages={messages} render={(e) => <Expandable key={e.date.getTime()} m={e} />} />
				</div>
				<section className="grid gap-4 py-3">
					<div className="px-6">
						<Line m={m} />
					</div>
					<div className={m.html ? "" : "max-w-4xl px-6"}>
						<Body m={m} large />
					</div>
					<div className="px-6">
						<Files files={m.files} />
					</div>
				</section>
			</div>
			<div className="flex items-center gap-2 border-t border-line p-2">
				<Input placeholder={`Reply to ${m.from}`} className="flex-1" />
				<Button size="sm">
					<Forward strokeWidth={1.75} />
					Forward
				</Button>
			</div>
		</div>
	);
}

/** 4. Cards: each message is its own sheet on the sunken surface; actions float in a pill at the bottom. */
function Cards({ subject, messages }: { subject: string; messages: Msg[] }) {
	const [open, show] = useOpen(messages);
	return (
		<div className="relative min-h-full bg-sunken">
			<div className="sticky top-0 z-10 flex items-center justify-between bg-sunken px-4 py-2">
				<Back />
				<Actions />
			</div>
			<div className="mx-auto grid max-w-3xl gap-3 px-6 pt-2 pb-28">
				<h1 className="px-1 pb-2 text-xl font-semibold text-balance">{subject}</h1>
				{messages.map((m, i) =>
					open.has(i) ? (
						<section key={m.date.getTime()} className="grid gap-5 rounded-xl border border-line bg-paper p-6">
							<header className="flex items-center gap-3">
								<Avatar name={m.from} />
								<div className="grid min-w-0 flex-1">
									<span className="font-medium">{m.from}</span>
									<span className="truncate text-sm text-muted">to {m.to.join(", ")}</span>
								</div>
								<When date={m.date} />
							</header>
							<Body m={m} large />
							<Files files={m.files} />
						</section>
					) : (
						<div key={m.date.getTime()} className="rounded-xl border border-line bg-paper p-1">
							<Folded m={m} onOpen={() => show(i)} />
						</div>
					),
				)}
			</div>
			<div className="pointer-events-none sticky bottom-6 z-10 flex justify-center">
				<div className="pointer-events-auto flex items-center gap-1 rounded-xl bg-raised p-1.5 shadow-pop">
					<Button variant="primary" size="sm">
						<Reply strokeWidth={1.75} />
						Reply
					</Button>
					<Button variant="ghost" size="sm">
						Reply all
					</Button>
					<Button variant="ghost" size="sm">
						<Forward strokeWidth={1.75} />
						Forward
					</Button>
				</div>
			</div>
		</div>
	);
}

/** 5. Conversation: short mails read like a chat, yours on the right, and the reply box is always there. */
function Conversation({ subject, messages }: { subject: string; messages: Msg[] }) {
	const others = people(messages).filter((m) => !m.me);
	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 border-b border-line px-4 py-2">
				<Back />
				<div className="flex -space-x-2">
					{others.map((m) => (
						<span key={m.email} className="rounded-full ring-2 ring-paper">
							<Avatar name={m.from} size="sm" />
						</span>
					))}
				</div>
				<div className="grid min-w-0 flex-1">
					<h1 className="truncate font-semibold">{subject}</h1>
					<span className="truncate text-xs text-muted">{others.map((m) => m.from).join(", ")}</span>
				</div>
				<Actions />
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="mx-auto grid max-w-3xl gap-6 px-6 py-8">
					{messages.map((m) =>
						m.html ? (
							<section key={m.date.getTime()} className="grid gap-3">
								<div className="flex items-center gap-2 text-sm">
									<Avatar name={m.from} size="sm" />
									<span className="font-medium">{m.from}</span>
									<When date={m.date} />
								</div>
								<div className="overflow-hidden rounded-xl border border-line">
									<Body m={m} />
								</div>
							</section>
						) : (
							<section
								key={m.date.getTime()}
								className={m.me ? "grid justify-items-end gap-1.5 pl-16" : "grid justify-items-start gap-1.5 pr-16"}
							>
								<div className="flex items-center gap-2 px-1 text-xs text-muted">
									{!m.me && <span className="font-medium text-ink">{m.from}</span>}
									<When date={m.date} />
								</div>
								<div
									className={
										m.me
											? "rounded-xl rounded-br-sm bg-ink px-4 py-3 text-on-ink"
											: "rounded-xl rounded-bl-sm bg-sunken px-4 py-3"
									}
								>
									<Body m={m} />
								</div>
								<Files files={m.files} />
							</section>
						),
					)}
				</div>
			</div>
			<div className="border-t border-line p-3">
				<div className="mx-auto flex max-w-3xl items-center gap-2">
					<Input placeholder={`Reply to ${last(messages).from}`} className="flex-1" />
					<Tooltip content="Send">
						<Button variant="primary" size="icon" aria-label="Send">
							<Send strokeWidth={1.75} />
						</Button>
					</Tooltip>
				</div>
			</div>
		</div>
	);
}

/** 7. Mix: Letter's mail and reply field, in Cards' floating bar, under the slim bar of the denser takes. */
function Mix({ subject, messages }: { subject: string; messages: Msg[] }) {
	const m = last(messages);
	return (
		<div className="flex min-h-full flex-col">
			<Bar subject={subject} />
			<div className="flex-1 px-3 pt-2 pb-24">
				<Earlier messages={messages} render={(e) => <Expandable key={e.date.getTime()} m={e} />} />
				<section className="grid gap-5 px-3 pt-4">
					<header className="flex items-start gap-3">
						<Avatar name={m.from} />
						<div className="grid min-w-0 flex-1">
							<span className="font-medium">{m.from}</span>
							<span className="truncate text-sm text-muted">to {m.to.join(", ")}</span>
						</div>
						<When date={m.date} />
					</header>
					<div className={m.html ? "" : "max-w-4xl"}>
						<Body m={m} large />
					</div>
					<Files files={m.files} />
				</section>
			</div>
			<div className="pointer-events-none sticky bottom-4 z-10 flex justify-center px-4">
				<div className="pointer-events-auto flex w-full max-w-2xl items-center gap-1 rounded-xl border border-line bg-raised p-1.5 shadow-pop">
					<button
						type="button"
						className="flex h-8 min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-left text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-ink focus-visible:outline-2"
					>
						<Reply strokeWidth={1.75} />
						<span className="flex-1 truncate">Reply to {m.from}…</span>
						<Kbd>R</Kbd>
					</button>
					<Button variant="ghost" size="sm">
						Reply all
					</Button>
					<Button variant="ghost" size="sm">
						<Forward strokeWidth={1.75} />
						Forward
					</Button>
				</div>
			</div>
		</div>
	);
}

const viewers = [
	["Letter", Letter],
	["Wide", Wide],
	["Sheet", Sheet],
	["Cards", Cards],
	["Conversation", Conversation],
	["Focus", Focus],
	["Mix", Mix],
] as const;

export function ViewersDemo() {
	const [viewer, setViewer] = useState<string>("Mix");
	const [content, setContent] = useState("conversation");
	const View = viewers.find(([name]) => name === viewer)?.[1] ?? Letter;
	const mail = content === "newsletter" ? newsletter : conversation;
	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<ToggleGroup value={[viewer]} onValueChange={(v) => v[0] && setViewer(v[0])}>
					{viewers.map(([name], i) => (
						<Toggle key={name} value={name}>
							{i + 1}. {name}
						</Toggle>
					))}
				</ToggleGroup>
				<ToggleGroup value={[content]} onValueChange={(v) => v[0] && setContent(v[0])}>
					<Toggle value="conversation">Conversation</Toggle>
					<Toggle value="newsletter">Newsletter</Toggle>
				</ToggleGroup>
			</div>
			<div className="overflow-hidden rounded-xl border border-line">
				<AppShell
					className="h-200"
					logo={<span className="logo" />}
					header={null}
					sidebar={
						<Sidebar.Root>
							<Sidebar.Section>
								<Sidebar.Item icon={<Inbox strokeWidth={1.75} />} label="Inbox" active />
								<Sidebar.Item icon={<Star strokeWidth={1.75} />} label="Starred" />
								<Sidebar.Item icon={<Send strokeWidth={1.75} />} label="Sent" />
							</Sidebar.Section>
						</Sidebar.Root>
					}
				>
					<View key={`${viewer}-${content}`} {...mail} />
				</AppShell>
			</div>
		</div>
	);
}
