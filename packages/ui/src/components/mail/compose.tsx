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
	defaultSubject?: string;
	onSend(message: OutgoingMessage): void;
};

let nextId = 0;

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

const formatWhen = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

// One recipient row: contacts as suggestions, anything else typed becomes a chip on Enter or comma
// (marked when it doesn't look like an address).
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
	const names = new Map(contacts.map((c) => [c.email, c.name]));
	const query = input.trim().toLowerCase();
	const matches = (email: string) =>
		email.toLowerCase().includes(query) || (names.get(email) ?? "").toLowerCase().includes(query);
	const add = (raw: string) => {
		const email = raw.trim().replace(/,$/, "");
		if (email && !value.includes(email)) onChange([...value, email]);
		setInput("");
	};

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
				onInputValueChange={setInput}
				filter={(email: string) => matches(email)}
				itemToStringLabel={(email: string) => names.get(email) ?? email}
			>
				<Combobox.Chips className="min-h-10 flex-1 rounded-none border-0 bg-transparent px-0 focus-within:border-0">
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
									onBlur={() => isEmail(input.trim()) && add(input)}
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
export function Composer({ contacts, defaultTo = [], defaultSubject = "", onSend }: ComposerProps) {
	const [to, setTo] = useState(defaultTo);
	const [cc, setCc] = useState<string[]>([]);
	const [bcc, setBcc] = useState<string[]>([]);
	const [showCc, setShowCc] = useState(false);
	const [showBcc, setShowBcc] = useState(false);
	const [subject, setSubject] = useState(defaultSubject);
	const [body, setBody] = useState("");
	const [files, setFiles] = useState<{ id: number; file: File; url?: string }[]>([]);
	const [sendAt, setSendAt] = useState<Date>();
	const [phase, setPhase] = useState<"idle" | "undo" | "done">("idle");
	const [dragging, setDragging] = useState(0);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const picker = useRef<HTMLInputElement>(null);
	const subjectCaret = useCaret<HTMLInputElement>();
	const bodyField = useRef<HTMLTextAreaElement>(null);
	const bodyCaret = useCaret(bodyField);

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
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			for (const f of urls.current) if (f.url) URL.revokeObjectURL(f.url);
		},
		[],
	);

	const attach = (list: FileList | null) => {
		if (!list) return;
		const added = [...list].map((file) => ({
			id: nextId++,
			file,
			url: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
		}));
		setFiles((f) => [...f, ...added]);
	};
	const detach = (id: number) =>
		setFiles((f) => {
			const url = f.find((x) => x.id === id)?.url;
			if (url) URL.revokeObjectURL(url);
			return f.filter((x) => x.id !== id);
		});

	const reset = () => {
		setTo(defaultTo);
		setCc([]);
		setBcc([]);
		setShowCc(false);
		setShowBcc(false);
		setSubject(defaultSubject);
		setBody("");
		for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
		setFiles([]);
		setSendAt(undefined);
		setPhase("idle");
	};

	const deliver = () => {
		onSend({ to, cc, bcc, subject, body, files: files.map((f) => f.file), sendAt });
		setPhase("done");
		timer.current = setTimeout(reset, 1500);
	};

	const canSend = to.length > 0 && [...to, ...cc, ...bcc].every(isEmail);
	const send = () => {
		clearTimeout(timer.current);
		if (phase === "undo") return setPhase("idle");
		if (phase !== "idle" || !canSend) return;
		if (sendAt) return deliver();
		setPhase("undo");
		timer.current = setTimeout(deliver, 5000);
	};

	const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target and ⌘↵ shortcut for the whole composer
		<div
			className="relative grid rounded-lg border border-line bg-raised text-ink shadow-pop"
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
			<Recipients label="To" contacts={contacts} value={to} onChange={setTo}>
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

			<div className="px-3 py-2">
				{bodyCaret.wrap(
					<textarea
						ref={bodyCaret.ref}
						value={body}
						onChange={(e) => setBody(e.target.value)}
						aria-label="Message"
						className={cn(
							"block min-h-40 w-full resize-none bg-transparent text-lg leading-relaxed outline-none placeholder:text-faint",
							bodyCaret.caretClass,
						)}
					/>,
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
					disabled={!canSend && phase === "idle"}
					countdown={phase === "undo" ? 5000 : undefined}
					success={phase === "done" && (sendAt ? "Scheduled" : "Sent")}
					labels={["Undo", "Sent", "Schedule", "Scheduled"]}
					onClick={send}
				>
					{phase === "undo" ? "Undo" : sendAt ? "Schedule" : "Send"}
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

				<Tooltip content="Hold to discard">
					<Button
						size="icon"
						variant="ghost"
						aria-label="Discard"
						className="ml-auto"
						hold={700}
						onHoldComplete={() => {
							clearTimeout(timer.current);
							reset();
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
