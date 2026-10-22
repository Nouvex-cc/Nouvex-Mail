// SPDX-License-Identifier: Apache-2.0

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useId, useState } from "react";
import { Forward, Reply } from "../../icons";
import { cn } from "../../lib";
import { formatMailDate, formatMailDateLong } from "../../mail-date";
import { Avatar } from "../avatar";
import { Button } from "../button";
import { Kbd } from "../kbd";
import { TextMorph } from "../text-morph";
import { Tooltip } from "../tooltip";
import { FrameSlot } from "./mail-frame";
import { useShortcut } from "./shortcuts";

// Opens by growing a grid row and fading the body in from under the snippet; see fold-panel in styles.css.
function Panel({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
	return (
		<section id={id} data-open={open || undefined} inert={!open} className="fold-panel">
			<div>
				<div className="thread-body">{children}</div>
			</div>
		</section>
	);
}

// While hovered the name morphs into the address, and a click copies it instead of opening or closing the message.
function SenderName({ name, email }: { name: string; email?: string }) {
	const [hover, setHover] = useState(false);
	const [copied, setCopied] = useState(false);
	if (!email) return <span className="justify-self-start truncate font-medium">{name}</span>;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut inside the message's toggle button, and buttons can't nest
		// biome-ignore lint/a11y/useKeyWithClickEvents: see above
		<span
			className="justify-self-start font-medium"
			onPointerEnter={() => setHover(true)}
			onPointerLeave={() => setHover(false)}
			onClick={(e) => {
				e.stopPropagation();
				void navigator.clipboard.writeText(email).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			<TextMorph>{copied ? "Copied" : hover ? email : name}</TextMorph>
		</span>
	);
}

export type ThreadMessageProps = {
	from: string;
	email?: string;
	to?: string[];
	date: Date;
	snippet: string;
	children: ReactNode;
	defaultExpanded?: boolean;
};

/**
 * One message of a conversation. Collapsed it's a single row with the snippet; opened, the snippet crossfades into
 * the recipients and the body unfolds below.
 */
export function ThreadMessage({
	from,
	email,
	to,
	date,
	snippet,
	children,
	defaultExpanded = false,
}: ThreadMessageProps) {
	const [open, setOpen] = useState(defaultExpanded);
	// The body mounts invisibly as soon as the pointer or focus arrives, so a mail frame has measured itself
	// by the time the row is clicked and the message opens in one smooth motion.
	const [ready, setReady] = useState(open);
	const panelId = useId();
	// Where the mail frame puts its status pills, next to the date.
	const [pills, setPills] = useState<HTMLElement | null>(null);

	return (
		<div data-open={open || undefined} className="group border-b border-line last:border-b-0">
			<div className="flex items-start">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={panelId}
					onPointerEnter={() => setReady(true)}
					onFocus={() => setReady(true)}
					onClick={() => {
						setReady(true);
						setOpen(!open);
					}}
					className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-3 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2"
				>
					<Avatar name={from} />
					<span className="grid min-w-0 flex-1">
						<SenderName name={from} email={email} />
						{/* Same line, two texts: the snippet when closed, the recipients when open. */}
						<span className="grid text-sm text-muted">
							<span className="col-start-1 row-start-1 truncate transition-opacity duration-200 group-data-open:opacity-0">
								{snippet}
							</span>
							<span className="col-start-1 row-start-1 truncate opacity-0 transition-opacity duration-200 group-data-open:opacity-100">
								{to?.length ? `to ${to.join(", ")}` : email}
							</span>
						</span>
					</span>
					<Tooltip content={formatMailDateLong(date)}>
						<span className="shrink-0 self-start pt-0.5 text-xs text-muted">{formatMailDate(date)}</span>
					</Tooltip>
				</button>
				<div ref={setPills} className="flex gap-1.5 py-3 empty:hidden" />
			</div>
			<Panel open={open} id={panelId}>
				{ready && (
					<FrameSlot.Provider value={pills}>
						<div className="grid gap-4 px-3 pt-1 pb-6">{children}</div>
					</FrameSlot.Provider>
				)}
			</Panel>
		</div>
	);
}

export type ThreadReply = {
	/** Who a reply goes to, for the field's placeholder (everyone with allFirst). */
	to: string;
	/** A reply to this conversation is saved as a draft: the field continues it. */
	drafted?: boolean;
	onReply(): void;
	onReplyAll?(): void;
	onForward(): void;
	/** R and the bar reply to everyone, when there's more than one other person; the button then replies to the sender. */
	allFirst?: boolean;
};

// Floats at the bottom of the conversation while the mail scrolls under it.
function Floating({ children }: { children: ReactNode }) {
	return (
		<div className="pointer-events-none sticky bottom-4 z-10 flex justify-center px-4">
			<div className="pointer-events-auto w-full max-w-2xl">{children}</div>
		</div>
	);
}

// R, A and F do the same from anywhere in the conversation.
function ReplyBar({ to, drafted, onReply, onReplyAll, onForward, allFirst }: ThreadReply) {
	const all = allFirst && onReplyAll && !drafted;
	const main = all ? onReplyAll : onReply;
	useShortcut("r", main);
	useShortcut("a", () => onReplyAll?.());
	useShortcut("f", onForward);
	return (
		<Floating>
			<div className="flex items-center gap-1 rounded-xl border border-line bg-raised p-1.5 shadow-pop">
				<button
					type="button"
					onClick={main}
					className="flex h-8 min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-left text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-ink focus-visible:outline-2 [&_svg]:size-4 [&_svg]:shrink-0"
				>
					<Reply strokeWidth={1.75} />
					<span className="flex-1 truncate">
						{drafted ? "Continue your reply to" : all ? "Reply all to" : "Reply to"} {to}…
					</span>
					<Kbd>R</Kbd>
				</button>
				{onReplyAll && (
					<Button variant="ghost" size="sm" onClick={all ? onReply : onReplyAll}>
						{all ? "Reply" : "Reply all"}
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={onForward}>
					<Forward strokeWidth={1.75} />
					Forward
				</Button>
			</div>
		</Floating>
	);
}

/**
 * A conversation under one bar with the subject. The newest message starts open; the ones before it fold into a
 * single row unless one of them starts open itself. Replies go out from a bar floating at the bottom.
 */
export function Thread({
	subject,
	back,
	actions,
	reply,
	composer,
	children,
	className,
}: {
	subject: string;
	/** Left of the subject, e.g. a button back to the list. */
	back?: ReactNode;
	/** Right of the subject, for the whole conversation. */
	actions?: ReactNode;
	reply?: ThreadReply;
	/** Takes the reply bar's place, e.g. the reply being written. */
	composer?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	const [showAll, setShowAll] = useState(false);
	const messages = Children.toArray(children).filter(isValidElement) as ReactElement<ThreadMessageProps>[];
	const earlier = messages.slice(0, -1);
	const newest = messages.at(-1);
	const fold = earlier.length > 1 && !earlier.some((m) => m.props.defaultExpanded);
	const senders = [...new Set(earlier.map((m) => m.props.from))];

	return (
		<section className={cn("flex min-h-full flex-col", className)}>
			<div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-paper px-2">
				{back}
				<h2 className="min-w-0 flex-1 truncate font-semibold">{subject}</h2>
				{actions}
			</div>
			<div className="flex-1 px-3 pt-2 pb-24">
				{fold && !showAll && (
					<button
						type="button"
						onClick={() => setShowAll(true)}
						className="flex w-full items-center gap-3 rounded-md border-b border-line px-3 py-2 text-left text-sm text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2"
					>
						<span className="flex gap-1">
							{senders.slice(0, 3).map((name) => (
								<Avatar key={name} name={name} size="sm" />
							))}
						</span>
						{earlier.length} earlier messages
					</button>
				)}
				{fold ? (
					<Panel open={showAll}>
						<div className="border-b border-line">{earlier}</div>
					</Panel>
				) : (
					earlier.length > 0 && <div className="border-b border-line">{earlier}</div>
				)}
				{newest && cloneElement(newest, { defaultExpanded: true })}
			</div>
			{composer ? <Floating>{composer}</Floating> : reply && <ReplyBar {...reply} />}
		</section>
	);
}
