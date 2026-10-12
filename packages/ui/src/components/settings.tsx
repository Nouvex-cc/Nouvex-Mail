// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useRef, useState } from "react";
import { Search as SearchIcon, X } from "../icons";
import { cn, item } from "../lib";
import { Highlight } from "./highlight";
import { Kbd } from "./kbd";
import { useShortcut } from "./mail/shortcuts";

function Page({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="mx-auto grid max-w-2xl content-start gap-10 px-6 pt-8 pb-24">
			<h1 className="text-2xl font-semibold">{title}</h1>
			{children}
		</div>
	);
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
	return (
		<section className="grid gap-1">
			{title && <h2 className="text-sm font-medium text-muted">{title}</h2>}
			<div className="grid">{children}</div>
		</section>
	);
}

/**
 * One setting: label and hint on the left, its control on the right, or below them with `stack` for wide controls.
 * `id` makes it a deep link target (see flash).
 */
function Row({
	id,
	label,
	hint,
	stack,
	children,
}: {
	id?: string;
	label: ReactNode;
	hint?: ReactNode;
	stack?: boolean;
	children?: ReactNode;
}) {
	return (
		<div
			id={id}
			className={cn(
				"-mx-3 flex scroll-mt-8 gap-x-6 gap-y-3 rounded-lg px-3 py-4 transition-colors duration-700 ease-out data-flash:bg-accent-soft data-flash:duration-150",
				stack ? "flex-col" : "items-center justify-between",
			)}
		>
			<div className="grid min-w-0 gap-0.5">
				<span className="font-medium">{label}</span>
				{hint && <span className="text-sm text-muted">{hint}</span>}
			</div>
			{children && <div className={stack ? "grid gap-3" : "flex shrink-0 items-center gap-2"}>{children}</div>}
		</div>
	);
}

/** Scrolls to the row with this id and lights it up briefly. */
export function flash(id: string) {
	const row = document.getElementById(id);
	if (!row) return;
	row.scrollIntoView({ block: "center", behavior: "smooth" });
	row.dataset.flash = "";
	setTimeout(() => delete row.dataset.flash, 1200);
}

export type SettingsResult = { key: string; label: string; where: string; icon?: ReactNode };

/** The header search on the settings page: same pill as the mail search, results fold out under it. "/" focuses it. */
function Search({
	query,
	onQuery,
	results,
	onPick,
	className,
}: {
	query: string;
	onQuery: (query: string) => void;
	results: SettingsResult[];
	onPick: (result: SettingsResult) => void;
	className?: string;
}) {
	const [focused, setFocused] = useState(false);
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	useShortcut("/", () => input.current?.focus());
	const open = focused && query.length > 0;
	const pick = Math.min(active, results.length - 1);
	const choose = (r: SettingsResult) => {
		onPick(r);
		onQuery("");
		input.current?.blur();
	};

	return (
		<div className={cn("relative h-9", className)}>
			<search
				data-focused={focused || undefined}
				className="absolute inset-x-0 top-0 z-30 overflow-hidden rounded-xl bg-paper transition duration-200 data-focused:bg-raised data-focused:shadow-dialog"
				onFocus={() => setFocused(true)}
				onBlur={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
				}}
			>
				<div className="flex h-9 items-center gap-1 pr-1.5 pl-3">
					<SearchIcon strokeWidth={1.75} className="pointer-events-none mr-1 size-4 shrink-0 text-muted" />
					<input
						ref={input}
						value={query}
						placeholder="Search settings"
						aria-label="Search settings"
						aria-expanded={open}
						aria-autocomplete="list"
						role="combobox"
						className="h-6 min-w-0 flex-1 bg-transparent px-1 outline-none placeholder:text-faint"
						onChange={(e) => {
							onQuery(e.target.value);
							setActive(0);
						}}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								if (results.length)
									setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
							} else if (e.key === "Enter") {
								const r = results[pick];
								if (r) choose(r);
							} else if (e.key === "Escape") {
								e.stopPropagation();
								if (query) onQuery("");
								else input.current?.blur();
							}
						}}
					/>
					{focused && query ? (
						<button
							type="button"
							aria-label="Clear search"
							onPointerDown={(e) => e.preventDefault()}
							onClick={() => onQuery("")}
							className="grid size-6 shrink-0 place-items-center rounded-full text-muted outline-none hover:bg-hover hover:text-ink"
						>
							<X className="size-4" strokeWidth={1.75} />
						</button>
					) : (
						!focused && <Kbd className="mr-1 shrink-0">/</Kbd>
					)}
				</div>
				<div data-open={open || undefined} inert={!open} className="fold-panel">
					<div>
						<div role="listbox" className="relative border-t border-line p-1.5">
							<Highlight className="rounded-md" />
							{results.map((r, i) => (
								<div
									key={r.key}
									role="option"
									aria-selected={i === pick}
									tabIndex={-1}
									data-highlighted={i === pick || undefined}
									onPointerMove={() => setActive(i)}
									onPointerDown={(e) => {
										e.preventDefault();
										choose(r);
									}}
									className={cn(item, "gap-2.5")}
								>
									{r.icon}
									<span className="flex-1 truncate">{r.label}</span>
									<span className="truncate text-sm text-muted">{r.where}</span>
								</div>
							))}
							{results.length === 0 && <div className="px-2 py-1.5 text-sm text-muted">No setting matches</div>}
						</div>
					</div>
				</div>
			</search>
		</div>
	);
}

export const Settings = { Page, Section, Row, Search };
