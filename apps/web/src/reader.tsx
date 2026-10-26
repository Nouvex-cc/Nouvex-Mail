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
import { addresses, type Kind, subject as prefixed, references, text } from "./answering";
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
	onWrite: (draft: Omit<Draft, "draftId">) => void;
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
	const others = [...new Set([newest.fromAddr, ...newest.to, ...newest.cc])].filter((a) => !mine.has(a.toLowerCase()));
	// The body is waited for, so the quote is there; one that won't load is quoted by its preview.
	const answer = async (kind: Kind) => {
		const loaded = html.data ?? (await body(newest).catch(() => undefined));
		const quoted = loaded === undefined ? newest.snippet : text(loaded);
		const date = new Date(newest.sentAt).toLocaleString();
		const subject = prefixed(kind, newest.subject);
		if (kind === "forward") {
			const files = await Promise.all(newest.attachments.map((_, i) => attachment(newest, i))).catch(() => []);
			return onWrite({
				accountId: newest.accountId,
				kind,
				subject,
				forwarded: { from: sender(newest), date, subject: newest.subject, text: quoted, html: loaded },
				files,
			});
		}
		const { to, cc } = addresses(kind, newest, mine);
		onWrite({
			accountId: newest.accountId,
			kind,
			to,
			cc,
			subject,
			quote: `\n\nOn ${date}, ${sender(newest)} wrote:\n${quoted.replace(/^/gm, "> ")}`,
			inReplyTo: newest.messageId || undefined,
			references: references(messages.map((m) => m.messageId)),
			person: ours ? (to[0] ?? "") : newest.fromName || newest.fromAddr,
		});
	};
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
				onReply: () => (draft ? onResume(draft) : void answer("reply")),
				onReplyAll: others.length > 1 ? () => void answer("replyAll") : undefined,
				onForward: () => void answer("forward"),
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
					<Entry message={m} onMailto={(url) => onWrite(mailto(url, m.accountId))} />
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

// A message's file, opened here.
export async function attachment(m: Message, i: number) {
	const res = await fetch(`/accounts/${m.accountId}/messages/${m.id}/attachments/${i}`);
	if (!res.ok) throw new Error(`attachment: ${res.status}`);
	const file = m.attachments[i];
	const data = await decrypt(await messageKey(m), `att/${i}`, new Uint8Array(await res.arrayBuffer()));
	return new File([data], file?.name ?? "attachment", { type: file?.type || "application/octet-stream" });
}

// Saved as a download, never shown on our origin.
async function download(m: Message, i: number) {
	const file = await attachment(m, i);
	const link = document.createElement("a");
	link.href = URL.createObjectURL(file);
	link.download = file.name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

/** A new message from a mailto: link, with what it asks for. */
export function mailto(url: string, accountId: string): Omit<Draft, "draftId"> {
	const u = new URL(url);
	const list = (s: string | null) =>
		(s ?? "")
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean);
	return {
		accountId,
		to: list(decodeURIComponent(u.pathname)),
		cc: list(u.searchParams.get("cc")),
		bcc: list(u.searchParams.get("bcc")),
		subject: u.searchParams.get("subject") ?? "",
		body: u.searchParams.get("body") ?? "",
	};
}

// The body of one message; it loads when the message is first shown.
function Entry({ message: m, onMailto }: { message: Message; onMailto: (url: string) => void }) {
	const [images] = usePref("remoteImages");
	const html = useQuery({ queryKey: ["body", m.id], queryFn: () => body(m), staleTime: Number.POSITIVE_INFINITY });

	return html.data !== undefined ? (
		<>
			<MailFrame html={html.data} proxy={image} ask={images === "ask"} onMailto={onMailto} />
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

const sender = (m: Message) => (m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr);
