// SPDX-License-Identifier: AGPL-3.0-only
import { Button, useToast } from "@nouvex/ui";
import { Clock, ShieldAlert, X } from "@nouvex/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { when } from "./write";

export type Waiting = {
	draftId: string;
	accountId: string;
	state: "scheduled" | "failed";
	runAt: string | null;
	error: string | null;
	to: string[];
	subject: string;
};

/** What waits to go out later, and what couldn't be sent, of these accounts. */
export const useOutbox = (accountIds: string[]) =>
	useQuery({
		queryKey: ["outbox", accountIds.join()],
		queryFn: async () => {
			const lists = await Promise.all(
				accountIds.map(async (id) => {
					const res = await fetch(`/accounts/${id}/outbox`);
					if (!res.ok) return [];
					return ((await res.json()) as Omit<Waiting, "accountId">[]).map((w) => ({ ...w, accountId: id }));
				}),
			);
			return lists.flat();
		},
		enabled: accountIds.length > 0,
	});

/**
 * The Outbox: scheduled mail, which can go back to Drafts to change or send now, and mail that couldn't be sent,
 * which is back in Drafts already and says why.
 */
export function Outbox({ accountIds, onDrafts }: { accountIds: string[]; onDrafts: () => void }) {
	const outbox = useOutbox(accountIds);
	const toast = useToast();
	const takeBack = async (w: Waiting) => {
		const res = await fetch(`/accounts/${w.accountId}/outbox/${w.draftId}`, { method: "DELETE" });
		if (res.status === 409) toast.add({ title: "It's going out right now" });
		else if (!res.ok) toast.add({ title: "Couldn't take it back" });
		else if (w.state === "scheduled")
			toast.add({
				title: "Back in Drafts",
				description: `“${w.subject || "(no subject)"}” won't go out until you send it.`,
			});
		void outbox.refetch();
	};
	const list = outbox.data ?? [];
	if (!list.length) return <p className="grid h-full place-items-center text-sm text-muted">Nothing waits to go out</p>;
	return (
		<ul className="divide-y divide-line">
			{list.map((w) => (
				<li key={w.draftId} className="flex items-start gap-3 px-4 py-3">
					<span className={w.error ? "pt-0.5 text-danger" : "pt-0.5 text-muted"}>
						{w.error ? <ShieldAlert strokeWidth={1.75} /> : <Clock strokeWidth={1.75} />}
					</span>
					<div className="grid min-w-0 flex-1 gap-0.5">
						<span className="truncate font-medium">{w.subject || "(no subject)"}</span>
						<span className="truncate text-sm text-muted">To {w.to.join(", ")}</span>
						<span className={w.error ? "text-sm text-danger" : "text-sm text-muted"}>
							{w.error
								? `Couldn't send: ${w.error}${w.error.endsWith(".") ? "" : "."} It's in Drafts.`
								: `Goes out ${w.runAt ? when(new Date(w.runAt)) : "later"}`}
						</span>
					</div>
					{w.error ? (
						<>
							<Button variant="ghost" size="sm" onClick={onDrafts}>
								Open Drafts
							</Button>
							<Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => void takeBack(w)}>
								<X strokeWidth={1.75} />
							</Button>
						</>
					) : (
						<Button variant="ghost" size="sm" onClick={() => void takeBack(w)}>
							Back to Drafts
						</Button>
					)}
				</li>
			))}
		</ul>
	);
}
