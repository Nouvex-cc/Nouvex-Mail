// SPDX-License-Identifier: AGPL-3.0-only
import { Composer, type Contact, Dialog, type OutgoingMessage, useToast } from "@nouvex/ui";

// What the composer starts with: empty for a new message, filled in for a reply or forward.
export type Draft = { accountId?: string; to?: string[]; subject?: string; body?: string; inReplyTo?: string };

export function Write({
	from,
	contacts,
	draft,
	onClose,
}: {
	from?: { id: string; email: string };
	contacts: Contact[];
	draft?: Draft;
	onClose: () => void;
}) {
	const toast = useToast();
	const send = async (m: OutgoingMessage) => {
		// ponytail: attachments and scheduling need uploads and delayed delivery; the composer offers both already.
		if (m.files.length || m.sendAt) {
			toast.add({ title: "Attachments and send later aren't supported yet" });
			return;
		}
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
			}),
		});
		if (!res.ok) return toast.add({ title: "Couldn't send", description: "Check the recipients and try again." });
		onClose();
	};

	return (
		<Dialog.Root open={draft !== undefined} onOpenChange={(open) => open || onClose()}>
			<Dialog.Popup className="max-w-2xl">
				<Dialog.Title>New message</Dialog.Title>
				<Dialog.Description>From {from?.email}</Dialog.Description>
				<Composer
					contacts={contacts}
					defaultTo={draft?.to}
					defaultSubject={draft?.subject}
					defaultBody={draft?.body}
					onSend={send}
				/>
			</Dialog.Popup>
		</Dialog.Root>
	);
}
