// SPDX-License-Identifier: Apache-2.0
import { Select } from "@base-ui/react/select";
import { Check, ChevronsUpDown, Layers, Plus } from "lucide-react";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { cn, item as itemClass, popup } from "../../lib";
import { Avatar } from "../avatar";
import { Highlight } from "../highlight";

export type Account = { id: string; name: string; email: string; avatarUrl?: string; unread?: boolean };

const add = "__add";

function Identity({
	picture,
	name,
	detail,
	unread,
}: {
	picture: ReactNode;
	name: string;
	detail: string;
	unread?: boolean;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2.5 text-left">
			<span className="relative grid size-8 shrink-0 place-items-center">
				{picture}
				{unread && (
					<span aria-hidden className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-ink ring-2 ring-raised" />
				)}
			</span>
			<span className="grid min-w-0">
				<span className="truncate text-sm font-medium">{name}</span>
				<span className="truncate text-xs text-muted">{detail}</span>
			</span>
		</span>
	);
}

/**
 * The current account (or all inboxes) with a list of the others. The list opens around the current entry, so it
 * stays exactly where it was and the rest unfold above and below it.
 */
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
	const entries = [
		{
			id: "all",
			name: "All inboxes",
			detail: `${accounts.length} accounts`,
			unread: accounts.some((a) => a.unread),
			// Same circle as an account's avatar, so every row lines up.
			picture: (
				<span className="grid size-8 place-items-center rounded-full bg-selected text-muted">
					<Layers strokeWidth={1.75} className="size-4" />
				</span>
			),
		},
		...accounts.map((a) => ({
			id: a.id,
			name: a.name,
			detail: a.email,
			unread: a.unread,
			picture: <Avatar src={a.avatarUrl} name={a.name} />,
		})),
	];
	// Opening around the current entry needs room above it for the entries before it (48px rows, plus the
	// separator after "All inboxes"); otherwise the list drops down below.
	const [around, setAround] = useState(true);
	const trigger = useRef<HTMLButtonElement>(null);
	const index = entries.findIndex((e) => e.id === current);

	const identity = (id: string) => {
		const e = entries.find((x) => x.id === id) ?? entries[0];
		return e && <Identity {...e} />;
	};

	return (
		<Select.Root
			value={current}
			onOpenChange={(open) => {
				const top = trigger.current?.getBoundingClientRect().top ?? 0;
				if (open) setAround(top - 8 >= index * 48 + (index ? 9 : 0));
			}}
			onValueChange={(id) => {
				if (id === add) onAddAccount?.();
				else if (id) onChange(id);
			}}
		>
			<Select.Trigger
				ref={trigger}
				aria-label="Account"
				className="flex h-12 w-full shrink-0 items-center justify-between gap-2 rounded-md px-2 outline-none transition-colors duration-100 hover:bg-hover open:bg-hover active:scale-99 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink/30"
			>
				<Select.Value className="min-w-0">{identity}</Select.Value>
				<ChevronsUpDown strokeWidth={1.75} className="size-4 shrink-0 text-muted" />
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner alignItemWithTrigger={around} sideOffset={4} className="z-50 outline-none">
					<Select.Popup
						className={cn(
							popup,
							// The current entry lands exactly on the trigger: same width (popup padding and border added), no zoom.
							"w-[calc(var(--anchor-width)+--spacing(2.5))] p-1 starting:scale-100 ending:scale-100",
						)}
					>
						<Select.List className="relative max-h-(--available-height) overflow-y-auto outline-none">
							<Highlight />
							{entries.map((e, i) => (
								<Fragment key={e.id}>
									<Select.Item value={e.id} className={cn(itemClass, "h-12 justify-between")}>
										<Select.ItemText className="min-w-0">
											<Identity {...e} />
										</Select.ItemText>
										<Select.ItemIndicator className="text-ink">
											<Check strokeWidth={2} />
										</Select.ItemIndicator>
									</Select.Item>
									{i === 0 && <Select.Separator className="mx-2 my-1 h-px bg-line" />}
								</Fragment>
							))}
							{onAddAccount && (
								<>
									<Select.Separator className="mx-2 my-1 h-px bg-line" />
									<Select.Item value={add} className={cn(itemClass, "h-10 gap-2.5 text-muted")}>
										<span className="grid size-8 place-items-center">
											<Plus strokeWidth={1.75} />
										</span>
										Add account
									</Select.Item>
								</>
							)}
						</Select.List>
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}
