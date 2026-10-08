// SPDX-License-Identifier: Apache-2.0
import { CalendarDays, Mail, Paperclip, Search, Star, User, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { cn, item } from "../../lib";
import { parseDate } from "../../parse-date";
import { useGlide } from "../glide";
import { Highlight } from "../highlight";
import { Kbd } from "../kbd";
import { useShortcut } from "./shortcuts";

export type SearchFilter = { key: string; value: string };
export type SearchQuery = { text: string; filters: SearchFilter[] };
type Chip = SearchFilter & { label: string };
// A suggestion turns the last `words` typed into a chip.
type Suggestion = { chip: Chip; hint?: string; icon: ReactNode; words: number };

const icon = { className: "size-4 text-muted", strokeWidth: 1.75 };
const flags: (Chip & { match: string; icon: ReactNode })[] = [
	{ key: "is", value: "unread", label: "Unread", match: "unread", icon: <Mail {...icon} /> },
	{ key: "is", value: "starred", label: "Starred", match: "starred", icon: <Star {...icon} /> },
	{ key: "has", value: "attachment", label: "Has attachment", match: "attachment", icon: <Paperclip {...icon} /> },
];
const people = { from: "From", to: "To" } as const;
const dates = { after: "after", since: "after", before: "before" } as const;

// Mail being searched is in the past, so "friday" means the last one and "march" this year's or last year's.
function pastDate(value: string) {
	const date = parseDate(value);
	if (!date) return null;
	const today = new Date();
	if (date <= today) return date;
	if (date.getTime() - today.getTime() <= 7 * 864e5) date.setDate(date.getDate() - 7);
	else date.setFullYear(date.getFullYear() - 1);
	return date;
}

function dateChip(key: "after" | "before", value: string): Chip | null {
	const date = pastDate(value);
	if (!date) return null;
	const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	return {
		key,
		value: iso,
		label: `${key === "after" ? "After" : "Before"} ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
	};
}

// Typed operators still work for people who know them: "from:lena@…", "after:friday", "is:unread".
function operatorChip(word: string): Chip | null {
	const at = word.indexOf(":");
	const key = word.slice(0, at).toLowerCase();
	const value = word.slice(at + 1);
	if (at < 1 || !value) return null;
	if (key === "from" || key === "to") return { key, value, label: `${people[key]} ${value}` };
	if (key === "after" || key === "before") return dateChip(key, value);
	return flags.find((f) => f.key === key && f.value === value.toLowerCase()) ?? null;
}

/**
 * Search that reads like you'd say it: "lena", "from lena", "since friday", "unread" offer filters, which become
 * chips. Typed operators (from:, after:, is:, has:) work too. Resting it's a pill; focused it opens into a card with
 * the suggestions, or quick filters while it's empty. "/" focuses it.
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
	const row = useGlide<HTMLDivElement>({ enter: true, leave: true });
	useShortcut("/", () => input.current?.focus());

	const words = text.split(" ");
	const last = (words.at(-1) ?? "").toLowerCase();
	const before = (words.at(-2) ?? "").toLowerCase();
	const has = (c: Chip) => chips.some((x) => x.key === c.key && x.value === c.value);

	const suggestions: Suggestion[] = (() => {
		const person = (key: "from" | "to", query: string, used: number) =>
			contacts
				.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(query))
				.slice(0, 4)
				.map((c) => ({
					chip: { key, value: c.email, label: `${people[key]} ${c.name}` },
					hint: c.email,
					icon: <User {...icon} />,
					words: used,
				}));
		const date = (key: "after" | "before", value: string, used: number): Suggestion[] => {
			const chip = dateChip(key, value);
			return chip ? [{ chip, icon: <CalendarDays {...icon} />, words: used }] : [];
		};
		if (!text && !chips.length) return flags.map(({ match, icon, ...chip }) => ({ chip, icon, words: 0 }));
		if (Object.hasOwn(people, before)) return person(before as "from" | "to", last, 2);
		if (Object.hasOwn(people, last)) return person(last as "from" | "to", "", 1);
		if (Object.hasOwn(dates, before) && last) return date(dates[before as keyof typeof dates], last, 2);
		if (last.length < 2 || last.includes(":")) return [];
		return [
			...flags.filter((f) => f.match.startsWith(last)).map(({ match, icon, ...chip }) => ({ chip, icon, words: 1 })),
			...person("from", last, 1).slice(0, 3),
			...(pastDate(last) ? [...date("after", last, 1), ...date("before", last, 1)] : []),
		];
	})().filter((s) => !has(s.chip));
	const open = focused && suggestions.length > 0;
	const pick = Math.min(active, suggestions.length - 1);

	const commit = (next: Chip[], nextText: string) => {
		setChips(next);
		setText(nextText);
		setActive(0);
		onSearch({ text: nextText.trim(), filters: next.map(({ key, value }) => ({ key, value })) });
	};
	const choose = (s: Suggestion) => {
		const kept = s.words ? words.slice(0, -s.words).join(" ") : text;
		commit([...chips, s.chip], kept ? `${kept} ` : "");
		input.current?.focus();
	};

	return (
		<div className={cn("relative h-9", className)}>
			{/* Resting it's a pill; focused, the same surface lifts and opens downward into the suggestions. */}
			<search
				data-focused={focused || undefined}
				className="absolute inset-x-0 top-0 z-30 overflow-hidden rounded-xl bg-paper transition duration-200 data-focused:bg-raised data-focused:shadow-dialog"
				onFocus={() => setFocused(true)}
				onBlur={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
				}}
			>
				<div className="flex min-h-9 items-start pr-1.5">
					<div
						ref={row}
						className="flex flex-1 cursor-text flex-wrap items-center gap-1 py-1.5 pl-3"
						onPointerDown={(e) => {
							if (e.target === e.currentTarget) {
								e.preventDefault();
								input.current?.focus();
							}
						}}
					>
						<Search {...icon} className="pointer-events-none mr-1 size-4 shrink-0 text-muted" />
						{chips.map((chip, i) => (
							<span
								key={`${chip.key}:${chip.value}`}
								className="flex h-6 items-center gap-0.5 rounded-full bg-selected pr-0.5 pl-2.5 text-sm"
							>
								{chip.label}
								<button
									type="button"
									aria-label={`Remove ${chip.label}`}
									onClick={() => commit(chips.toSpliced(i, 1), text)}
									className="grid size-5 place-items-center rounded-full text-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2"
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
							onChange={(e) => {
								const value = e.target.value;
								// A finished "key:value " becomes a chip as soon as the space is typed.
								if (value.endsWith(" ")) {
									const typed = value.trimEnd().split(" ");
									const chip = operatorChip(typed.at(-1) ?? "");
									if (chip && !has(chip)) {
										const kept = typed.slice(0, -1).join(" ");
										return commit([...chips, chip], kept ? `${kept} ` : "");
									}
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
									const s = open ? suggestions[pick] : undefined;
									if (s) return choose(s);
									const chip = operatorChip(words.at(-1) ?? "");
									commit(chip ? [...chips, chip] : chips, chip ? words.slice(0, -1).join(" ") : text);
								} else if (e.key === "Backspace" && !text && chips.length) commit(chips.slice(0, -1), "");
								else if (e.key === "Escape") input.current?.blur();
							}}
						/>
					</div>
					{focused && (text || chips.length > 0) ? (
						<button
							type="button"
							aria-label="Clear search"
							onPointerDown={(e) => e.preventDefault()}
							onClick={() => commit([], "")}
							className="mt-1.5 grid size-6 shrink-0 place-items-center rounded-full text-muted outline-none hover:bg-hover hover:text-ink"
						>
							<X className="size-4" strokeWidth={1.75} />
						</button>
					) : (
						!focused && !text && !chips.length && <Kbd className="mt-2 mr-1 shrink-0">/</Kbd>
					)}
				</div>
				<div data-open={open || undefined} inert={!open} className="fold-panel">
					<div>
						<div role="listbox" className="relative border-t border-line p-1.5">
							<Highlight className="rounded-md" />
							{suggestions.map((s, i) => (
								<div
									key={`${s.chip.key}:${s.chip.value}`}
									role="option"
									aria-selected={i === pick}
									tabIndex={-1}
									data-highlighted={i === pick || undefined}
									onPointerMove={() => setActive(i)}
									onPointerDown={(e) => {
										e.preventDefault();
										choose(s);
									}}
									className={cn(item, "gap-2.5")}
								>
									{s.icon}
									<span className="flex-1 truncate">{s.chip.label}</span>
									{s.hint && <span className="truncate text-sm text-muted">{s.hint}</span>}
								</div>
							))}
						</div>
					</div>
				</div>
			</search>
		</div>
	);
}
