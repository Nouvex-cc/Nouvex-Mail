// SPDX-License-Identifier: Apache-2.0
import { Select as BaseSelect } from "@base-ui/react/select";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { Archive, Check, ChevronRight, ChevronsUpDown, Folder, Layers, Plus } from "../../icons";
import { cn, item as itemClass } from "../../lib";
import { Avatar } from "../avatar";
import { Select } from "../select";
import type { LabelColor } from "./label";

export type Account = {
	id: string;
	name: string;
	email: string;
	avatarUrl?: string;
	color?: LabelColor | null;
	unread?: boolean;
	shortcut?: string;
};

/** Accounts read together; its id is what onChange gets when it's picked. */
export type AccountGroup = { id: string; name: string; detail: string; unread?: boolean; shortcut?: string };

const add = "__add";

// Shortcut, dot and chevron/check each keep their column so they line up.
const End = ({
	unread,
	trigger,
	shortcut,
	children,
}: {
	unread?: boolean;
	trigger?: boolean;
	shortcut?: string;
	children?: ReactNode;
}) => (
	<span className="flex shrink-0 items-center gap-2 text-muted">
		{shortcut && <kbd className="font-sans text-xs text-faint">{shortcut}</kbd>}
		<span
			aria-hidden
			data-fold-hide={trigger || undefined}
			className={cn("size-1.5 rounded-full bg-accent", !unread && "invisible")}
		/>
		<span className="grid size-4 place-items-center">{children}</span>
	</span>
);

function Identity({ picture, name, detail }: { picture: ReactNode; name: string; detail: string }) {
	return (
		<span className="flex min-w-0 items-center gap-2.5 text-left">
			<span className="grid size-8 shrink-0 place-items-center">{picture}</span>
			<span className="grid min-w-0">
				<span className="truncate text-sm font-medium">{name}</span>
				<span className="truncate text-xs text-muted">{detail}</span>
			</span>
		</span>
	);
}

/**
 * Picks one account, a group of them or all of them. Archived accounts wait behind a row at the end, like archived
 * chats, and fold out under it.
 */
export function AccountSwitcher({
	accounts,
	groups = [],
	archived = [],
	allShortcut,
	current,
	onChange,
	onAddAccount,
}: {
	accounts: Account[];
	groups?: AccountGroup[];
	archived?: Account[];
	allShortcut?: string;
	current: string | "all";
	onChange: (id: string | "all") => void;
	onAddAccount?: () => void;
}) {
	const [unfolded, setUnfolded] = useState(false);
	const entries = [
		{
			id: "all",
			name: "All inboxes",
			detail: `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`,
			unread: accounts.some((a) => a.unread),
			shortcut: allShortcut,
			picture: (
				<span className="grid size-8 place-items-center rounded-full bg-selected text-muted">
					<Layers strokeWidth={1.75} className="size-4" />
				</span>
			),
		},
		...groups.map((g) => ({
			...g,
			picture: (
				<span className="grid size-8 place-items-center rounded-full bg-selected text-muted">
					<Folder strokeWidth={1.75} className="size-4" />
				</span>
			),
		})),
		...accounts.map((a) => ({
			id: a.id,
			name: a.name,
			detail: a.email,
			unread: a.unread,
			shortcut: a.shortcut,
			picture: <Avatar src={a.avatarUrl} name={a.name} color={a.color ?? undefined} />,
		})),
	];
	// Separators follow "All inboxes" and the last group.
	const breaks = groups.length ? [0, groups.length] : [0];
	const index = Math.max(
		0,
		entries.findIndex((e) => e.id === current),
	);
	const shown = entries[index];
	// Opening over the trigger needs room above it for the entries before the current one (48px rows, plus the
	// separators); otherwise the list drops down below.
	const [around, setAround] = useState(true);
	const trigger = useRef<HTMLButtonElement>(null);

	return (
		<Select.Root
			value={current}
			onOpenChange={(open) => {
				const top = trigger.current?.getBoundingClientRect().top ?? 0;
				if (open) setAround(top - 8 >= index * 48 + breaks.filter((b) => b < index).length * 9);
			}}
			onValueChange={(id, details) => {
				if (id === add) {
					// Not a choice: nothing should land on the trigger.
					details.cancel();
					onAddAccount?.();
				} else if (id) onChange(id);
			}}
		>
			<Select.Trigger
				ref={trigger}
				aria-label="Account"
				className="flex h-12 w-full shrink-0 items-center justify-between gap-2 rounded-md px-2 outline-none transition-colors duration-100 hover:bg-hover open:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink/30"
			>
				<BaseSelect.Value data-fold-hide className="min-w-0">
					{shown && <Identity {...shown} />}
				</BaseSelect.Value>
				<End trigger unread={shown?.unread}>
					<ChevronsUpDown strokeWidth={1.75} className="size-4" />
				</End>
			</Select.Trigger>
			<Select.Popup align={around} className="w-(--anchor-width) border-0 data-[side=none]:translate-y-0">
				{entries.map((e, i) => (
					<Fragment key={e.id}>
						<BaseSelect.Item value={e.id} className={cn(itemClass, "h-12 justify-between rounded-none")}>
							<BaseSelect.ItemText className="min-w-0">
								<Identity {...e} />
							</BaseSelect.ItemText>
							<End unread={e.unread} shortcut={e.shortcut}>
								<BaseSelect.ItemIndicator data-fold-fade className="text-ink">
									<Check strokeWidth={2} />
								</BaseSelect.ItemIndicator>
							</End>
						</BaseSelect.Item>
						{breaks.includes(i) && <Select.Separator className="my-0" />}
					</Fragment>
				))}
				{archived.length > 0 && (
					<>
						<Select.Separator className="my-0" />
						<button
							type="button"
							aria-expanded={unfolded}
							onClick={() => setUnfolded(!unfolded)}
							className={cn(itemClass, "h-10 w-full gap-2.5 rounded-none text-muted hover:bg-hover hover:text-ink")}
						>
							<span className="grid size-8 place-items-center">
								<Archive strokeWidth={1.75} />
							</span>
							<span className="flex-1 text-left">Archived</span>
							<span className="text-xs tabular-nums">{archived.length}</span>
							<ChevronRight
								strokeWidth={1.75}
								className={cn("transition-transform duration-150 ease-out", unfolded && "rotate-90")}
							/>
						</button>
						{unfolded &&
							archived.map((a) => (
								<BaseSelect.Item key={a.id} value={a.id} className={cn(itemClass, "h-12 justify-between rounded-none")}>
									<BaseSelect.ItemText className="min-w-0">
										<Identity
											name={a.name}
											detail={a.email}
											picture={<Avatar src={a.avatarUrl} name={a.name} color={a.color ?? undefined} />}
										/>
									</BaseSelect.ItemText>
									<End unread={a.unread} />
								</BaseSelect.Item>
							))}
					</>
				)}
				{onAddAccount && (
					<>
						<Select.Separator className="my-0" />
						<BaseSelect.Item value={add} className={cn(itemClass, "h-10 gap-2.5 rounded-none text-muted")}>
							<span className="grid size-8 place-items-center">
								<Plus strokeWidth={1.75} />
							</span>
							Add account
						</BaseSelect.Item>
					</>
				)}
			</Select.Popup>
		</Select.Root>
	);
}
