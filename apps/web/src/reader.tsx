// SPDX-License-Identifier: AGPL-3.0-only
import { Button, MailFrame, Spinner, Thread, ThreadMessage, useShortcut } from "@nouvex/ui";
import { ChevronLeft } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import type { Message } from "./db";

export function Reader({ message: m, onClose }: { message: Message; onClose: () => void }) {
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
			<Button variant="ghost" size="sm" className="justify-self-start" onClick={onClose}>
				<ChevronLeft strokeWidth={1.75} />
				Inbox
			</Button>
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
