// SPDX-License-Identifier: Apache-2.0
import { Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { cn, item, popup } from "../../lib";
import { parseDate } from "../../parse-date";
import { useGlide } from "../glide";
import { Highlight } from "../highlight";
import { useShortcut } from "./shortcuts";

export type SearchFilter = { key: string; value: string };
export type SearchQuery = { text: string; filters: SearchFilter[] };
type Chip = SearchFilter & { label: string };

const operators = [
	{ text: "from:", hint: "Sender" },
	{ text: "to:", hint: "Recipient" },
	{ text: "has:attachment", hint: "With attachments" },
	{ text: "is:unread", hint: "Unread" },
	{ text: "is:starred", hint: "Starred" },
	{ text: "before:", hint: "Date" },
	{ text: "after:", hint: "Date" },
	{ text: "in:", hint: "Folder" },
];
const keys = new Set(operators.map((o) => o.text.split(":")[0]));

// "key:value" → a chip, or null while it isn't one yet (unknown key, empty value, a date that doesn't parse).
function toChip(word: string): Chip | null {
	const at = word.indexOf(":");
	const key = word.slice(0, at).toLowerCase();
	const value = word.slice(at + 1);
	if (at < 1 || !value || !keys.has(key)) return null;
	if (key === "before" || key === "after") {
		const date = parseDate(value);
		if (!date) return null;
		const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		return { key, value: iso, label: date.toLocaleDateString(undefined, { dateStyle: "medium" }) };
	}
	return { key, value, label: value };
}

type Suggestion = { text: string; hint: string; chip?: Chip };

/**
 * Search with filters: typing an operator and a value ("from:lena", "after:friday") and then space or Enter turns
 * it into a chip inside the field. While the last word looks like an operator, suggestions show operators and,
 * for from:/to:, matching contacts. "/" focuses the field.
 */
export function SearchField({
	onSearch,
	contacts = [],
	className,
}: {
	onSearch: (query: SearchQuery) => void;
	contacts?: { name: string; email: string }[];
	className?: string;
}) {
	const [chips, setChips] = useState<Chip[]>([]);
	const [text, setText] = useState("");
	const [active, setActive] = useState(0);
	const [focused, setFocused] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const box = useGlide<HTMLDivElement>({ enter: true, leave: true });
	useShortcut("/", () => input.current?.focus());

	const words = text.split(" ");
	const last = words.at(-1) ?? "";
	const rest = words.slice(0, -1).join(" ");

	const suggestions: Suggestion[] = (() => {
		if (!last) return [];
		const [key = "", value] = last.toLowerCase().split(":");
		if ((key === "from" || key === "to") && value !== undefined)
			return contacts
				.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(value))
				.slice(0, 5)
				.map((c) => ({ text: c.name, hint: c.email, chip: { key, value: c.email, label: c.name } }));
		if (value !== undefined) return [];
		return operators.filter((o) => o.text.startsWith(key) && o.text !== key);
	})();
	const open = focused && suggestions.length > 0;

	const commit = (next: Chip[], nextText: string) => {
		setChips(next);
		setText(nextText);
		setActive(0);
		onSearch({ text: nextText.trim(), filters: next.map(({ key, value }) => ({ key, value })) });
	};

	const pick = (s: Suggestion) => {
		if (s.chip) commit([...chips, s.chip], rest ? `${rest} ` : "");
		else if (s.text.endsWith(":")) setText(rest ? `${rest} ${s.text}` : s.text);
		else {
			const chip = toChip(s.text);
			if (chip) commit([...chips, chip], rest ? `${rest} ` : "");
		}
		input.current?.focus();
	};

	return (
		<div className={cn("relative", className)}>
			<div
				ref={box}
				className="relative flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line-strong bg-paper py-1 pr-1.5 pl-8 transition-colors duration-150 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink/30"
				onPointerDown={(e) => {
					if (e.target === e.currentTarget) {
						e.preventDefault();
						input.current?.focus();
					}
				}}
			>
				<Search strokeWidth={1.75} className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted" />
				{chips.map((chip, i) => (
					<span
						key={`${chip.key}:${chip.value}`}
						className="flex h-6 items-center gap-1 rounded-sm bg-selected pr-0.5 pl-2 text-sm"
					>
						<span className="text-muted">{chip.key}:</span>
						{chip.label}
						<button
							type="button"
							aria-label={`Remove ${chip.key} ${chip.label}`}
							onClick={() => commit(chips.toSpliced(i, 1), text)}
							className="grid size-5 place-items-center rounded-sm text-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2"
						>
							<X className="size-3.5" strokeWidth={1.75} />
						</button>
					</span>
				))}
				<input
					ref={input}
					value={text}
					placeholder={chips.length ? "" : "Search mail"}
					aria-label="Search mail"
					aria-expanded={open}
					aria-autocomplete="list"
					role="combobox"
					className="h-6 min-w-24 flex-1 bg-transparent px-1 outline-none placeholder:text-faint"
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onChange={(e) => {
						const value = e.target.value;
						// A finished "key:value " becomes a chip as soon as the space is typed.
						if (value.endsWith(" ")) {
							const words = value.trimEnd().split(" ");
							const chip = toChip(words.at(-1) ?? "");
							if (chip) return commit([...chips, chip], words.slice(0, -1).join(" ") + (words.length > 1 ? " " : ""));
						}
						setText(value);
						setActive(0);
					}}
					onKeyDown={(e) => {
						if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
							e.preventDefault();
							setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
						} else if (e.key === "Enter") {
							e.preventDefault();
							const s = open ? suggestions[active] : undefined;
							if (s) return pick(s);
							const chip = toChip(last);
							commit(chip ? [...chips, chip] : chips, chip ? rest : text);
						} else if (e.key === "Backspace" && !text && chips.length) {
							commit(chips.slice(0, -1), "");
						} else if (e.key === "Escape") input.current?.blur();
					}}
				/>
			</div>
			{open && (
				<div role="listbox" className={cn(popup, "absolute inset-x-0 top-full z-50 mt-1 p-1")}>
					<Highlight />
					{suggestions.map((s, i) => (
						<div
							key={s.text + s.hint}
							role="option"
							aria-selected={i === active}
							tabIndex={-1}
							data-highlighted={i === active || undefined}
							onPointerMove={() => setActive(i)}
							onPointerDown={(e) => {
								e.preventDefault();
								pick(s);
							}}
							className={item}
						>
							<span className="flex-1 truncate">{s.text}</span>
							<span className="truncate text-sm text-muted">{s.hint}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
