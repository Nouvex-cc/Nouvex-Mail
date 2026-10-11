// SPDX-License-Identifier: AGPL-3.0-only
import { Composer, type Contact, Dialog, type OutgoingMessage, useToast } from "@nouvex/ui";
import { useMemo, useRef } from "react";

// What the composer starts with: empty for a new message, filled in for a reply or forward, or a saved draft
// (draftId) to continue.
export type Draft = {
	accountId?: string;
	to?: string[];
	subject?: string;
	body?: string;
	inReplyTo?: string;
	draftId?: string;
};

export function Write({
	from,
	contacts,
	draft,
	onClose,
}: {
	from?: { id: string; email: string; signature: string };
	contacts: Contact[];
	draft?: Draft;
	onClose: () => void;
}) {
	const toast = useToast();
	// Every edit is saved as a draft two seconds after typing stops; closing saves right away.
	const draftId = useMemo(() => draft?.draftId ?? crypto.randomUUID(), [draft]);
	const pending = useRef<{ timer: ReturnType<typeof setTimeout>; save: () => void }>(undefined);
	const flush = () => {
		if (!pending.current) return;
		clearTimeout(pending.current.timer);
		pending.current.save();
		pending.current = undefined;
	};
	const change = (m: Omit<OutgoingMessage, "files" | "sendAt">) => {
		if (pending.current) clearTimeout(pending.current.timer);
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
					inReplyTo: draft?.inReplyTo,
				}),
			});
		pending.current = { timer: setTimeout(flush, 2000), save };
	};
	const discard = () => {
		if (pending.current) clearTimeout(pending.current.timer);
		pending.current = undefined;
		void fetch(`/accounts/${from?.id}/drafts/${draftId}`, { method: "DELETE" });
		onClose();
	};
	const close = () => {
		flush();
		onClose();
	};
	const send = async (m: OutgoingMessage) => {
		if (pending.current) clearTimeout(pending.current.timer);
		pending.current = undefined;
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
				inReplyTo: draft?.inReplyTo,
				draftId,
				sendAt: m.sendAt?.toISOString(),
				attachments: uploads,
			}),
		});
		if (!res.ok) return toast.add({ title: "Couldn't send", description: "Check the recipients and try again." });
		if (m.sendAt) {
			toast.add({
				title: `Scheduled for ${m.sendAt.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
			});
		}
		onClose();
	};

	return (
		<Dialog.Root open={draft !== undefined} onOpenChange={(open) => open || close()}>
			<Dialog.Popup className="max-w-2xl">
				<Dialog.Title>New message</Dialog.Title>
				<Dialog.Description>From {from?.email}</Dialog.Description>
				<Composer
					contacts={contacts}
					defaultTo={draft?.to}
					defaultSubject={draft?.subject}
					// The signature goes above a quoted message, the way replies are written; a draft has it already.
					defaultBody={
						from?.signature && !draft?.draftId ? `\n\n-- \n${from.signature}${draft?.body ?? ""}` : draft?.body
					}
					onSend={send}
					onChange={change}
					onDiscard={discard}
				/>
			</Dialog.Popup>
		</Dialog.Root>
	);
}
