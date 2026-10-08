// SPDX-License-Identifier: Apache-2.0
import { Select } from "@base-ui/react/select";
import { Check, ChevronsUpDown, Layers, Plus } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useRef, useState } from "react";
import { cn, item as itemClass, popup } from "../../lib";
import { Avatar } from "../avatar";
import { Highlight } from "../highlight";

export type Account = { id: string; name: string; email: string; avatarUrl?: string; unread?: boolean };

const add = "__add";

// Unread dot and the chevron/check share one column at the right end, so the dots line up in every row.
const End = ({ unread, children }: { unread?: boolean; children?: ReactNode }) => (
	<span className="flex shrink-0 items-center gap-2 text-muted">
		<span aria-hidden className={cn("size-1.5 rounded-full bg-ink", !unread && "invisible")} />
		<span className="grid size-4 place-items-center">{children}</span>
	</span>
);

const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Everything in the list that moves (rows and separators, not the highlight), and the rows on their own.
function parts(popup: HTMLElement) {
	const list = popup.querySelector('[role="listbox"]');
	const all = [...(list?.children ?? [])].filter(
		(c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains("list-highlight"),
	);
	return { all, rows: all.filter((c) => c.role === "option"), highlight: list?.querySelector(".list-highlight") };
}

// The panel cut down to a single row, i.e. the trigger's tile.
const tile = (popup: HTMLElement, row: HTMLElement) =>
	`inset(${row.offsetTop}px 0 ${popup.offsetHeight - row.offsetTop - row.offsetHeight}px round 8px)`;

// Opening: the panel opens up and down out of the trigger's tile, the other rows fade in from just beside the
// current one. They don't travel the whole way, so they never pile up on top of each other.
function unfold(popup: HTMLElement, from: number) {
	const { all, rows } = parts(popup);
	const anchor = rows[from];
	if (!anchor) return;
	const timing = { duration: 220, easing: ease };
	popup.animate({ clipPath: [tile(popup, anchor), "inset(0 round 8px)"] }, timing);
	for (const el of all) {
		const d = anchor.offsetTop - el.offsetTop;
		if (el !== anchor)
			el.animate({ translate: [`0 ${Math.sign(d) * Math.min(Math.abs(d), 12)}px`, "0 0"], opacity: [0, 1] }, timing);
	}
}

// The popup is still hidden when it opens; unfold once it has a size, which is before its first frame is painted.
function unfoldWhenShown(popup: HTMLElement, from: number) {
	const watch = new ResizeObserver(() => {
		if (!popup.offsetHeight) return;
		watch.disconnect();
		unfold(popup, from);
	});
	watch.observe(popup);
}

// Closing: the other rows fade, the picked one glides onto the trigger while the panel closes around it. The
// trigger's label and unread dot stay hidden until the row has landed, so nothing shows twice; the check fades as the
// trigger's chevron shows through.
function fold(popup: HTMLElement, trigger: HTMLElement | null, from: number, to: number) {
	const { all, rows, highlight } = parts(popup);
	const anchor = rows[from];
	const target = rows[to] ?? anchor;
	if (!anchor || !target) return;
	const timing = { duration: 220, easing: ease, fill: "forwards" as const };
	const bg = getComputedStyle(popup).backgroundColor;
	popup.animate({ clipPath: ["inset(0 round 8px)", tile(popup, anchor)] }, timing);
	const letGo = { backgroundColor: [bg, bg, "transparent"], offset: [0, 0.5, 1] };
	popup.animate(letGo, timing);
	popup.parentElement?.animate({ filter: [getComputedStyle(popup.parentElement).filter, "none"] }, timing);
	highlight?.animate({ opacity: [1, 0] }, { duration: 100, fill: "forwards" });
	for (const el of [trigger?.firstElementChild, trigger?.lastElementChild?.firstElementChild])
		el?.animate({ opacity: [0, 0] }, { duration: timing.duration });
	target.lastElementChild?.lastElementChild?.animate({ opacity: [1, 0] }, timing);
	for (const el of all)
		if (el === target) {
			el.animate(letGo, timing);
			el.animate({ translate: ["0 0", `0 ${anchor.offsetTop - target.offsetTop}px`], zIndex: [1, 1] }, timing);
		} else el.animate({ opacity: [1, 0] }, { ...timing, duration: 120 });
}

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
 * The current account (or all inboxes) with a list of the others. The list unfolds out of the current entry, so it
 * stays exactly where it was, and folds back into whichever entry is picked.
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
	// Read by the animations, which outlive the render they started in: whether the list opened over the trigger,
	// which row sat on it, and which row got picked.
	const motion = useRef({ around: true, from: 0, to: -1, waiting: false });
	const panel = useRef<HTMLDivElement | null>(null);
	// The first time, the popup only mounts after it was asked to open.
	const popupRef = useCallback((el: HTMLDivElement | null) => {
		panel.current = el;
		if (el && motion.current.waiting) {
			motion.current.waiting = false;
			unfoldWhenShown(el, motion.current.from);
		}
	}, []);

	const identity = (id: string) => {
		const e = entries.find((x) => x.id === id) ?? entries[0];
		return e && <Identity {...e} />;
	};

	return (
		<Select.Root
			value={current}
			onOpenChange={(open) => {
				const m = motion.current;
				if (open) {
					const top = trigger.current?.getBoundingClientRect().top ?? 0;
					m.around = top - 8 >= index * 48 + (index ? 9 : 0);
					m.from = index;
					m.to = -1;
					setAround(m.around);
					if (m.around && !still()) {
						if (panel.current) unfoldWhenShown(panel.current, m.from);
						else m.waiting = true;
					}
				} else if (panel.current && m.around && !still())
					fold(panel.current, trigger.current, m.from, m.to < 0 ? m.from : m.to);
			}}
			// The popup stays mounted; a fold left holding its last frame would throw off where Base UI places it next.
			onOpenChangeComplete={(open) => {
				if (!open) for (const a of panel.current?.getAnimations({ subtree: true }) ?? []) a.cancel();
			}}
			onValueChange={(id) => {
				if (id === add) onAddAccount?.();
				else if (id) {
					motion.current.to = entries.findIndex((e) => e.id === id);
					onChange(id);
				}
			}}
		>
			<Select.Trigger
				ref={trigger}
				aria-label="Account"
				className="flex h-12 w-full shrink-0 items-center justify-between gap-2 rounded-md px-2 outline-none transition-colors duration-100 hover:bg-hover open:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink/30"
			>
				<Select.Value className="min-w-0">{identity}</Select.Value>
				<End unread={entries.find((e) => e.id === current)?.unread}>
					<ChevronsUpDown strokeWidth={1.75} className="size-4" />
				</End>
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner
					alignItemWithTrigger={around}
					sideOffset={4}
					className={cn("z-50 outline-none", around && "drop-shadow-xl")}
				>
					<Select.Popup
						ref={popupRef}
						className={cn(
							popup,
							// Rows run edge to edge and there's no border, so the current one lands exactly on the trigger:
							// same width, same corners, no zoom.
							"w-(--anchor-width) overflow-hidden rounded-md border-0 shadow-dialog starting:scale-100 ending:scale-100",
							// Over the trigger it unfolds instead of fading; the shadow moves to the positioner so it follows.
							around && "shadow-none starting:opacity-100 ending:opacity-100",
						)}
					>
						<Select.List className="relative max-h-(--available-height) overflow-y-auto outline-none">
							<Highlight className="rounded-none" />
							{entries.map((e, i) => (
								<Fragment key={e.id}>
									<Select.Item value={e.id} className={cn(itemClass, "h-12 justify-between rounded-none")}>
										<Select.ItemText className="min-w-0">
											<Identity {...e} />
										</Select.ItemText>
										<End unread={e.unread}>
											<Select.ItemIndicator className="text-ink">
												<Check strokeWidth={2} />
											</Select.ItemIndicator>
										</End>
									</Select.Item>
									{i === 0 && <Select.Separator className="h-px bg-line" />}
								</Fragment>
							))}
							{onAddAccount && (
								<>
									<Select.Separator className="h-px bg-line" />
									<Select.Item value={add} className={cn(itemClass, "h-10 gap-2.5 rounded-none text-muted")}>
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
