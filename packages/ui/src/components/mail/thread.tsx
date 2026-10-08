// SPDX-License-Identifier: Apache-2.0
import { Forward, Reply } from "lucide-react";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useId, useState } from "react";
import { cn } from "../../lib";
import { formatMailDate, formatMailDateLong } from "../../mail-date";
import { Avatar } from "../avatar";
import { Button } from "../button";
import { Tooltip } from "../tooltip";

// Opens by growing a grid row and fading the body in from under the snippet; see thread-panel in styles.css.
function Panel({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
	return (
		<section id={id} data-open={open || undefined} inert={!open} className="thread-panel">
			<div>
				<div className="thread-body">{children}</div>
			</div>
		</section>
	);
}

export type ThreadMessageProps = {
	from: string;
	email?: string;
	to?: string[];
	date: Date;
	snippet: string;
	children: ReactNode;
	expanded?: boolean;
	defaultExpanded?: boolean;
	onReply?(): void;
	onForward?(): void;
};

/**
 * One message of a conversation. Collapsed it's a single row with the snippet; opened, the snippet crossfades into
 * the sender's address and recipients and the body unfolds below.
 */
export function ThreadMessage({
	from,
	email,
	to,
	date,
	snippet,
	children,
	expanded,
	defaultExpanded = false,
	onReply,
	onForward,
}: ThreadMessageProps) {
	const [own, setOwn] = useState(defaultExpanded);
	const open = expanded ?? own;
	// The body mounts invisibly as soon as the pointer or focus arrives, so a mail frame has measured itself
	// by the time the row is clicked and the message opens in one smooth motion.
	const [ready, setReady] = useState(open);
	const panelId = useId();

	return (
		<div data-open={open || undefined} className="group border-b border-line last:border-b-0">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onPointerEnter={() => setReady(true)}
				onFocus={() => setReady(true)}
				onClick={() => {
					setReady(true);
					setOwn(!open);
				}}
				className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2"
			>
				<Avatar name={from} />
				<span className="grid min-w-0 flex-1">
					<span className="truncate font-medium">{from}</span>
					{/* Same line, two texts: the snippet when closed, address and recipients when open. */}
					<span className="grid text-sm text-muted">
						<span className="col-start-1 row-start-1 truncate transition-opacity duration-200 group-data-open:opacity-0">
							{snippet}
						</span>
						<span className="col-start-1 row-start-1 truncate opacity-0 transition-opacity duration-200 group-data-open:opacity-100">
							{[email, to?.length ? `to ${to.join(", ")}` : ""].filter(Boolean).join(" · ")}
						</span>
					</span>
				</span>
				<Tooltip content={formatMailDateLong(date)}>
					<span className="shrink-0 self-start pt-0.5 text-xs text-muted tabular-nums">{formatMailDate(date)}</span>
				</Tooltip>
			</button>
			<Panel open={open} id={panelId}>
				{ready && (
					<div className="grid gap-3 pr-4 pb-4 pl-15">
						{children}
						{(onReply || onForward) && (
							<div className="flex gap-2">
								{onReply && (
									<Button size="sm" onClick={onReply}>
										<Reply strokeWidth={1.75} />
										Reply
									</Button>
								)}
								{onForward && (
									<Button size="sm" onClick={onForward}>
										<Forward strokeWidth={1.75} />
										Forward
									</Button>
								)}
							</div>
						)}
					</div>
				)}
			</Panel>
		</div>
	);
}

/**
 * A conversation: the newest message starts open; with more than four, the ones in the middle fold into a single
 * row that unfolds them in place.
 */
export function Thread({ subject, children, className }: { subject: string; children: ReactNode; className?: string }) {
	const [showAll, setShowAll] = useState(false);
	const messages = Children.toArray(children).filter(isValidElement) as ReactElement<ThreadMessageProps>[];
	const last = messages.length - 1;
	const items = messages.map((m, i) =>
		i === last && m.props.defaultExpanded === undefined ? cloneElement(m, { defaultExpanded: true }) : m,
	);
	const fold = items.length > 4;
	const middle = fold ? items.slice(1, -2) : [];

	return (
		<section className={cn("grid", className)}>
			<h2 className="px-4 pb-3 text-xl font-semibold text-balance">{subject}</h2>
			<div className="overflow-hidden rounded-lg border border-line">
				{fold ? (
					<>
						{items[0]}
						{!showAll && (
							<button
								type="button"
								onClick={() => setShowAll(true)}
								className="flex w-full items-center gap-3 border-b border-line px-4 py-2 text-left text-sm text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2"
							>
								<span className="h-px w-6 bg-line-strong" />
								{middle.length} earlier {middle.length === 1 ? "message" : "messages"}
							</button>
						)}
						<Panel open={showAll}>
							<div className="border-b border-line">{middle}</div>
						</Panel>
						{items.slice(-2)}
					</>
				) : (
					items
				)}
			</div>
		</section>
	);
}
