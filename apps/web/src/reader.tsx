// SPDX-License-Identifier: AGPL-3.0-only
import {
	AttachmentList,
	AttachmentTile,
	Button,
	MailFrame,
	Spinner,
	Thread,
	ThreadMessage,
	Tooltip,
	useShortcut,
} from "@nouvex/ui";
import { Archive, ChevronLeft, Mail, Star, StarFilled, Trash2 } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import type { Message } from "./db";
import type { Draft } from "./write";

/** A conversation, oldest message first. The actions on top apply to all of it. */
export function Reader({
	messages,
	onClose,
	onTrash,
	onArchive,
	onWrite,
	onMarkUnread,
	starred,
	onStar,
}: {
	messages: Message[];
	starred: boolean;
	onStar: () => void;
	onClose: () => void;
	onTrash: () => void;
	onArchive?: () => void;
	onWrite: (draft: Draft) => void;
	onMarkUnread: () => void;
}) {
	useShortcut("Escape", onClose);
	const first = messages[0];
	if (!first) return null;

	return (
		<div className="grid content-start gap-3 p-4">
			<div className="flex items-center justify-between">
				<Button variant="ghost" size="sm" onClick={onClose}>
					<ChevronLeft strokeWidth={1.75} />
					Inbox
				</Button>
				<div className="flex gap-1">
					<Tooltip content={starred ? "Unstar" : "Star"}>
						<Button variant="ghost" size="icon" aria-label={starred ? "Unstar" : "Star"} onClick={onStar}>
							{starred ? <StarFilled /> : <Star strokeWidth={1.75} />}
						</Button>
					</Tooltip>
					<Tooltip content="Mark unread">
						<Button variant="ghost" size="icon" aria-label="Mark unread" onClick={onMarkUnread}>
							<Mail strokeWidth={1.75} />
						</Button>
					</Tooltip>
					{onArchive && (
						<Tooltip content="Archive">
							<Button variant="ghost" size="icon" aria-label="Archive" onClick={onArchive}>
								<Archive strokeWidth={1.75} />
							</Button>
						</Tooltip>
					)}
					<Tooltip content="Delete">
						<Button variant="ghost" size="icon" aria-label="Delete" onClick={onTrash}>
							<Trash2 strokeWidth={1.75} />
						</Button>
					</Tooltip>
				</div>
			</div>
			<Thread subject={first.subject}>
				{messages.map((m) => (
					<Entry key={m.id} message={m} onWrite={onWrite} />
				))}
			</Thread>
		</div>
	);
}

export async function body(m: Message) {
	const res = await fetch(`/accounts/${m.accountId}/messages/${m.id}/body`);
	if (!res.ok) throw new Error(`body: ${res.status}`);
	return ((await res.json()) as { html: string }).html;
}

// One message of the conversation; its body loads when it is first shown.
function Entry({
	message: m,
	onWrite,
	defaultExpanded,
}: {
	message: Message;
	onWrite: (draft: Draft) => void;
	defaultExpanded?: boolean;
}) {
	const html = useQuery({ queryKey: ["body", m.id], queryFn: () => body(m), staleTime: Number.POSITIVE_INFINITY });
	const quoted = html.data === undefined ? undefined : text(html.data);

	return (
		<ThreadMessage
			from={m.fromName || m.fromAddr}
			email={m.fromAddr}
			date={new Date(m.sentAt)}
			snippet={m.snippet}
			defaultExpanded={defaultExpanded ?? m.seen === 0}
			onReply={quoted === undefined ? undefined : () => onWrite(reply(m, quoted))}
			onForward={quoted === undefined ? undefined : () => onWrite(forward(m, quoted))}
		>
			{html.data !== undefined ? (
				<>
					<MailFrame html={html.data} />
					{m.attachments.length > 0 && (
						<AttachmentList className="mt-3">
							{m.attachments.map((a, i) => (
								<AttachmentTile
									// biome-ignore lint/suspicious/noArrayIndexKey: attachments are addressed by position, the API too
									key={i}
									{...a}
									onOpen={() => location.assign(`/accounts/${m.accountId}/messages/${m.id}/attachments/${i}`)}
								/>
							))}
						</AttachmentList>
					)}
				</>
			) : html.isError ? (
				<p className="p-4 text-sm text-muted">This message couldn't be loaded.</p>
			) : (
				<Spinner />
			)}
		</ThreadMessage>
	);
}

// The mail as plain text for quoting. Block breaks of HTML mails get lost; plain text mails keep their lines.
export const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";

const prefixed = (prefix: string, subject: string) =>
	subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;

const sender = (m: Message) => (m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr);

const reply = (m: Message, body: string): Draft => ({
	accountId: m.accountId,
	to: [m.fromAddr],
	subject: prefixed("Re:", m.subject),
	body: `\n\nOn ${new Date(m.sentAt).toLocaleString()}, ${sender(m)} wrote:\n${body.replace(/^/gm, "> ")}`,
	inReplyTo: m.id,
});

const forward = (m: Message, body: string): Draft => ({
	accountId: m.accountId,
	subject: prefixed("Fwd:", m.subject),
	body: `\n\n---------- Forwarded message ----------\nFrom: ${sender(m)}\nDate: ${new Date(m.sentAt).toLocaleString()}\nSubject: ${m.subject}\n\n${body}`,
});
