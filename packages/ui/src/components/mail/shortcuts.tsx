// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Dialog } from "../dialog";
import { Kbd } from "../kbd";

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

// One step of a shortcut, e.g. "mod+k", "?", "e". "mod" is ⌘ on Apple, Ctrl elsewhere.
function matches(e: KeyboardEvent, step: string) {
	const parts = step.split("+");
	const key = parts.pop();
	const mod = parts.includes("mod");
	if (mod !== (e.metaKey || e.ctrlKey) || parts.includes("alt") !== e.altKey) return false;
	return e.key.toLowerCase() === key;
}

/**
 * Runs `handler` for `keys`: a single key ("e"), a chord ("mod+k") or a sequence ("g i", pressed within 800 ms).
 * Plain keys are ignored while the user is typing in a field; chords with mod always work.
 */
export function useShortcut(keys: string, handler: (e: KeyboardEvent) => void, { enabled = true } = {}) {
	const latest = useRef(handler);
	latest.current = handler;

	useEffect(() => {
		if (!enabled) return;
		const steps = keys.toLowerCase().split(" ");
		let at = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const onKey = (e: KeyboardEvent) => {
			const step = steps[at] ?? "";
			if (typing(e.target) && !step.includes("mod")) return;
			if (!matches(e, step)) {
				at = matches(e, steps[0] ?? "") ? 1 : 0;
				if (at === 0 || steps.length > 1) return;
			} else at++;
			clearTimeout(timer);
			if (at < steps.length) {
				timer = setTimeout(() => {
					at = 0;
				}, 800);
				return;
			}
			at = 0;
			e.preventDefault();
			latest.current(e);
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			clearTimeout(timer);
		};
	}, [keys, enabled]);
}

export type ShortcutGroup = { title: string; items: { keys: string; label: string }[] };

const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const keyLabel = (key: string) =>
	key
		.split("+")
		.map((k) =>
			k === "mod"
				? apple
					? "⌘"
					: "Ctrl"
				: k === "shift"
					? "⇧"
					: k === "enter"
						? "↵"
						: k.length === 1
							? k.toUpperCase()
							: k,
		)
		.join(apple ? "" : "+");

export function ShortcutsDialog({
	open,
	onOpenChange,
	groups,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	groups: ShortcutGroup[];
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Popup className="max-w-2xl">
				<Dialog.Title>Keyboard shortcuts</Dialog.Title>
				<div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
					{groups.map((group) => (
						<section key={group.title} className="grid content-start gap-1">
							<h3 className="text-sm font-medium text-muted">{group.title}</h3>
							{group.items.map((item) => (
								<div key={item.keys} className="flex items-center justify-between gap-4 py-1">
									<span>{item.label}</span>
									<span className="flex shrink-0 items-center gap-1">
										{item.keys.split(" ").map((key, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: a sequence can repeat a key
											<Kbd key={i}>{keyLabel(key)}</Kbd>
										))}
									</span>
								</div>
							))}
						</section>
					))}
				</div>
			</Dialog.Popup>
		</Dialog.Root>
	);
}

// The dialog plus "?" to open it. Render `dialog` once anywhere.
export function useShortcutsDialog(groups: ShortcutGroup[]): { dialog: ReactNode; open: () => void } {
	const [open, setOpen] = useState(false);
	useShortcut("?", () => setOpen(true));
	return { dialog: <ShortcutsDialog open={open} onOpenChange={setOpen} groups={groups} />, open: () => setOpen(true) };
}
