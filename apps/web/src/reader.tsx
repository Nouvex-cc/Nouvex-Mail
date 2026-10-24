// SPDX-License-Identifier: AGPL-3.0-only

import runtime from "@nouvex/rich/runtime.js?raw";
import { decrypt } from "@nouvex/sdk/crypto";
import {
	AttachmentList,
	AttachmentTile,
	Button,
	Dialog,
	MailFrame,
	Menu,
	RichFrame,
	Spinner,
	Thread,
	ThreadMessage,
	Tooltip,
	useShortcut,
} from "@nouvex/ui";
import { Archive, ChevronLeft, Mail, More, Star, StarFilled, Trash2 } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { useAccounts } from "./accounts";
import { type Category, type Message, tabs } from "./db";
import { messageKey } from "./keys";
import { usePref } from "./prefs";
import type { Draft } from "./write";

const image = (url: string) => `/image?url=${encodeURIComponent(url)}`;

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
	composer,
	draft,
	onResume,
	onSort,
	onSpam,
	onUnsubscribe,
}: {
	messages: Message[];
	starred: boolean;
	onStar: () => void;
	onClose: () => void;
	onTrash: () => void;
	onArchive?: () => void;
	onWrite: (draft: Draft) => void;
	onMarkUnread: () => void;
	/** A reply being written, in the reply bar's place. */
	composer?: ReactNode;
	/** Our unsent reply to this conversation; Reply continues it instead of starting over. */
	draft?: Message;
	onResume: (draft: Message) => void;
	/** From now on, the sender's mail goes into this tab. */
	onSort: (category: Category) => void;
	/** The sender's mail is spam from now on, or isn't. */
	onSpam: (spam: boolean) => void;
	onUnsubscribe: () => void;
}) {
	useShortcut("Escape", onClose);
	const accounts = useAccounts();
	const [replyTo] = usePref("replyDefault");
	const [classic, setClassic] = useState(false);
	const newest = messages.at(-1);
	const actions = (
		<div className="flex gap-1">
			{newest?.unsubscribe && (
				<Button variant="ghost" size="sm" onClick={onUnsubscribe}>
					Unsubscribe
				</Button>
			)}
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
			<Menu.Root>
				<Menu.Trigger render={<Button variant="ghost" size="icon" aria-label="More" />}>
					<More strokeWidth={1.75} />
				</Menu.Trigger>
				<Menu.Popup align="end">
					<Menu.SubmenuRoot>
						<Menu.SubmenuTrigger>Always sort as</Menu.SubmenuTrigger>
						<Menu.Popup>
							{tabs.map(([c, name]) => (
								<Menu.Item key={c} disabled={newest?.category === c} onClick={() => onSort(c)}>
									{name}
								</Menu.Item>
							))}
						</Menu.Popup>
					</Menu.SubmenuRoot>
					<Menu.Item onClick={() => onSpam(!newest?.spam)}>{newest?.spam ? "Not spam" : "Report spam"}</Menu.Item>
				</Menu.Popup>
			</Menu.Root>
		</div>
	);
	const html = useQuery({
		queryKey: ["body", newest?.id],
		queryFn: () => body(newest as Message),
		enabled: !!newest,
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (!newest) return null;

	// Replies answer the newest message. When that's one of ours, they go to whoever it went to.
	const mine = new Set(accounts.data?.map((a) => a.email.toLowerCase()));
	const ours = mine.has(newest.fromAddr.toLowerCase());
	const quoted = html.data === undefined ? undefined : text(html.data);
	const others = [...new Set([newest.fromAddr, ...newest.to, ...newest.cc])].filter((a) => !mine.has(a.toLowerCase()));
	const write = (draft: Draft) => quoted !== undefined && onWrite(draft);
	const back = (
		<Button variant="ghost" size="sm" onClick={onClose}>
			<ChevronLeft strokeWidth={1.75} />
			Inbox
		</Button>
	);

	// A rich mail on its own takes the whole reading area; in a conversation it reads like any other mail.
	if (newest.rich && messages.length === 1 && !classic)
		return <Rich message={newest} back={back} actions={actions} onClassic={() => setClassic(true)} />;

	return (
		<Thread
			subject={newest.subject}
			back={back}
			actions={actions}
			composer={composer}
			reply={{
				to:
					replyTo === "all" && others.length > 1
						? `${ours ? others[0] : newest.fromName || newest.fromAddr} and ${others.length - 1} more`
						: ours
							? newest.to.join(", ")
							: newest.fromName || newest.fromAddr,
				drafted: !!draft,
				allFirst: replyTo === "all",
				onReply: () =>
					draft ? onResume(draft) : write(reply(newest, quoted ?? "", ours ? newest.to : [newest.fromAddr])),
				onReplyAll: others.length > 1 ? () => write(reply(newest, quoted ?? "", others)) : undefined,
				onForward: () => write(forward(newest, quoted ?? "")),
			}}
		>
			{messages.map((m) => (
				<ThreadMessage
					key={m.id}
					from={m.fromName || m.fromAddr}
					email={m.fromAddr}
					to={[...m.to, ...m.cc]}
					date={new Date(m.sentAt)}
					snippet={m.snippet}
					defaultExpanded={m.seen === 0}
				>
					<Entry message={m} />
				</ThreadMessage>
			))}
		</Thread>
	);
}

export async function body(m: Message) {
	const res = await fetch(`/accounts/${m.accountId}/messages/${m.id}/body`);
	if (!res.ok) throw new Error(`body: ${res.status}`);
	const { sealed } = (await res.json()) as { sealed: string };
	return new TextDecoder().decode(await decrypt(await messageKey(m), "body", Uint8Array.fromBase64(sealed)));
}

async function rich(m: Message) {
	const res = await fetch(`/accounts/${m.accountId}/messages/${m.id}/rich`);
	if (!res.ok) throw new Error(`rich: ${res.status}`);
	const { sealed } = (await res.json()) as { sealed: string };
	return new TextDecoder().decode(await decrypt(await messageKey(m), "rich", Uint8Array.fromBase64(sealed)));
}

// A picture or font for a rich mail, through the proxy, as a data: URI the sandboxed frame can show.
async function inlined(url: string) {
	const res = await fetch(image(url));
	if (!res.ok) return;
	const blob = await res.blob();
	return new Promise<string>((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.readAsDataURL(blob);
	});
}

type Asking = {
	action: string;
	fields: Record<string, string | string[]>;
	answer: (ok: boolean) => void;
	// Closing the dialog after Send must not count as Cancel.
	done?: boolean;
};

// The designed version of a rich mail over the whole reading area, under a slim bar.
function Rich({
	message: m,
	back,
	actions,
	onClassic,
}: {
	message: Message;
	back: ReactNode;
	actions: ReactNode;
	onClassic: () => void;
}) {
	const navigate = useNavigate();
	const [images] = usePref("remoteImages");
	const [pictures, setPictures] = useState(images !== "ask");
	const html = useQuery({ queryKey: ["rich", m.id], queryFn: () => rich(m), staleTime: Number.POSITIVE_INFINITY });
	const load = useMemo(() => (pictures ? inlined : undefined), [pictures]);
	const [asking, setAsking] = useState<Asking>();
	const answer = (send: boolean) => {
		if (!asking || asking.done) return;
		asking.done = true;
		setAsking(undefined);
		if (!send) return asking.answer(false);
		void fetch("/rich/submit", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: asking.action, fields: asking.fields }),
		}).then(
			(res) => asking.answer(res.ok),
			() => asking.answer(false),
		);
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
				{back}
				<span className="min-w-0 flex-1 truncate text-sm text-muted">{m.fromName || m.fromAddr}</span>
				{!pictures && (
					<Button variant="ghost" size="sm" onClick={() => setPictures(true)}>
						Show pictures
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={onClassic}>
					Show classic
				</Button>
				{actions}
			</div>
			{html.data !== undefined ? (
				<RichFrame
					className="flex-1"
					html={html.data}
					runtime={runtime}
					load={load}
					onForm={(action, fields) => new Promise((resolve) => setAsking({ action, fields, answer: resolve }))}
					// Only mail Nouvex put into the inbox itself may open places in the app.
					onAction={m.seeded ? (href) => navigate({ to: `/${href.replace(/^nouvex:/, "")}` }) : undefined}
				/>
			) : html.isError ? (
				<p className="p-4 text-sm text-muted">This message couldn't be loaded.</p>
			) : (
				<Spinner />
			)}
			<Dialog.Root open={!!asking} onOpenChange={(open) => !open && answer(false)}>
				<Dialog.Popup>
					<Dialog.Title>Send your answer?</Dialog.Title>
					<Dialog.Description>
						It goes to {asking ? new URL(asking.action).host : ""}, sent from Nouvex, so they don't see your address.
					</Dialog.Description>
					<Dialog.Footer>
						<Button variant="ghost" onClick={() => answer(false)}>
							Cancel
						</Button>
						<Button variant="primary" onClick={() => answer(true)}>
							Send
						</Button>
					</Dialog.Footer>
				</Dialog.Popup>
			</Dialog.Root>
		</div>
	);
}

// Opened here and saved as a download, never shown on our origin.
async function download(m: Message, i: number) {
	const res = await fetch(`/accounts/${m.accountId}/messages/${m.id}/attachments/${i}`);
	if (!res.ok) throw new Error(`attachment: ${res.status}`);
	const file = m.attachments[i];
	const data = await decrypt(await messageKey(m), `att/${i}`, new Uint8Array(await res.arrayBuffer()));
	const link = document.createElement("a");
	link.href = URL.createObjectURL(new Blob([data], { type: file?.type || "application/octet-stream" }));
	link.download = file?.name ?? "attachment";
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

// The body of one message; it loads when the message is first shown.
function Entry({ message: m }: { message: Message }) {
	const [images] = usePref("remoteImages");
	const html = useQuery({ queryKey: ["body", m.id], queryFn: () => body(m), staleTime: Number.POSITIVE_INFINITY });

	return html.data !== undefined ? (
		<>
			<MailFrame html={html.data} proxy={image} ask={images === "ask"} />
			{m.attachments.length > 0 && (
				<AttachmentList>
					{m.attachments.map((a, i) => (
						<AttachmentTile
							// biome-ignore lint/suspicious/noArrayIndexKey: attachments are addressed by position, the API too
							key={i}
							{...a}
							onOpen={() => void download(m, i)}
						/>
					))}
				</AttachmentList>
			)}
		</>
	) : html.isError ? (
		<p className="text-sm text-muted">This message couldn't be loaded.</p>
	) : (
		<Spinner />
	);
}

// The mail as plain text for quoting. Block breaks of HTML mails get lost; plain text mails keep their lines.
export const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";

const prefixed = (prefix: string, subject: string) =>
	subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;

const sender = (m: Message) => (m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr);

const reply = (m: Message, body: string, to: string[]): Draft => ({
	accountId: m.accountId,
	to,
	subject: prefixed("Re:", m.subject),
	quote: `\n\nOn ${new Date(m.sentAt).toLocaleString()}, ${sender(m)} wrote:\n${body.replace(/^/gm, "> ")}`,
	inReplyTo: m.messageId || undefined,
});

const forward = (m: Message, body: string): Draft => ({
	accountId: m.accountId,
	subject: prefixed("Fwd:", m.subject),
	quote: `\n\n---------- Forwarded message ----------\nFrom: ${sender(m)}\nDate: ${new Date(m.sentAt).toLocaleString()}\nSubject: ${m.subject}\n\n${body}`,
});
