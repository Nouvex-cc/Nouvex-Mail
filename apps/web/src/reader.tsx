// SPDX-License-Identifier: AGPL-3.0-only
import { Button, MailFrame, Spinner, Thread, ThreadMessage, Tooltip, useShortcut } from "@nouvex/ui";
import { ChevronLeft, Trash2 } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import type { Message } from "./db";

export function Reader({
	message: m,
	onClose,
	onTrash,
}: {
	message: Message;
	onClose: () => void;
	onTrash: () => void;
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
				<Tooltip content="Delete">
					<Button variant="ghost" size="icon" aria-label="Delete" onClick={onTrash}>
						<Trash2 strokeWidth={1.75} />
					</Button>
				</Tooltip>
			</div>
			<Thread subject={m.subject}>
				<ThreadMessage from={m.fromName || m.fromAddr} email={m.fromAddr} date={new Date(m.sentAt)} snippet={m.snippet}>
					{body.data !== undefined ? (
						<MailFrame html={body.data} />
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
