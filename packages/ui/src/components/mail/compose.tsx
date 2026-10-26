// SPDX-License-Identifier: Apache-2.0

import { type DragEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Clock, Paperclip, Trash2, X } from "../../icons";
import { cn } from "../../lib";
import { Collapsible } from "../accordion";
import { Button } from "../button";
import { useCaret } from "../caret";
import { Combobox } from "../combobox";
import { TextMorph } from "../text-morph";
import { Tooltip } from "../tooltip";
import { AttachmentTile } from "./attachment";
import { SnoozePicker } from "./snooze-picker";

export type Contact = { name: string; email: string };

export type OutgoingMessage = {
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string;
	files: File[];
	sendAt?: Date;
};

export type ComposerProps = {
	contacts: Contact[];
	defaultTo?: string[];
	defaultCc?: string[];
	defaultBcc?: string[];
	defaultSubject?: string;
	/** e.g. the quoted message when replying. */
	defaultBody?: string;
	/** Files it starts with, like a forwarded message's or a saved draft's. */
	defaultFiles?: File[];
	/** Whether the server took it; false keeps everything as it was, to try again. */
	onSend(message: OutgoingMessage): Promise<boolean> | boolean | void;
	/** Every edit, e.g. to save a draft; the send time isn't part of a draft. */
	onChange?(message: Omit<OutgoingMessage, "sendAt">): void;
	/** The discard button; the fields are cleared either way. */
	onDiscard?(): void;
	/** A forwarded message, shown as a card under the text: who wrote it, about what, its text on a click. */
	original?: { from: string; date: string; subject: string; text: string };
	/** `card` brings its own surface; `plain` fills whatever it's placed in, with the send row at the bottom. */
	variant?: "card" | "plain";
	/** A row above the recipients, e.g. the account it's sent from. */
	from?: React.ReactNode;
	/** Where typing starts: the recipients for a new message, the text for a reply. */
	focus?: "to" | "body";
	/** Recipients and subject start as one line that opens on click, for replies where they're already right. */
	compact?: boolean;
	/** The message being answered: folded behind "•••" under the text and added to it when sending. */
	quote?: string;
	/** Seconds a sent message can still be taken back; 0 sends at once. */
	undo?: number;
};

let nextId = 0;

const entry = (file: File) => ({
	id: nextId++,
	file,
	url: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
});

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

const formatWhen = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

// One recipient row: up to five contacts as suggestions (all of them on request), anything else typed becomes a chip
// on Enter, comma or leaving the field (marked when it doesn't look like an address).
function Recipients({
	label,
	contacts,
	value,
	onChange,
	autoFocus,
	children,
}: {
	label: string;
	contacts: Contact[];
	value: string[];
	onChange(value: string[]): void;
	autoFocus?: boolean;
	children?: React.ReactNode;
}) {
	const [input, setInput] = useState("");
	const [all, setAll] = useState(false);
	const names = new Map(contacts.map((c) => [c.email, c.name]));
	const query = input.trim().toLowerCase();
	const matches = (email: string) =>
		email.toLowerCase().includes(query) || (names.get(email) ?? "").toLowerCase().includes(query);
	const add = (raw: string) => {
		const email = raw.trim().replace(/,$/, "");
		if (email && !value.includes(email)) onChange([...value, email]);
		setInput("");
		setAll(false);
	};
	const found = contacts.filter((c) => !value.includes(c.email) && matches(c.email)).length;

	return (
		<div className="flex items-start gap-2 border-b border-line px-3">
			<span className="w-8 shrink-0 pt-2.5 text-sm text-muted">{label}</span>
			<Combobox.Root
				items={contacts.map((c) => c.email)}
				multiple
				value={value}
				onValueChange={(v) => {
					onChange(v as string[]);
					setInput("");
				}}
				inputValue={input}
				onInputValueChange={(v, details) => {
					// The list clears the field as it closes. Leaving it (Tab, a click elsewhere) turns what was typed into
					// a chip, as Enter does; picking a suggestion (click, Enter on it) doesn't.
					const left = details.event?.type === "focusout" || details.event?.type === "pointerdown";
					if (v === "" && left) add(input);
					else setInput(v);
				}}
				filter={(email: string) => matches(email)}
				limit={all ? undefined : 5}
				itemToStringLabel={(email: string) => names.get(email) ?? email}
			>
				<Combobox.Chips className="min-h-10 flex-1 rounded-none border-0 bg-transparent px-0 focus-within:outline-0">
					<Combobox.Value>
						{(chosen: string[]) => (
							<>
								{chosen.map((email) => (
									<Combobox.Chip
										key={email}
										aria-label={isEmail(email) ? email : `${email}, not a valid address`}
										className={isEmail(email) ? undefined : "bg-danger/15 text-danger"}
									>
										{names.get(email) ?? email}
									</Combobox.Chip>
								))}
								<Combobox.ChipsInput
									aria-label={label}
									autoFocus={autoFocus}
									onKeyDown={(e) => {
										const free = query && !contacts.some((c) => matches(c.email));
										if (e.key === "," || (e.key === "Enter" && free)) {
											e.preventDefault();
											add(input);
										}
									}}
								/>
							</>
						)}
					</Combobox.Value>
				</Combobox.Chips>
				<Combobox.Popup>
					<Combobox.List>
						{(email: string) => (
							<Combobox.Item key={email} value={email}>
								<span className="truncate">{names.get(email)}</span>
								<span className="truncate text-sm text-muted">{email}</span>
							</Combobox.Item>
						)}
					</Combobox.List>
					{!all && found > 5 && (
						<button
							type="button"
							// Keeps the focus in the field, so leaving it doesn't turn the typed text into a chip.
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => setAll(true)}
							className="flex h-8 w-full items-center rounded-md px-2 text-left text-sm text-muted outline-none hover:bg-hover hover:text-ink"
						>
							Show all {found}
						</button>
					)}
				</Combobox.Popup>
			</Combobox.Root>
			{children}
		</div>
	);
}

/**
 * Writing a message. Send waits five seconds with an undo on the button itself; with a time chosen under
 * "Send later" it schedules instead. Files can be attached with the button or dropped anywhere on it.
 */
export function Composer({
	contacts,
	defaultTo = [],
	defaultCc = [],
	defaultBcc = [],
	defaultSubject = "",
	defaultBody = "",
	defaultFiles = [],
	original,
	onSend,
	onChange,
	onDiscard,
	variant = "card",
	from,
	focus,
	compact = false,
	quote = "",
	undo = 5,
}: ComposerProps) {
	const [to, setTo] = useState(defaultTo);
	const [cc, setCc] = useState(defaultCc);
	const [bcc, setBcc] = useState(defaultBcc);
	const [showCc, setShowCc] = useState(defaultCc.length > 0);
	const [showBcc, setShowBcc] = useState(defaultBcc.length > 0);
	const [subject, setSubject] = useState(defaultSubject);
	const [details, setDetails] = useState(!compact);
	const [showQuote, setShowQuote] = useState(false);
	const [body, setBody] = useState(defaultBody);
	const [files, setFiles] = useState<{ id: number; file: File; url?: string }[]>(() => defaultFiles.map(entry));
	const [sendAt, setSendAt] = useState<Date>();
	const [phase, setPhase] = useState<"idle" | "undo" | "sending" | "done">("idle");
	const [dragging, setDragging] = useState(0);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const picker = useRef<HTMLInputElement>(null);
	const subjectCaret = useCaret<HTMLInputElement>();
	const bodyField = useRef<HTMLTextAreaElement>(null);
	// Reports edits only: what the composer opened with isn't a change, also when React runs effects twice.
	const changed = useRef(onChange);
	changed.current = onChange;
	const opened = useRef(
		JSON.stringify({
			to: defaultTo,
			cc: defaultCc,
			bcc: defaultBcc,
			subject: defaultSubject,
			body: defaultBody + quote,
			files: defaultFiles.length,
		}),
	);
	useEffect(() => {
		const now = { to, cc, bcc, subject, body: body + quote };
		if (JSON.stringify({ ...now, files: files.length }) !== opened.current)
			changed.current?.({ ...now, files: files.map((f) => f.file) });
	}, [to, cc, bcc, subject, body, quote, files]);
	const bodyCaret = useCaret(bodyField);

	// A reply starts above the quoted message.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only where the composer opens
	useEffect(() => {
		if (focus !== "body") return;
		bodyField.current?.focus();
		bodyField.current?.setSelectionRange(0, 0);
	}, []);

	// The body grows with its text instead of scrolling inside the composer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
	useLayoutEffect(() => {
		const el = bodyField.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [body]);

	const urls = useRef(files);
	urls.current = files;
	// Closed while Undo still runs: the message goes now, closing doesn't take it back.
	const pendingSend = useRef<() => void>(undefined);
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			pendingSend.current?.();
			for (const f of urls.current) if (f.url) URL.revokeObjectURL(f.url);
		},
		[],
	);

	const attach = (list: FileList | null) => {
		if (!list) return;
		setFiles((f) => [...f, ...[...list].map(entry)]);
	};
	const detach = (id: number) =>
		setFiles((f) => {
			const url = f.find((x) => x.id === id)?.url;
			if (url) URL.revokeObjectURL(url);
			return f.filter((x) => x.id !== id);
		});

	const reset = () => {
		setTo(defaultTo);
		setCc(defaultCc);
		setBcc(defaultBcc);
		setShowCc(defaultCc.length > 0);
		setShowBcc(defaultBcc.length > 0);
		setSubject(defaultSubject);
		setBody(defaultBody);
		setDetails(!compact);
		setShowQuote(false);
		for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
		setFiles(defaultFiles.map(entry));
		setSendAt(undefined);
		setPhase("idle");
	};

	// "Sent" only once the server took it; otherwise everything stays for another try.
	const deliver = async () => {
		pendingSend.current = undefined;
		setPhase("sending");
		const ok = await onSend({ to, cc, bcc, subject, body: body + quote, files: files.map((f) => f.file), sendAt });
		if (ok === false) return setPhase("idle");
		setPhase("done");
		timer.current = setTimeout(reset, 1500);
	};

	const names = new Map(contacts.map((c) => [c.email, c.name]));
	const canSend = [...to, ...cc, ...bcc].length > 0 && [...to, ...cc, ...bcc].every(isEmail);
	const send = () => {
		clearTimeout(timer.current);
		if (phase === "undo") {
			pendingSend.current = undefined;
			return setPhase("idle");
		}
		if (phase !== "idle" || !canSend) return;
		if (sendAt || !undo) return void deliver();
		setPhase("undo");
		pendingSend.current = () => void deliver();
		timer.current = setTimeout(() => void deliver(), undo * 1000);
	};

	const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target and ⌘↵ shortcut for the whole composer
		<div
			className={cn(
				"relative text-ink",
				variant === "card" ? "grid rounded-lg border border-line bg-raised shadow-pop" : "flex min-h-0 flex-1 flex-col",
			)}
			onKeyDown={(e) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && phase === "idle") {
					e.preventDefault();
					send();
				}
			}}
			onDragEnter={(e) => hasFiles(e) && setDragging((n) => n + 1)}
			onDragLeave={(e) => hasFiles(e) && setDragging((n) => Math.max(0, n - 1))}
			onDragOver={(e) => hasFiles(e) && e.preventDefault()}
			onDrop={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				setDragging(0);
				attach(e.dataTransfer.files);
			}}
		>
			{from && <div className="flex h-10 items-center gap-2 border-b border-line px-3 text-sm text-muted">{from}</div>}
			{!details && (
				<button
					type="button"
					onClick={() => setDetails(true)}
					className="flex h-10 items-center gap-2 border-b border-line px-3 text-left text-sm outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2"
				>
					<span className="w-8 shrink-0 text-muted">To</span>
					<span className="shrink-0">{[...to, ...cc].map((e) => names.get(e) ?? e).join(", ")}</span>
					<span className="min-w-0 flex-1 truncate text-muted">{subject}</span>
				</button>
			)}
			<Collapsible.Root open={details}>
				<Collapsible.Panel>
					<Recipients label="To" contacts={contacts} value={to} onChange={setTo} autoFocus={focus === "to"}>
						<div className="flex shrink-0 gap-1 pt-2">
							{!showCc && (
								<Button size="sm" variant="ghost" onClick={() => setShowCc(true)}>
									Cc
								</Button>
							)}
							{!showBcc && (
								<Button size="sm" variant="ghost" onClick={() => setShowBcc(true)}>
									Bcc
								</Button>
							)}
						</div>
					</Recipients>
					<Collapsible.Root open={showCc}>
						<Collapsible.Panel>
							<Recipients label="Cc" contacts={contacts} value={cc} onChange={setCc} autoFocus />
						</Collapsible.Panel>
					</Collapsible.Root>
					<Collapsible.Root open={showBcc}>
						<Collapsible.Panel>
							<Recipients label="Bcc" contacts={contacts} value={bcc} onChange={setBcc} autoFocus />
						</Collapsible.Panel>
					</Collapsible.Root>

					<div className="border-b border-line px-3">
						{subjectCaret.wrap(
							<input
								ref={subjectCaret.ref}
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
								placeholder="Subject"
								aria-label="Subject"
								className={cn(
									"h-10 w-full bg-transparent font-medium outline-none placeholder:text-faint",
									subjectCaret.caretClass,
								)}
							/>,
						)}
					</div>
				</Collapsible.Panel>
			</Collapsible.Root>

			<div className={cn("px-3 py-2", variant === "plain" && "min-h-0 flex-1 overflow-y-auto")}>
				{bodyCaret.wrap(
					<textarea
						ref={bodyCaret.ref}
						placeholder="Write something"
						value={body}
						onChange={(e) => setBody(e.target.value)}
						aria-label="Message"
						className={cn(
							"block w-full resize-none bg-transparent text-lg leading-relaxed outline-none placeholder:text-faint",
							variant === "card" ? "min-h-40" : "min-h-24",
							bodyCaret.caretClass,
						)}
					/>,
				)}
				{quote && (
					<>
						<button
							type="button"
							aria-label={showQuote ? "Hide quoted text" : "Show quoted text"}
							aria-expanded={showQuote}
							onClick={() => setShowQuote((q) => !q)}
							className="inline-flex h-5 items-center rounded-full bg-hover px-2 text-xs text-muted outline-none transition-colors duration-100 hover:bg-selected hover:text-ink focus-visible:outline-2"
						>
							•••
						</button>
						{showQuote && <p className="mt-2 text-sm whitespace-pre-wrap text-muted">{quote.trim()}</p>}
					</>
				)}
				{original && (
					<div className="mt-2 rounded-md bg-sunken">
						<button
							type="button"
							aria-expanded={showQuote}
							onClick={() => setShowQuote((q) => !q)}
							className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left outline-none focus-visible:outline-2"
						>
							<span className="text-sm font-medium">{original.subject || "(no subject)"}</span>
							<span className="text-xs text-muted">
								Forwarded · from {original.from} · {original.date}
							</span>
						</button>
						{showQuote && <p className="px-3 pb-3 text-sm whitespace-pre-wrap text-muted">{original.text}</p>}
					</div>
				)}
			</div>

			{files.length > 0 && (
				<div className="flex flex-wrap gap-2 px-3 pb-3">
					{files.map(({ id, file, url }) => (
						<AttachmentTile
							key={id}
							name={file.name}
							size={file.size}
							type={file.type}
							previewUrl={url}
							onRemove={() => detach(id)}
						/>
					))}
				</div>
			)}

			<div className="flex items-center gap-1 border-t border-line px-3 py-2">
				<Button
					variant="primary"
					disabled={(!canSend && phase === "idle") || phase === "sending"}
					countdown={phase === "undo" ? undo * 1000 : undefined}
					success={phase === "done" && (sendAt ? "Scheduled" : "Sent")}
					labels={["Undo", "Sent", "Schedule", "Scheduled", "Sending"]}
					onClick={send}
				>
					{phase === "undo" ? "Undo" : phase === "sending" ? "Sending" : sendAt ? "Schedule" : "Send"}
				</Button>
				<span className="ml-1 text-sm text-muted">
					<TextMorph by="text">{sendAt ? formatWhen(sendAt) : ""}</TextMorph>
				</span>
				{sendAt && (
					<Tooltip content="Send right away instead">
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Send right away instead"
							onClick={() => setSendAt(undefined)}
						>
							<X strokeWidth={1.75} />
						</Button>
					</Tooltip>
				)}

				<Tooltip content="Send later">
					<SnoozePicker
						onSnooze={setSendAt}
						trigger={
							<Button size="icon" variant="ghost" aria-label="Send later">
								<Clock strokeWidth={1.75} />
							</Button>
						}
					/>
				</Tooltip>

				<Tooltip content="Attach files">
					<Button size="icon" variant="ghost" aria-label="Attach files" onClick={() => picker.current?.click()}>
						<Paperclip strokeWidth={1.75} />
					</Button>
				</Tooltip>
				<input
					ref={picker}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						attach(e.target.files);
						e.target.value = "";
					}}
				/>

				<Tooltip content="Discard">
					<Button
						size="icon"
						variant="ghost"
						aria-label="Discard"
						className="ml-auto"
						disabled={phase !== "idle"}
						onClick={() => {
							clearTimeout(timer.current);
							reset();
							onDiscard?.();
						}}
					>
						<Trash2 strokeWidth={1.75} />
					</Button>
				</Tooltip>
			</div>

			<div
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-1 grid place-items-center rounded-md border border-dashed border-line-strong bg-raised text-muted opacity-0 transition-opacity duration-150",
					dragging > 0 && "opacity-95",
				)}
			>
				Drop to attach
			</div>
		</div>
	);
}
