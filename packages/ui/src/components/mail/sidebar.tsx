// SPDX-License-Identifier: Apache-2.0
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronsUpDown } from "../../icons";
import { cn } from "../../lib";
import { Collapsible } from "../accordion";
import { Avatar } from "../avatar";
import { Highlight } from "../highlight";
import { Menu } from "../menu";
import { Tooltip } from "../tooltip";
import { type LabelColor, LabelIcon } from "./label";

// Arrow keys move between items across sections, like a list.
function moveFocus(e: KeyboardEvent<HTMLElement>) {
	if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
	const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-sidebar-item]")];
	const at = items.indexOf(document.activeElement as HTMLElement);
	if (at < 0) return;
	e.preventDefault();
	items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
}

function Root({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<nav
			onKeyDown={moveFocus}
			className={cn("relative flex h-full flex-col gap-4 overflow-y-auto bg-sunken p-2", className)}
		>
			{/* One surface slides to the active item, wherever it is in the sidebar. */}
			<Highlight attr="data-active" className="rounded-md bg-accent-soft" />
			{children}
		</nav>
	);
}

function Section({
	title,
	collapsible = false,
	children,
}: {
	title?: string;
	collapsible?: boolean;
	children: ReactNode;
}) {
	if (collapsible && title)
		return (
			<Collapsible.Root defaultOpen>
				<Collapsible.Trigger className="text-xs font-medium text-muted">{title}</Collapsible.Trigger>
				<Collapsible.Panel>
					<div className="grid grid-cols-1 gap-px pt-0.5">{children}</div>
				</Collapsible.Panel>
			</Collapsible.Root>
		);
	return (
		// One column that can't grow, so long names truncate instead of widening the sidebar.
		<div className="grid grid-cols-1 gap-px">
			{title && <div className="px-2 py-1 text-xs font-medium text-muted">{title}</div>}
			{children}
		</div>
	);
}

export type SidebarItemProps = {
	icon?: ReactNode;
	label: string;
	active?: boolean;
	unread?: boolean;
	/** Only where the number matters (drafts, not unread mail). */
	count?: number;
	shortcut?: string;
	/** Part of the item above it (Promotions under Inbox): no icon, the label lines up with the one above. */
	inset?: boolean;
	onSelect?: () => void;
};

function Item({ icon, label, active, unread, count, shortcut, inset, onSelect }: SidebarItemProps) {
	const button = (
		<button
			type="button"
			data-sidebar-item=""
			data-active={active || undefined}
			aria-current={active ? "page" : undefined}
			onClick={onSelect}
			className={cn(
				"relative flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-muted outline-none transition duration-100 select-none focus-visible:outline-2 focus-visible:-outline-offset-2 active:scale-98 data-active:font-medium data-active:text-accent-text [&:not([data-active])]:hover:bg-hover [&:not([data-active])]:hover:text-ink [&_svg]:size-4 [&_svg]:shrink-0",
				inset && "pl-8.5",
			)}
		>
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{unread && (
				<span className="size-1.5 shrink-0 rounded-full bg-accent">
					<span className="sr-only">Unread</span>
				</span>
			)}
			{count !== undefined && count > 0 && <span className="text-xs text-muted tabular-nums">{count}</span>}
		</button>
	);
	return shortcut ? (
		<Tooltip content={label} shortcut={shortcut} side="right">
			{button}
		</Tooltip>
	) : (
		button
	);
}

function Label({ color, ...props }: Omit<SidebarItemProps, "icon"> & { color: LabelColor }) {
	return <Item {...props} icon={<LabelIcon color={color} />} />;
}

/**
 * The signed-in person at the bottom of the sidebar, opening a menu above it; pass Menu.Items as children
 * (settings, sign out).
 */
function Profile({ name, email, children }: { name: string; email: string; children: ReactNode }) {
	return (
		<Menu.Root>
			<Menu.Trigger className="mt-auto flex peer-data-now:mt-0 h-12 w-full shrink-0 items-center justify-between gap-2 rounded-md px-2 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink/30 data-popup-open:bg-hover">
				<span className="flex min-w-0 items-center gap-2.5">
					<Avatar name={name} />
					<span className="grid min-w-0">
						<span className="truncate text-sm font-medium">{name}</span>
						<span className="truncate text-xs text-muted">{email}</span>
					</span>
				</span>
				<ChevronsUpDown strokeWidth={1.75} className="size-4 shrink-0 text-muted" />
			</Menu.Trigger>
			<Menu.Popup side="top" className="w-(--anchor-width)">
				{children}
			</Menu.Popup>
		</Menu.Root>
	);
}

/** Cards for what needs doing now (a sign-in code, a meeting about to start), at the bottom above Profile. */
function Now({ children }: { children: ReactNode }) {
	return (
		<div data-now className="peer mt-auto grid gap-1.5">
			{children}
		</div>
	);
}

/** One thing to act on: what it is, from whom or when, and a button that does it. Clicking the rest opens it. */
function Card({
	title,
	detail,
	action,
	onOpen,
}: {
	title: string;
	detail: string;
	action: ReactNode;
	onOpen?: () => void;
}) {
	return (
		<div className="flex items-center gap-2 rounded-lg border border-line bg-paper py-2 pr-2 pl-3">
			<button
				type="button"
				onClick={onOpen}
				className="grid min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
			>
				<span className="truncate text-xs text-muted">{detail}</span>
				<span className="truncate text-sm font-medium tabular-nums">{title}</span>
			</button>
			{action}
		</div>
	);
}

export const Sidebar = { Root, Section, Item, Label, Now, Card, Profile };
