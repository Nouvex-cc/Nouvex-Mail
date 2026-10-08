// SPDX-License-Identifier: Apache-2.0
import { Select as BaseSelect } from "@base-ui/react/select";
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useRef } from "react";
import { Check, ChevronsUpDown } from "../icons";
import { cn, item, popup, type Styled } from "../lib";
import { Highlight } from "./highlight";

// Over its trigger (data-side="none") the list unfolds from the trigger and folds back into the picked row.
// data-fold-hide: trigger content hidden until that row lands. data-fold-fade: row content that fades on the way.

type Motion = {
	popup: HTMLElement | null;
	trigger: HTMLElement | null;
	anchor: HTMLElement | null;
	picked: boolean;
	waiting: boolean;
};

const MotionContext = createContext<RefObject<Motion> | null>(null);
const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function parts(panel: HTMLElement) {
	const list = panel.querySelector('[role="listbox"]');
	const all = [...(list?.querySelectorAll<HTMLElement>('[role="option"], [role="separator"]') ?? [])];
	return { list, all, rows: all.filter((el) => el.role === "option") };
}

const top = (el: Element) => el.getBoundingClientRect().top;

function tile(panel: HTMLElement, row: HTMLElement) {
	const p = panel.getBoundingClientRect();
	const r = row.getBoundingClientRect();
	return `inset(${r.top - p.top}px 0 ${p.bottom - r.bottom}px round var(--radius-md))`;
}

// Rows only move 12px, so they never pile up on each other.
function unfold(m: Motion) {
	const panel = m.popup;
	if (panel?.dataset.side !== "none") return;
	const { list, all, rows } = parts(panel);
	const anchor = list?.querySelector<HTMLElement>('[role="option"][data-selected]') ?? rows[0];
	if (!anchor) return;
	m.anchor = anchor;
	const timing = { duration: 220, easing: ease };
	panel.animate({ clipPath: [tile(panel, anchor), "inset(0 round var(--radius-md))"] }, timing);
	for (const el of all) {
		const d = top(anchor) - top(el);
		if (el !== anchor)
			el.animate({ translate: [`0 ${Math.sign(d) * Math.min(Math.abs(d), 12)}px`, "0 0"], opacity: [0, 1] }, timing);
	}
}

// The popup is still hidden when it opens; unfold once it has a size, which is before its first frame is painted.
function unfoldWhenShown(m: Motion) {
	const panel = m.popup;
	if (!panel || still()) return;
	const watch = new ResizeObserver(() => {
		if (!panel.offsetHeight) return;
		watch.disconnect();
		unfold(m);
	});
	watch.observe(panel);
}

function fold(m: Motion) {
	const { popup: panel, anchor } = m;
	if (!panel || !anchor || still()) return;
	const { list, all } = parts(panel);
	const target = (m.picked && list?.querySelector<HTMLElement>('[role="option"][data-highlighted]')) || anchor;
	const timing = { duration: 220, easing: ease, fill: "forwards" as const };
	const bg = getComputedStyle(panel).backgroundColor;
	const letGo = { backgroundColor: [bg, bg, "transparent"], offset: [0, 0.5, 1] };
	panel.animate({ clipPath: ["inset(0 round var(--radius-md))", tile(panel, anchor)] }, timing);
	panel.animate(letGo, timing);
	if (panel.parentElement)
		panel.parentElement.animate({ filter: [getComputedStyle(panel.parentElement).filter, "none"] }, timing);
	panel.querySelector(".list-highlight")?.animate({ opacity: [1, 0] }, { duration: 100, fill: "forwards" });
	for (const el of m.trigger?.querySelectorAll("[data-fold-hide]") ?? [])
		el.animate({ opacity: [0, 0] }, { duration: timing.duration });
	for (const el of target.querySelectorAll("[data-fold-fade]")) el.animate({ opacity: [1, 0] }, timing);
	for (const el of all)
		if (el === target) {
			el.animate(letGo, timing);
			el.animate({ translate: ["0 0", `0 ${top(anchor) - top(target)}px`], zIndex: [1, 1] }, timing);
		} else el.animate({ opacity: [1, 0] }, { ...timing, duration: 120 });
}

function Root<Value, Multiple extends boolean | undefined = false>({
	onOpenChange,
	onOpenChangeComplete,
	onValueChange,
	...props
}: BaseSelect.Root.Props<Value, Multiple>) {
	const motion = useRef<Motion>({ popup: null, trigger: null, anchor: null, picked: false, waiting: false });
	return (
		<MotionContext.Provider value={motion}>
			<BaseSelect.Root
				{...props}
				onOpenChange={(open, details) => {
					const m = motion.current;
					if (open) {
						m.picked = false;
						// The first time, the popup only mounts after it was asked to open.
						if (m.popup) unfoldWhenShown(m);
						else m.waiting = true;
					} else fold(m);
					onOpenChange?.(open, details);
				}}
				onValueChange={(value, details) => {
					onValueChange?.(value, details);
					if (!details.isCanceled) motion.current.picked = true;
				}}
				// The popup stays mounted; a fold left holding its last frame would throw off where Base UI places it next.
				onOpenChangeComplete={(open) => {
					if (!open) {
						for (const a of motion.current.popup?.getAnimations({ subtree: true }) ?? []) a.cancel();
						motion.current.anchor = null;
					}
					onOpenChangeComplete?.(open);
				}}
			/>
		</MotionContext.Provider>
	);
}

function useMotionRef(key: "popup" | "trigger") {
	const motion = useContext(MotionContext);
	return useCallback(
		(el: HTMLElement | null) => {
			const m = motion?.current;
			if (!m) return;
			m[key] = el;
			if (key === "popup" && el && m.waiting) {
				m.waiting = false;
				unfoldWhenShown(m);
			}
		},
		[motion, key],
	);
}

function Trigger({
	className,
	placeholder,
	children,
	...props
}: Styled<BaseSelect.Trigger.Props> & {
	placeholder?: string;
	/** Custom content drops the field look (the calendar's month and year). */
	children?: ReactNode;
}) {
	return (
		<BaseSelect.Trigger
			ref={useMotionRef("trigger")}
			className={cn(
				!children &&
					"inline-flex h-8 min-w-36 items-center justify-between gap-2 rounded-md border border-line-strong bg-paper px-3 text-ink outline-none transition-colors duration-100 hover:bg-hover open:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink/30 disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children ?? (
				<>
					<BaseSelect.Value data-fold-hide className="truncate data-placeholder:text-faint" placeholder={placeholder} />
					<BaseSelect.Icon className="text-muted">
						<ChevronsUpDown className="size-4" strokeWidth={1.75} />
					</BaseSelect.Icon>
				</>
			)}
		</BaseSelect.Trigger>
	);
}

function Popup({ className, children, align = true, ...props }: Styled<BaseSelect.Popup.Props> & { align?: boolean }) {
	return (
		<BaseSelect.Portal>
			<BaseSelect.Positioner
				alignItemWithTrigger={align}
				sideOffset={4}
				className="z-50 outline-none data-[side=none]:drop-shadow-xl"
			>
				<BaseSelect.Popup
					ref={useMotionRef("popup")}
					className={cn(
						popup,
						// Base UI places it one border width too high over the trigger, hence translate-y-px.
						"min-w-(--anchor-width) overflow-hidden rounded-md border-line-strong starting:scale-100 ending:scale-100 data-[side=none]:translate-y-px data-[side=none]:border-transparent data-[side=none]:shadow-none data-[side=none]:starting:opacity-100 data-[side=none]:ending:opacity-100",
						className,
					)}
					{...props}
				>
					<BaseSelect.List className="relative max-h-(--available-height) overflow-y-auto outline-none">
						<Highlight className="rounded-none" />
						{children}
					</BaseSelect.List>
				</BaseSelect.Popup>
			</BaseSelect.Positioner>
		</BaseSelect.Portal>
	);
}

export const Select = {
	Root,
	Trigger,
	Popup,
	Item: ({ className, children, ...props }: Styled<BaseSelect.Item.Props>) => (
		<BaseSelect.Item
			className={cn(item, "h-7.5 rounded-none px-3 py-0 data-selected:font-medium", className)}
			{...props}
		>
			<BaseSelect.ItemText>{children}</BaseSelect.ItemText>
			<BaseSelect.ItemIndicator data-fold-fade className="ml-auto pl-4 text-ink">
				<Check strokeWidth={2} />
			</BaseSelect.ItemIndicator>
		</BaseSelect.Item>
	),
	Separator: ({ className, ...props }: Styled<BaseSelect.Separator.Props>) => (
		<BaseSelect.Separator className={cn("my-1 h-px bg-line", className)} {...props} />
	),
};
