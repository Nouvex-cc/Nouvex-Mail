// SPDX-License-Identifier: AGPL-3.0-only
import { Composer, type Contact, Dialog, type OutgoingMessage, useToast } from "@nouvex/ui";

export function Write({
	from,
	contacts,
	open,
	onOpenChange,
}: {
	from?: { id: string; email: string };
	contacts: Contact[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
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
			body: JSON.stringify({ to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, text: m.body }),
		});
		if (!res.ok) return toast.add({ title: "Couldn't send", description: "Check the recipients and try again." });
		onOpenChange(false);
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Popup className="max-w-2xl">
				<Dialog.Title>New message</Dialog.Title>
				<Dialog.Description>From {from?.email}</Dialog.Description>
				<Composer contacts={contacts} onSend={send} />
			</Dialog.Popup>
		</Dialog.Root>
	);
}
