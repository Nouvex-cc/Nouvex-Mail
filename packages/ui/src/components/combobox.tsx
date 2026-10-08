// SPDX-License-Identifier: Apache-2.0
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn, field, item, label, popup, type Styled } from "../lib";
import { Highlight } from "./highlight";

// Chips appear and leave quickly without blocking anything: a new chip scales in, a removed one leaves a short-lived
// copy that fades out where it was, and everything else glides to its new place.
function useChipMotion() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const box = ref.current;
		if (!box) return;
		const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
		const ghost = (n: Node) => n instanceof HTMLElement && "ghost" in n.dataset;
		// Layout positions, not on-screen ones: a glide in progress must not look like a change to the next update,
		// or React's follow-up commits would restart it from the wrong place.
		let positions = new Map<Element, { x: number; y: number }>();
		const snap = () => {
			positions = new Map();
			for (const c of box.children)
				if (c instanceof HTMLElement && !ghost(c)) positions.set(c, { x: c.offsetLeft, y: c.offsetTop });
		};

		const watch = new MutationObserver((records) => {
			if (matchMedia("(prefers-reduced-motion: reduce)").matches) return snap();
			for (const record of records) {
				for (const n of record.removedNodes) {
					const old = positions.get(n as Element);
					if (!(n instanceof HTMLElement) || ghost(n) || !old) continue;
					const copy = n.cloneNode(true) as HTMLElement;
					copy.dataset.ghost = "";
					copy.inert = true;
					copy.setAttribute("aria-hidden", "true");
					Object.assign(copy.style, { position: "absolute", margin: "0", left: `${old.x}px`, top: `${old.y}px` });
					box.append(copy);
					copy.animate(
						{ opacity: [1, 0], scale: [1, 0.9] },
						{ duration: 120, easing: "ease-in", fill: "forwards" },
					).onfinish = () => copy.remove();
				}
				for (const n of record.addedNodes)
					if (n instanceof HTMLElement && !ghost(n) && n.tagName !== "INPUT")
						n.animate({ opacity: [0, 1], scale: [0.9, 1] }, { duration: 140, easing });
			}
			for (const c of box.children) {
				const old = positions.get(c);
				if (!(c instanceof HTMLElement) || ghost(c) || !old) continue;
				const dx = old.x - c.offsetLeft;
				const dy = old.y - c.offsetTop;
				if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
				// Start from where it is on screen, which includes a glide that's still running.
				const running = new DOMMatrix(getComputedStyle(c).transform);
				for (const a of c.getAnimations()) if (a.id === "glide") a.cancel();
				c.animate(
					{ transform: [`translate(${dx + running.e}px, ${dy + running.f}px)`, "none"] },
					{ duration: 160, easing, id: "glide" },
				);
			}
			snap();
		});
		watch.observe(box, { childList: true });
		const resize = new ResizeObserver(snap);
		resize.observe(box);
		snap();
		return () => {
			watch.disconnect();
			resize.disconnect();
		};
	}, []);
	return ref;
}

function Chips({ className, ...props }: Styled<BaseCombobox.Chips.Props>) {
	const ref = useChipMotion();
	return (
		<BaseCombobox.Chips
			ref={ref}
			className={cn(
				"relative flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line-strong bg-paper px-1.5 py-1 focus-within:border-ink [&_input]:h-6 [&_input]:min-w-16 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:px-1 [&_input]:outline-none [&_input]:placeholder:text-faint",
				className,
			)}
			{...props}
		/>
	);
}

// Multiple selection: wrap Chips around Chip items plus the Input, inside <Combobox.Value>{(v) => ...}</Combobox.Value>.
export const Combobox = {
	Root: BaseCombobox.Root,
	Value: BaseCombobox.Value,
	Input: ({ className, ...props }: Styled<BaseCombobox.Input.Props>) => (
		<BaseCombobox.Input className={cn(field, className)} {...props} />
	),
	Chips,
	// Unstyled input that sits inside Chips; Chips styles it.
	ChipsInput: BaseCombobox.Input,
	Chip: ({ className, children, ...props }: Styled<BaseCombobox.Chip.Props>) => (
		<BaseCombobox.Chip
			className={cn(
				"flex h-6 cursor-default items-center gap-1 rounded-sm bg-selected pr-0.5 pl-2 text-sm outline-none highlighted:bg-ink highlighted:text-on-ink focus-within:bg-ink focus-within:text-on-ink",
				className,
			)}
			{...props}
		>
			{children}
			<BaseCombobox.ChipRemove className="grid size-5 place-items-center rounded-sm hover:bg-hover hover:text-ink">
				<X className="size-3.5" strokeWidth={1.75} />
			</BaseCombobox.ChipRemove>
		</BaseCombobox.Chip>
	),
	Popup: ({ className, children, ...props }: Styled<BaseCombobox.Popup.Props>) => (
		<BaseCombobox.Portal>
			<BaseCombobox.Positioner sideOffset={4} className="outline-none">
				<BaseCombobox.Popup
					className={cn(
						popup,
						"relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) overflow-y-auto overscroll-contain p-1",
						className,
					)}
					{...props}
				>
					<Highlight />
					{children}
				</BaseCombobox.Popup>
			</BaseCombobox.Positioner>
		</BaseCombobox.Portal>
	),
	List: ({ className, ...props }: Styled<BaseCombobox.List.Props>) => (
		<BaseCombobox.List className={cn("outline-none data-empty:hidden", className)} {...props} />
	),
	Item: ({ className, children, ...props }: Styled<BaseCombobox.Item.Props>) => (
		<BaseCombobox.Item className={cn(item, className)} {...props}>
			{children}
			<BaseCombobox.ItemIndicator className="ml-auto">
				<Check strokeWidth={1.75} />
			</BaseCombobox.ItemIndicator>
		</BaseCombobox.Item>
	),
	Empty: ({ className, ...props }: Styled<BaseCombobox.Empty.Props>) => (
		<BaseCombobox.Empty className={cn("px-2 py-1.5 text-sm text-muted empty:hidden", className)} {...props} />
	),
	Group: BaseCombobox.Group,
	GroupLabel: ({ className, ...props }: Styled<BaseCombobox.GroupLabel.Props>) => (
		<BaseCombobox.GroupLabel className={cn(label, className)} {...props} />
	),
};
