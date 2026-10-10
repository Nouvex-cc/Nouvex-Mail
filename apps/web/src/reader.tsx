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
import { Archive, ChevronLeft, Mail, Trash2 } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import type { Message } from "./db";
import type { Draft } from "./write";

export function Reader({
	message: m,
	onClose,
	onTrash,
	onArchive,
	onWrite,
	onMarkUnread,
}: {
	message: Message;
	onClose: () => void;
	onTrash: () => void;
	onArchive?: () => void;
	onWrite: (draft: Draft) => void;
	onMarkUnread: () => void;
}) {
	useShortcut("Escape", onClose);
	const body = useQuery({
		queryKey: ["body", m.id],
		queryFn: async () => {
			const res = await fetch(`/accounts/${m.accountId}/messages/${m.id}/body`);
			if (!res.ok) throw new Error(`body: ${res.status}`);
			return ((await res.json()) as { html: string }).html;
		},
		staleTime: Number.POSITIVE_INFINITY,
	});

	return (
		<div className="grid content-start gap-3 p-4">
			<div className="flex items-center justify-between">
				<Button variant="ghost" size="sm" onClick={onClose}>
					<ChevronLeft strokeWidth={1.75} />
					Inbox
				</Button>
				<div className="flex gap-1">
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
			<Thread subject={m.subject}>
				<ThreadMessage
					from={m.fromName || m.fromAddr}
					email={m.fromAddr}
					date={new Date(m.sentAt)}
					snippet={m.snippet}
					onReply={body.data === undefined ? undefined : () => onWrite(reply(m, text(body.data)))}
					onForward={body.data === undefined ? undefined : () => onWrite(forward(m, text(body.data)))}
				>
					{body.data !== undefined ? (
						<>
							<MailFrame html={body.data} />
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
					) : body.isError ? (
						<p className="p-4 text-sm text-muted">This message couldn't be loaded.</p>
					) : (
						<Spinner />
					)}
				</ThreadMessage>
			</Thread>
		</div>
	);
}

// The mail as plain text for quoting. Block breaks of HTML mails get lost; plain text mails keep their lines.
const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";

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
