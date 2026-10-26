// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Composer, type Contact, type OutgoingMessage, Select, Tooltip, useToast } from "@nouvex/ui";
import { ChevronsUpDown, X } from "@nouvex/ui/icons";
import { Dexie } from "dexie";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { lastUsed } from "./accounts";
import type { Kind } from "./answering";
import { db } from "./db";
import { usePref } from "./prefs";

// What the composer starts with: empty for a new message, a reply with the earlier mail quoted under the text, a
// forward carrying the original along, or a saved draft to continue. One with a conversation (thread) is written there.
export type Draft = {
	draftId: string;
	accountId?: string;
	/** Missing for a new message. */
	kind?: Kind;
	thread?: string;
	to?: string[];
	cc?: string[];
	bcc?: string[];
	subject?: string;
	body?: string;
	quote?: string;
	/** A forward's original: shown as a card, sent along with its formatting. */
	forwarded?: { from: string; date: string; subject: string; text: string; html?: string };
	files?: File[];
	inReplyTo?: string;
	references?: string[];
	/** Who the reply goes to, for the title. */
	person?: string;
	/** In the Drafts folder already: it has its signature, and discarding deletes it there. */
	saved?: boolean;
};

type Sender = { id: string; email: string; signature: string };

// The account last used to write to someone, from the newest mail in every Sent folder.
async function lastFrom(to: string) {
	const sent = (await db.mailboxes.toArray()).filter((b) => b.role === "sent");
	const recent = await Promise.all(
		sent.map((b) =>
			db.messages
				.where("[mailboxId+sentAt]")
				.between([b.id, Dexie.minKey], [b.id, Dexie.maxKey])
				.reverse()
				.limit(500)
				.toArray(),
		),
	);
	return lastUsed(
		recent.flat().sort((a, b) => b.sentAt.localeCompare(a.sentAt)),
		to,
	);
}

export const when = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What goes out of a draft: the text with a forward's original after it, and for a forward its formatting too. */
export function outgoing(d: Pick<Draft, "forwarded">, body: string) {
	const f = d.forwarded;
	if (!f) return { text: body };
	const head = `---------- Forwarded message ----------\nFrom: ${f.from}\nDate: ${f.date}\nSubject: ${f.subject}`;
	return {
		text: `${body}\n\n${head}\n\n${f.text}`,
		html:
			f.html &&
			`<div>${escaped(body).replace(/\n/g, "<br>")}</div><br><div>${escaped(head).replace(/\n/g, "<br>")}</div><br>${f.html}`,
	};
}

/**
 * The composer for one draft. In the dock it's a window in the bottom right that leaves the inbox usable and folds
 * down to its title; in a conversation it takes the reply bar's place. Esc and the close button keep it as a draft;
 * leaving the conversation does too.
 */
export function Write({
	from,
	accounts,
	contacts,
	draft,
	placement,
	onClose,
	onSent,
	onReopen,
}: {
	from?: Sender;
	/** Accounts it can go out from. */
	accounts: Sender[];
	contacts: Contact[];
	draft: Draft;
	placement: "dock" | "reply";
	onClose: () => void;
	/** Handed to the server: kept to open again if the engine can't send it. */
	onSent: (d: Draft) => void;
	/** Opens a draft again, after Undo on discarding. */
	onReopen: (d: Draft) => void;
}) {
	const [undo] = usePref("undoSend");
	const [folded, setFolded] = useState(false);
	const toast = useToast();
	// A new message goes out from the account last used with its first recipient, until the user picks one; a reply
	// or a saved draft keeps its account.
	const [sender, setSender] = useState(from);
	const senderId = useRef(from?.id);
	const picked = useRef(!!draft.accountId);
	const firstTo = useRef<string>(undefined);
	const saved = useRef(!!draft.saved);
	const { draftId } = draft;
	// Files go up once, to be kept with the draft and sent; the server keeps an upload for a day.
	const uploads = useRef(new Map<File, string>());
	const upload = async (files: File[]) => {
		const done = await Promise.all(
			files.map(async (file) => {
				const known = uploads.current.get(file);
				if (known) return { id: known, name: file.name, type: file.type || "application/octet-stream" };
				const form = new FormData();
				form.set("file", file);
				const res = await fetch(`/accounts/${senderId.current}/uploads`, { method: "POST", body: form });
				if (!res.ok) return undefined;
				const { id } = (await res.json()) as { id: string };
				uploads.current.set(file, id);
				return { id, name: file.name, type: file.type || "application/octet-stream" };
			}),
		);
		return done.includes(undefined) ? undefined : (done as { id: string; name: string; type: string }[]);
	};
	const latest = useRef<Omit<OutgoingMessage, "sendAt">>(undefined);

	const switchTo = (id: string) => {
		const next = accounts.find((a) => a.id === id);
		if (!next || id === senderId.current) return;
		// The draft lives in the old account's Drafts; the next save puts it in the new one's.
		if (saved.current) void fetch(`/accounts/${senderId.current}/drafts/${draftId}`, { method: "DELETE" });
		saved.current = false;
		senderId.current = id;
		uploads.current.clear();
		setSender(next);
	};
	// Every edit is saved as a draft two seconds after typing stops; closing or leaving saves right away.
	const pending = useRef<{ timer: ReturnType<typeof setTimeout>; save: () => void }>(undefined);
	const cancel = () => {
		clearTimeout(pending.current?.timer);
		pending.current = undefined;
	};
	const flush = () => {
		const p = pending.current;
		cancel();
		p?.save();
	};
	const store = async (m: Omit<OutgoingMessage, "sendAt">) => {
		saved.current = true;
		const attachments = await upload(m.files);
		await fetch(`/accounts/${senderId.current}/drafts/${draftId}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: m.to,
				cc: m.cc,
				bcc: m.bcc,
				subject: m.subject,
				...outgoing(draft, m.body),
				inReplyTo: draft.inReplyTo,
				rev: Date.now(),
				attachments,
			}),
		});
	};
	const change = (m: Omit<OutgoingMessage, "sendAt">) => {
		cancel();
		latest.current = m;
		const first = m.to[0];
		if (!picked.current && first && first !== firstTo.current) {
			firstTo.current = first;
			void lastFrom(first).then((id) => id && !picked.current && switchTo(id));
		}
		pending.current = { timer: setTimeout(flush, 2000), save: () => void store(m) };
	};
	// Leaving the conversation unmounts a reply; what was typed is kept as a draft.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when it goes
	useEffect(() => () => flush(), []);
	// The draft as the composer has it now, kept to open again; the quote is in the body by then.
	const kept = (m: Omit<OutgoingMessage, "sendAt">): Draft => ({
		...draft,
		accountId: senderId.current,
		to: m.to,
		cc: m.cc,
		bcc: m.bcc,
		subject: m.subject,
		body: m.body,
		quote: undefined,
		files: m.files,
		saved: true,
	});
	const discard = () => {
		cancel();
		if (saved.current) void fetch(`/accounts/${senderId.current}/drafts/${draftId}`, { method: "DELETE" });
		onClose();
		const m = latest.current;
		const back = m ? kept(m) : { ...draft, accountId: senderId.current };
		toast.add({
			title: "Draft discarded",
			actionProps: {
				children: "Undo",
				onClick: () => {
					if (m) void store(m);
					onReopen(back);
				},
			},
		});
	};
	const close = () => {
		flush();
		onClose();
	};
	// The composer keeps everything when this says false, for another try.
	const send = async (m: OutgoingMessage) => {
		cancel();
		const attachments = await upload(m.files);
		if (!attachments) {
			toast.add({ title: "Couldn't upload the files", description: "Check the connection and send again." });
			return false;
		}
		const res = await fetch(`/accounts/${senderId.current}/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: m.to,
				cc: m.cc,
				bcc: m.bcc,
				subject: m.subject,
				...outgoing(draft, m.body),
				inReplyTo: draft.inReplyTo,
				references: draft.references?.length ? draft.references : undefined,
				draftId,
				sendAt: m.sendAt?.toISOString(),
				attachments,
			}),
		}).catch(() => undefined);
		if (!res?.ok) {
			const reason =
				res?.status === 413
					? "The files are over 25 MB together. Remove one and send again."
					: res?.status === 422
						? "A file was gone from the server. Send again to attach it anew."
						: res?.status === 400
							? "Check the recipients: one of them isn't an email address."
							: "Couldn't reach the server. Check the connection and send again.";
			// The uploads may be what expired; they go up again next time.
			if (res?.status === 422) uploads.current.clear();
			toast.add({ title: "Couldn't send", description: reason });
			return false;
		}
		onSent(kept(m));
		if (m.sendAt) toast.add({ title: `Scheduled for ${when(m.sendAt)}`, description: "It waits in the Outbox." });
		onClose();
		return true;
	};

	const title =
		draft.kind === "reply"
			? draft.person
				? `Reply to ${draft.person}`
				: "Reply"
			: draft.kind === "replyAll"
				? "Reply all"
				: draft.kind === "forward"
					? "Forward"
					: draft.subject || "New message";
	return (
		<div
			role="dialog"
			aria-label={title}
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				// Only the composer closes, not the conversation behind it.
				e.stopPropagation();
				close();
			}}
			className={
				placement === "dock"
					? "fixed right-4 bottom-0 z-30 flex w-lg origin-bottom flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-raised shadow-pop transition duration-200 ease-out starting:translate-y-4 starting:opacity-0"
					: "flex max-h-120 origin-bottom flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-pop transition duration-200 ease-out starting:scale-98 starting:opacity-0"
			}
		>
			<div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
				<span className="flex-1 truncate font-medium">{title}</span>
				{placement === "dock" && (
					<Icon label={folded ? "Open" : "Fold down"} onClick={() => setFolded(!folded)}>
						<ChevronsUpDown strokeWidth={1.75} />
					</Icon>
				)}
				<Icon label="Close, keeps a draft" onClick={close}>
					<X strokeWidth={1.75} />
				</Icon>
			</div>
			<div className={folded ? "hidden" : placement === "dock" ? "flex h-120 flex-col" : "flex min-h-0 flex-col"}>
				<Composer
					variant="plain"
					contacts={contacts}
					from={
						accounts.length > 1 ? (
							<>
								<span>From</span>
								<Select.Root
									value={sender?.id}
									onValueChange={(id) => {
										picked.current = true;
										if (id) switchTo(id);
									}}
									items={accounts.map((a) => ({ value: a.id, label: a.email }))}
								>
									<Select.Trigger variant="text" aria-label="From" />
									<Select.Popup>
										{accounts.map((a) => (
											<Select.Item key={a.id} value={a.id}>
												{a.email}
											</Select.Item>
										))}
									</Select.Popup>
								</Select.Root>
							</>
						) : (
							<span className="truncate">From {sender?.email}</span>
						)
					}
					// A forward starts with whom it goes to, a reply in the text.
					focus={draft.kind && draft.kind !== "forward" ? "body" : "to"}
					compact={draft.kind === "reply" || draft.kind === "replyAll"}
					defaultTo={draft.to}
					defaultCc={draft.cc}
					defaultBcc={draft.bcc}
					defaultSubject={draft.subject}
					defaultFiles={draft.files}
					// The signature goes above a quoted message, the way replies are written; a draft has it already.
					defaultBody={from?.signature && !draft.saved ? `${draft.body ?? ""}\n\n-- \n${from.signature}` : draft.body}
					quote={draft.quote}
					original={draft.forwarded}
					undo={undo}
					onSend={send}
					onChange={change}
					onDiscard={discard}
				/>
			</div>
		</div>
	);
}

function Icon({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
	return (
		<Tooltip content={label}>
			<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
				{children}
			</Button>
		</Tooltip>
	);
}
