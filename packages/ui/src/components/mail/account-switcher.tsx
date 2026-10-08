// SPDX-License-Identifier: Apache-2.0
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Avatar } from "../avatar";
import { Menu } from "../menu";
import { TextMorph } from "../text-morph";

export type Account = { id: string; name: string; email: string; avatarUrl?: string; unread?: boolean };

// A few small avatars overlapping, for "All inboxes".
function Stack({ accounts }: { accounts: Account[] }) {
	return (
		<span className="flex -space-x-1">
			{accounts.slice(0, 3).map((a) => (
				// One initial each: overlapped, two letters would be cut in half.
				<Avatar
					key={a.id}
					src={a.avatarUrl}
					name={a.name.split(" ")[0] ?? a.name}
					size="sm"
					className="ring-2 ring-sunken"
				/>
			))}
		</span>
	);
}

export function AccountSwitcher({
	accounts,
	current,
	onChange,
	onAddAccount,
}: {
	accounts: Account[];
	current: string | "all";
	onChange: (id: string | "all") => void;
	onAddAccount?: () => void;
}) {
	const account = accounts.find((a) => a.id === current);
	return (
		<Menu.Root>
			<Menu.Trigger className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left font-medium outline-none transition duration-100 select-none hover:bg-hover focus-visible:outline-2 active:scale-98 open:bg-hover">
				{account ? <Avatar src={account.avatarUrl} name={account.name} size="sm" /> : <Stack accounts={accounts} />}
				<span className="min-w-0 flex-1 truncate">
					<TextMorph by="text">{account?.name ?? "All inboxes"}</TextMorph>
				</span>
				<ChevronsUpDown strokeWidth={1.75} className="size-4 shrink-0 text-muted" />
			</Menu.Trigger>
			<Menu.Popup className="w-64">
				<Menu.Item onClick={() => onChange("all")}>
					<Stack accounts={accounts} />
					<span className="flex-1">All inboxes</span>
					{current === "all" && <Check strokeWidth={1.75} />}
				</Menu.Item>
				<Menu.Separator />
				{accounts.map((a) => (
					<Menu.Item key={a.id} onClick={() => onChange(a.id)}>
						<Avatar src={a.avatarUrl} name={a.name} size="sm" />
						<span className="grid min-w-0 flex-1">
							<span className="truncate">{a.name}</span>
							<span className="truncate text-xs text-muted">{a.email}</span>
						</span>
						{a.unread && (
							<span className="size-1.5 shrink-0 rounded-full bg-ink">
								<span className="sr-only">Unread</span>
							</span>
						)}
						{a.id === current && <Check strokeWidth={1.75} />}
					</Menu.Item>
				))}
				{onAddAccount && (
					<>
						<Menu.Separator />
						<Menu.Item onClick={onAddAccount} className="text-muted">
							<Plus strokeWidth={1.75} />
							Add account
						</Menu.Item>
					</>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
