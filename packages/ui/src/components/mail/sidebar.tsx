// SPDX-License-Identifier: Apache-2.0
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib";
import { Collapsible } from "../accordion";
import { Highlight } from "../highlight";
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
			<Highlight attr="data-active" className="rounded-md bg-selected" />
			{children}
		</nav>
	);
}

function Section({
	title,
	collapsible = false,
	defaultOpen = true,
	children,
}: {
	title?: string;
	collapsible?: boolean;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	if (collapsible && title)
		return (
			<Collapsible.Root defaultOpen={defaultOpen}>
				<Collapsible.Trigger className="text-xs font-medium text-muted">{title}</Collapsible.Trigger>
				<Collapsible.Panel>
					<div className="grid gap-px pt-0.5">{children}</div>
				</Collapsible.Panel>
			</Collapsible.Root>
		);
	return (
		<div className="grid gap-px">
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
	onSelect?: () => void;
};

function Item({ icon, label, active, unread, count, shortcut, onSelect }: SidebarItemProps) {
	const button = (
		<button
			type="button"
			data-sidebar-item=""
			data-active={active || undefined}
			aria-current={active ? "page" : undefined}
			onClick={onSelect}
			className="relative flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-muted outline-none transition duration-100 select-none focus-visible:outline-2 focus-visible:-outline-offset-2 active:scale-98 data-active:font-medium data-active:text-ink [&:not([data-active])]:hover:bg-hover [&:not([data-active])]:hover:text-ink [&_svg]:size-4 [&_svg]:shrink-0"
		>
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{unread && (
				<span className="size-1.5 shrink-0 rounded-full bg-ink">
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

export const Sidebar = { Root, Section, Item, Label };
