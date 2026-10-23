// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Composer, type Contact, type OutgoingMessage, Select, Tooltip, useToast } from "@nouvex/ui";
import { ChevronsUpDown, X } from "@nouvex/ui/icons";
import { Dexie } from "dexie";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { lastUsed } from "./accounts";
import { db } from "./db";
import { usePref } from "./prefs";

// What the composer starts with: empty for a new message, filled in for a reply or forward, or a saved draft
// (draftId) to continue. One started in a conversation (thread) is written there; the quoted message stays
// folded under the text.
export type Draft = {
	accountId?: string;
	to?: string[];
	subject?: string;
	body?: string;
	quote?: string;
	inReplyTo?: string;
	draftId?: string;
	thread?: string;
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

/**
 * The composer for one draft. In the dock it's a window in the bottom right that leaves the inbox usable and folds
 * down to its title; in a conversation it takes the reply bar's place. Esc and the close button keep it as a draft.
 */
export function Write({
	from,
	accounts,
	contacts,
	draft,
	placement,
	onClose,
}: {
	from?: Sender;
	/** Accounts it can go out from. */
	accounts: Sender[];
	contacts: Contact[];
	draft: Draft;
	placement: "dock" | "reply";
	onClose: () => void;
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
	const saved = useRef(!!draft.draftId);
	const switchTo = (id: string) => {
		const next = accounts.find((a) => a.id === id);
		if (!next || id === senderId.current) return;
		// The draft lives in the old account's Drafts; the next save puts it in the new one's.
		if (saved.current) void fetch(`/accounts/${senderId.current}/drafts/${draftId}`, { method: "DELETE" });
		saved.current = false;
		senderId.current = id;
		setSender(next);
	};
	// Every edit is saved as a draft two seconds after typing stops; closing saves right away.
	const draftId = useMemo(() => draft.draftId ?? crypto.randomUUID(), [draft]);
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
	const change = (m: Omit<OutgoingMessage, "files" | "sendAt">) => {
		cancel();
		const first = m.to[0];
		if (!picked.current && first && first !== firstTo.current) {
			firstTo.current = first;
			void lastFrom(first).then((id) => id && !picked.current && switchTo(id));
		}
		const save = () => {
			saved.current = true;
			void fetch(`/accounts/${senderId.current}/drafts/${draftId}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: m.to,
					cc: m.cc,
					bcc: m.bcc,
					subject: m.subject,
					text: m.body,
					inReplyTo: draft.inReplyTo,
				}),
			});
		};
		pending.current = { timer: setTimeout(flush, 2000), save };
	};
	const discard = () => {
		cancel();
		void fetch(`/accounts/${senderId.current}/drafts/${draftId}`, { method: "DELETE" });
		onClose();
	};
	const close = () => {
		flush();
		onClose();
	};
	const send = async (m: OutgoingMessage) => {
		cancel();
		const uploads = await Promise.all(
			m.files.map(async (file) => {
				const form = new FormData();
				form.set("file", file);
				const res = await fetch(`/accounts/${senderId.current}/uploads`, { method: "POST", body: form });
				return res.ok ? { id: ((await res.json()) as { id: string }).id, name: file.name, type: file.type } : undefined;
			}),
		);
		if (uploads.includes(undefined))
			return toast.add({ title: "Couldn't upload the files", description: "Up to 25 MB each." });
		const res = await fetch(`/accounts/${senderId.current}/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: m.to,
				cc: m.cc,
				bcc: m.bcc,
				subject: m.subject,
				text: m.body,
				inReplyTo: draft.inReplyTo,
				draftId,
				sendAt: m.sendAt?.toISOString(),
				attachments: uploads,
			}),
		});
		if (!res.ok) return toast.add({ title: "Couldn't send", description: "Check the recipients and try again." });
		if (m.sendAt) toast.add({ title: `Scheduled for ${when(m.sendAt)}` });
		onClose();
	};

	const named = (draft.to ?? []).map((a) => contacts.find((c) => c.email === a)?.name || a);
	const title = placement === "reply" ? `Reply to ${named.join(", ")}` : draft.subject || "New message";
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Esc closes from anywhere in the composer
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
						placement !== "dock" ? undefined : accounts.length > 1 ? (
							<Select.Root
								value={sender?.id}
								onValueChange={(id) => {
									picked.current = true;
									if (id) switchTo(id);
								}}
								items={accounts.map((a) => ({ value: a.id, label: a.email }))}
							>
								<Select.Trigger
									aria-label="From"
									className="flex min-w-0 items-center gap-1 rounded-sm text-muted outline-none hover:text-ink focus-visible:outline-2"
								>
									<span className="truncate">From {sender?.email}</span>
									<ChevronsUpDown strokeWidth={1.75} className="size-3.5 shrink-0" />
								</Select.Trigger>
								<Select.Popup>
									{accounts.map((a) => (
										<Select.Item key={a.id} value={a.id}>
											{a.email}
										</Select.Item>
									))}
								</Select.Popup>
							</Select.Root>
						) : (
							<span className="truncate">From {sender?.email}</span>
						)
					}
					focus={placement === "reply" ? "body" : "to"}
					compact={placement === "reply"}
					defaultTo={draft.to}
					defaultSubject={draft.subject}
					// The signature goes above a quoted message, the way replies are written; a draft has it already.
					defaultBody={from?.signature && !draft.draftId ? `\n\n-- \n${from.signature}${draft.body ?? ""}` : draft.body}
					quote={draft.quote}
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
