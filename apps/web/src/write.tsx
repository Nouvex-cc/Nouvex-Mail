// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Composer, type Contact, type OutgoingMessage, Tooltip, useToast } from "@nouvex/ui";
import { ChevronsUpDown, X } from "@nouvex/ui/icons";
import { type ReactNode, useMemo, useRef, useState } from "react";

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

export const when = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/**
 * The composer for one draft. In the dock it's a window in the bottom right that leaves the inbox usable and folds
 * down to its title; in a conversation it takes the reply bar's place. Esc and the close button keep it as a draft.
 */
export function Write({
	from,
	contacts,
	draft,
	placement,
	onClose,
}: {
	from?: { id: string; email: string; signature: string };
	contacts: Contact[];
	draft: Draft;
	placement: "dock" | "reply";
	onClose: () => void;
}) {
	const [folded, setFolded] = useState(false);
	const toast = useToast();
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
		const save = () =>
			void fetch(`/accounts/${from?.id}/drafts/${draftId}`, {
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
		pending.current = { timer: setTimeout(flush, 2000), save };
	};
	const discard = () => {
		cancel();
		void fetch(`/accounts/${from?.id}/drafts/${draftId}`, { method: "DELETE" });
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
				const res = await fetch(`/accounts/${from?.id}/uploads`, { method: "POST", body: form });
				return res.ok ? { id: ((await res.json()) as { id: string }).id, name: file.name, type: file.type } : undefined;
			}),
		);
		if (uploads.includes(undefined))
			return toast.add({ title: "Couldn't upload the files", description: "Up to 25 MB each." });
		const res = await fetch(`/accounts/${from?.id}/send`, {
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

	const title = placement === "reply" ? `Reply to ${draft.to?.join(", ") ?? ""}` : draft.subject || "New message";
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
					from={placement === "dock" ? <span className="truncate">From {from?.email}</span> : undefined}
					focus={placement === "reply" ? "body" : "to"}
					compact={placement === "reply"}
					defaultTo={draft.to}
					defaultSubject={draft.subject}
					// The signature goes above a quoted message, the way replies are written; a draft has it already.
					defaultBody={from?.signature && !draft.draftId ? `\n\n-- \n${from.signature}${draft.body ?? ""}` : draft.body}
					quote={draft.quote}
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
