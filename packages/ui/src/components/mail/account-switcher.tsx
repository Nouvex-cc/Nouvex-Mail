// SPDX-License-Identifier: Apache-2.0
import { Layers, Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cn } from "../../lib";
import { Avatar } from "../avatar";
import { Highlight } from "../highlight";
import { TextMorph } from "../text-morph";
import { Tooltip } from "../tooltip";

export type Account = { id: string; name: string; email: string; avatarUrl?: string; unread?: boolean };

/**
 * Accounts side by side as avatars with a pill that slides to the current one; its name and address morph into
 * place underneath. "All inboxes" comes first, adding an account last.
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
	const rail = useRef<HTMLDivElement>(null);
	const items: { id: string | "all"; label: string; detail: string; avatar: ReactNode; unread?: boolean }[] = [
		{
			id: "all",
			label: "All inboxes",
			detail: `${accounts.length} accounts`,
			unread: accounts.some((a) => a.unread),
			avatar: <Layers strokeWidth={1.75} className="size-4" />,
		},
		...accounts.map((a) => ({
			id: a.id,
			label: a.name,
			detail: a.email,
			unread: a.unread,
			avatar: <Avatar src={a.avatarUrl} name={a.name} size="sm" className="size-7" />,
		})),
	];

	// Arrow keys move between accounts like tabs.
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		const tabs = [...(rail.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
		const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
		const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
		next?.focus();
		next?.click();
		e.preventDefault();
	};

	const shown = items.find((i) => i.id === current) ?? items[0];

	return (
		<div className="grid gap-1.5">
			<div
				ref={rail}
				role="tablist"
				aria-label="Accounts"
				onKeyDown={onKeyDown}
				className="relative flex items-center gap-1"
			>
				<Highlight attr="data-active" className="rounded-full bg-raised ring-1 ring-line" />
				{items.map((item) => {
					const active = item.id === current;
					return (
						<Tooltip key={item.id} content={item.id === "all" ? item.label : `${item.label} · ${item.detail}`}>
							<button
								type="button"
								role="tab"
								aria-selected={active}
								aria-label={item.label}
								tabIndex={active ? 0 : -1}
								data-active={active || undefined}
								onClick={() => onChange(item.id)}
								className="relative grid size-9 shrink-0 place-items-center rounded-full outline-none transition duration-150 not-data-active:hover:bg-hover active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								<span className="relative grid size-7 place-items-center">
									{item.avatar}
									{item.unread && (
										<span
											aria-hidden
											className={cn(
												"absolute -top-0.5 -right-0.5 size-2 rounded-full bg-ink ring-2 transition-shadow duration-200",
												active ? "ring-raised" : "ring-sunken",
											)}
										/>
									)}
								</span>
							</button>
						</Tooltip>
					);
				})}
				{onAddAccount && (
					<Tooltip content="Add account">
						<button
							type="button"
							aria-label="Add account"
							onClick={onAddAccount}
							className="grid size-9 shrink-0 place-items-center rounded-full text-muted outline-none transition duration-150 hover:bg-hover hover:text-ink active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2"
						>
							<Plus strokeWidth={1.75} className="size-4" />
						</button>
					</Tooltip>
				)}
			</div>
			<div className="grid min-w-0 px-2 text-sm">
				<TextMorph className="truncate font-medium">{shown?.label ?? ""}</TextMorph>
				<TextMorph by="text" className="truncate text-xs text-muted">
					{shown?.detail ?? ""}
				</TextMorph>
			</div>
		</div>
	);
}
