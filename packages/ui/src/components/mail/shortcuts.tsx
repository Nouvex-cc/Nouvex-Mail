// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../dialog";
import { Kbd } from "../kbd";

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Runs `handler` when `key` (or one of several, e.g. the digits) is pressed, unless the user is typing in a field.
 * "mod+," also works while typing.
 */
export function useShortcut(key: string | string[], handler: (e: KeyboardEvent) => void) {
	const latest = useRef(handler);
	latest.current = handler;
	const keys = [key].flat().join(" ");

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const hit = keys
				.split(" ")
				.some((k) =>
					k.startsWith("mod+") ? (e.metaKey || e.ctrlKey) && e.key === k.slice(4) : !typing(e.target) && e.key === k,
				);
			if (!hit) return;
			e.preventDefault();
			latest.current(e);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [keys]);
}

export type ShortcutGroup = { title: string; items: { keys: string; label: string }[] };

const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const keyLabel = (key: string) =>
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

// The dialog plus "?" to open it. Render it once anywhere.
export function useShortcutsDialog(groups: ShortcutGroup[]) {
	const [open, setOpen] = useState(false);
	useShortcut("?", () => setOpen(true));
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
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
