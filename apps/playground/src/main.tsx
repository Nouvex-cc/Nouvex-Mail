// SPDX-License-Identifier: AGPL-3.0-only
import {
	Accordion,
	AlertDialog,
	Avatar,
	Button,
	Calendar,
	Checkbox,
	Collapsible,
	Combobox,
	Command,
	CommandDialog,
	ContextMenu,
	DatePicker,
	Dialog,
	Drawer,
	Field,
	Input,
	Kbd,
	Menu,
	Meter,
	OTPField,
	Popover,
	PreviewCard,
	Progress,
	Radio,
	RadioGroup,
	Resizable,
	ScrollArea,
	Select,
	Separator,
	Spinner,
	Switch,
	Tabs,
	Textarea,
	ToastProvider,
	Toggle,
	ToggleGroup,
	Toolbar,
	Tooltip,
	TooltipProvider,
	useToast,
	VirtualList,
} from "@nouvex/ui";
import { Archive, Bold, Clock, Forward, Italic, Reply, Trash2, Underline } from "lucide-react";
import { type ReactNode, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const contacts = ["Lena Hartmann", "Jonas Weber", "Mira Okafor", "Paul Schneider", "Sofia Rossi"];
const commands = ["Archive", "Reply", "Forward", "Snooze", "Mark as unread", "Move to…", "Settings"];
const threads = Array.from({ length: 2000 }, (_, i) => ({
	id: i,
	from: contacts[i % contacts.length] ?? "",
	subject: `Thread ${i + 1}`,
}));

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="grid gap-3 border-t border-line py-6">
			<h2 className="text-sm font-medium text-muted">{title}</h2>
			<div className="flex flex-wrap items-start gap-3">{children}</div>
		</section>
	);
}

function Theme() {
	const [mode, setMode] = useState("system");
	useEffect(() => {
		document.documentElement.classList.remove("light", "dark");
		if (mode !== "system") document.documentElement.classList.add(mode);
	}, [mode]);
	return (
		<ToggleGroup value={[mode]} onValueChange={(v) => v[0] && setMode(v[0])}>
			<Toggle value="system">System</Toggle>
			<Toggle value="light">Light</Toggle>
			<Toggle value="dark">Dark</Toggle>
		</ToggleGroup>
	);
}

function ToastDemo() {
	const toast = useToast();
	return (
		<Button
			onClick={() =>
				toast.add({
					title: "Archived",
					actionProps: { children: "Undo", onClick: () => toast.add({ title: "Moved back to Inbox" }) },
				})
			}
		>
			Archive with undo
		</Button>
	);
}

function CommandDemo() {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpen((o) => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return (
		<>
			<Button onClick={() => setOpen(true)}>
				Command palette <Kbd>⌘K</Kbd>
			</Button>
			<CommandDialog open={open} onOpenChange={setOpen}>
				<Command.Root items={commands}>
					<Command.Input placeholder="Type a command" />
					<Command.Empty>No matching command</Command.Empty>
					<Command.List>
						{(c: string) => (
							<Command.Item key={c} value={c} onClick={() => setOpen(false)}>
								{c}
							</Command.Item>
						)}
					</Command.List>
				</Command.Root>
			</CommandDialog>
		</>
	);
}

function SendDemo() {
	const [state, setState] = useState<"idle" | "undo" | "sent">("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	return (
		<Button
			variant="primary"
			countdown={state === "undo" ? 5000 : undefined}
			success={state === "sent" && "Sent"}
			onClick={() => {
				clearTimeout(timer.current);
				if (state !== "idle") return setState("idle");
				setState("undo");
				timer.current = setTimeout(() => {
					setState("sent");
					timer.current = setTimeout(() => setState("idle"), 1500);
				}, 5000);
			}}
		>
			{state === "undo" ? "Undo" : "Send"}
		</Button>
	);
}

function SaveDraftDemo() {
	const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
	return (
		<Button
			loading={state === "saving"}
			success={state === "saved" && "Saved"}
			onClick={() => {
				setState("saving");
				setTimeout(() => setState("saved"), 900);
				setTimeout(() => setState("idle"), 2500);
			}}
		>
			Save draft
		</Button>
	);
}

function LoadingDemo({
	variant,
	children,
}: {
	variant: "primary" | "secondary" | "ghost" | "danger";
	children: string;
}) {
	const [loading, setLoading] = useState(false);
	return (
		<Button
			variant={variant}
			loading={loading}
			onClick={() => {
				setLoading(true);
				setTimeout(() => setLoading(false), 2500);
			}}
		>
			{children}
		</Button>
	);
}

function App() {
	const [date, setDate] = useState<Date | undefined>();
	return (
		<main className="mx-auto max-w-5xl px-6 py-10">
			<header className="flex flex-wrap items-center justify-between gap-4 pb-6">
				<h1 className="text-2xl font-semibold">Nouvex UI</h1>
				<Theme />
			</header>

			<Section title="Button">
				<SendDemo />
				<SaveDraftDemo />
				<Button variant="ghost">Cancel</Button>
				<Button variant="danger">Delete forever</Button>
				<Button size="sm">Small</Button>
				<Tooltip content="Archive" shortcut="E">
					<Button size="icon" variant="ghost" aria-label="Archive">
						<Archive strokeWidth={1.75} />
					</Button>
				</Tooltip>
				<Button disabled>Disabled</Button>
				<Separator orientation="vertical" />
				<LoadingDemo variant="primary">Send</LoadingDemo>
				<LoadingDemo variant="secondary">Test connection</LoadingDemo>
				<LoadingDemo variant="ghost">Retry</LoadingDemo>
				<LoadingDemo variant="danger">Delete account</LoadingDemo>
				<Button variant="primary" loading>
					Always loading
				</Button>
				<Spinner />
			</Section>

			<Section title="Fields">
				<div className="grid w-80 gap-4">
					<Field.Root>
						<Field.Label>Display name</Field.Label>
						<Field.Control placeholder="Mateo" />
						<Field.Description>Shown to people you write to.</Field.Description>
					</Field.Root>
					<Field.Root invalid>
						<Field.Label>IMAP server</Field.Label>
						<Field.Control defaultValue="imap.example" />
						<Field.Error match>Can't reach imap.example on port 993.</Field.Error>
					</Field.Root>
					<Input placeholder="Plain input" />
					<Textarea placeholder="Signature" />
				</div>
				<div className="grid w-80 gap-4">
					<Combobox.Root items={contacts} multiple defaultValue={["Lena Hartmann"]}>
						<Combobox.Chips>
							<Combobox.Value>
								{(value: string[]) => (
									<>
										{value.map((v) => (
											<Combobox.Chip key={v}>{v}</Combobox.Chip>
										))}
										<Combobox.ChipsInput placeholder="To" />
									</>
								)}
							</Combobox.Value>
						</Combobox.Chips>
						<Combobox.Popup>
							<Combobox.Empty>No contacts found</Combobox.Empty>
							<Combobox.List>
								{(c: string) => (
									<Combobox.Item key={c} value={c}>
										{c}
									</Combobox.Item>
								)}
							</Combobox.List>
						</Combobox.Popup>
					</Combobox.Root>
					<Select.Root items={{ instant: "Instantly", hour: "Every hour", day: "Daily digest" }}>
						<Select.Trigger placeholder="Notifications" />
						<Select.Popup>
							<Select.Item value="instant">Instantly</Select.Item>
							<Select.Item value="hour">Every hour</Select.Item>
							<Select.Item value="day">Daily digest</Select.Item>
						</Select.Popup>
					</Select.Root>
					<OTPField />
					<DatePicker value={date} onChange={setDate} placeholder="Send later" />
				</div>
			</Section>

			<Section title="Choices">
				<label className="flex items-center gap-2">
					<Checkbox defaultChecked /> Show snippets
				</label>
				<label className="flex items-center gap-2">
					<Checkbox indeterminate /> Some selected
				</label>
				<label className="flex items-center gap-2">
					<Switch defaultChecked /> Load remote images
				</label>
				<RadioGroup defaultValue="comfortable">
					<label className="flex items-center gap-2">
						<Radio value="compact" /> Compact
					</label>
					<label className="flex items-center gap-2">
						<Radio value="comfortable" /> Comfortable
					</label>
				</RadioGroup>
				<ToggleGroup multiple>
					<Toggle value="bold" aria-label="Bold">
						<Bold strokeWidth={1.75} />
					</Toggle>
					<Toggle value="italic" aria-label="Italic">
						<Italic strokeWidth={1.75} />
					</Toggle>
					<Toggle value="underline" aria-label="Underline">
						<Underline strokeWidth={1.75} />
					</Toggle>
				</ToggleGroup>
			</Section>

			<Section title="Overlays">
				<Menu.Root>
					<Menu.Trigger render={<Button />}>Menu</Menu.Trigger>
					<Menu.Popup>
						<Menu.Item>
							Reply <Menu.Shortcut>R</Menu.Shortcut>
						</Menu.Item>
						<Menu.Item>
							Forward <Menu.Shortcut>F</Menu.Shortcut>
						</Menu.Item>
						<Menu.Separator />
						<Menu.CheckboxItem defaultChecked>Show snippets</Menu.CheckboxItem>
						<Menu.SubmenuRoot>
							<Menu.SubmenuTrigger>Move to</Menu.SubmenuTrigger>
							<Menu.Popup>
								<Menu.Item>Archive</Menu.Item>
								<Menu.Item>Receipts</Menu.Item>
							</Menu.Popup>
						</Menu.SubmenuRoot>
					</Menu.Popup>
				</Menu.Root>
				<ContextMenu.Root>
					<ContextMenu.Trigger>
						<div className="grid h-20 w-48 place-items-center rounded-md border border-dashed border-line-strong text-sm text-muted">
							Right-click here
						</div>
					</ContextMenu.Trigger>
					<ContextMenu.Popup>
						<Menu.Item>Mark as unread</Menu.Item>
						<Menu.Item>Archive</Menu.Item>
					</ContextMenu.Popup>
				</ContextMenu.Root>
				<Dialog.Root>
					<Dialog.Trigger render={<Button />}>Dialog</Dialog.Trigger>
					<Dialog.Popup>
						<Dialog.Title>Add account</Dialog.Title>
						<Dialog.Description>Nouvex connects over IMAP and SMTP.</Dialog.Description>
						<Field.Root>
							<Field.Label>Email</Field.Label>
							<Field.Control type="email" placeholder="you@example.com" />
						</Field.Root>
						<Dialog.Footer>
							<Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
							<Button variant="primary">Continue</Button>
						</Dialog.Footer>
					</Dialog.Popup>
				</Dialog.Root>
				<AlertDialog.Root>
					<AlertDialog.Trigger render={<Button variant="danger" />}>Alert dialog</AlertDialog.Trigger>
					<AlertDialog.Popup>
						<AlertDialog.Title>Delete 12 messages?</AlertDialog.Title>
						<AlertDialog.Description>They skip the trash and can't be restored.</AlertDialog.Description>
						<AlertDialog.Footer>
							<AlertDialog.Close render={<Button variant="ghost" />}>Cancel</AlertDialog.Close>
							<Button variant="danger">Delete</Button>
						</AlertDialog.Footer>
					</AlertDialog.Popup>
				</AlertDialog.Root>
				<Drawer.Root>
					<Drawer.Trigger render={<Button />}>Drawer</Drawer.Trigger>
					<Drawer.Popup>
						<Drawer.Title>Snooze until</Drawer.Title>
						<Drawer.Description>Pick when this thread comes back.</Drawer.Description>
						<Calendar mode="single" />
					</Drawer.Popup>
				</Drawer.Root>
				<Popover.Root>
					<Popover.Trigger render={<Button />}>Popover</Popover.Trigger>
					<Popover.Popup>
						<Popover.Title>Remote images blocked</Popover.Title>
						<Popover.Description>3 trackers were removed from this message.</Popover.Description>
					</Popover.Popup>
				</Popover.Root>
				<PreviewCard.Root>
					<PreviewCard.Trigger href="#">
						<span className="underline underline-offset-2">Lena Hartmann</span>
					</PreviewCard.Trigger>
					<PreviewCard.Popup>
						<div className="flex items-center gap-3">
							<Avatar name="Lena Hartmann" />
							<div className="grid">
								<span className="font-medium">Lena Hartmann</span>
								<span className="text-sm text-muted">lena@hartmann.example</span>
							</div>
						</div>
					</PreviewCard.Popup>
				</PreviewCard.Root>
				<ToastDemo />
				<CommandDemo />
			</Section>

			<Section title="Display">
				<Avatar name="Lena Hartmann" size="sm" />
				<Avatar name="Jonas Weber" />
				<Avatar name="Mira Okafor" size="lg" />
				<div className="grid w-64 gap-4">
					<Progress value={64} label="Uploading invoice.pdf" />
					<Meter value={42} label="Storage" />
				</div>
				<Tabs.Root defaultValue="general" className="w-80">
					<Tabs.List>
						<Tabs.Tab value="general">General</Tabs.Tab>
						<Tabs.Tab value="accounts">Accounts</Tabs.Tab>
						<Tabs.Tab value="shortcuts">Shortcuts</Tabs.Tab>
					</Tabs.List>
					<Tabs.Panel value="general">
						<p className="pt-3 text-sm text-muted">General settings</p>
					</Tabs.Panel>
					<Tabs.Panel value="accounts">
						<p className="pt-3 text-sm text-muted">Accounts</p>
					</Tabs.Panel>
					<Tabs.Panel value="shortcuts">
						<p className="pt-3 text-sm text-muted">Shortcuts</p>
					</Tabs.Panel>
				</Tabs.Root>
				<Accordion.Root className="w-80">
					<Accordion.Item value="a">
						<Accordion.Trigger>Can I use my own domain?</Accordion.Trigger>
						<Accordion.Panel>Yes, any IMAP account works.</Accordion.Panel>
					</Accordion.Item>
					<Accordion.Item value="b">
						<Accordion.Trigger>Where is my mail stored?</Accordion.Trigger>
						<Accordion.Panel>On your server and cached on your devices.</Accordion.Panel>
					</Accordion.Item>
				</Accordion.Root>
				<Calendar mode="single" />
			</Section>

			<Section title="Mail layout: resizable panes, collapsible folders, virtual list, toolbar">
				<div className="h-120 w-full overflow-hidden rounded-lg border border-line">
					<Resizable.Group orientation="horizontal">
						<Resizable.Panel defaultSize="20%" minSize="12%">
							<ScrollArea className="h-full">
								<div className="min-h-full bg-sunken p-2">
									<Collapsible.Root defaultOpen>
										<Collapsible.Trigger>Personal</Collapsible.Trigger>
										<Collapsible.Panel>
											<div className="grid pl-6 text-sm">
												<span className="py-1">Inbox</span>
												<span className="py-1">Receipts</span>
												<span className="py-1">Travel</span>
											</div>
										</Collapsible.Panel>
									</Collapsible.Root>
								</div>
							</ScrollArea>
						</Resizable.Panel>
						<Resizable.Handle />
						<Resizable.Panel defaultSize="35%" minSize="20%">
							<VirtualList
								className="h-full"
								items={threads}
								estimateSize={56}
								getKey={(t) => t.id}
								renderItem={(t) => (
									<div className="grid h-14 content-center border-b border-line px-3">
										<span className="font-medium">{t.from}</span>
										<span className="text-sm text-muted">{t.subject}</span>
									</div>
								)}
							/>
						</Resizable.Panel>
						<Resizable.Handle />
						<Resizable.Panel>
							<div className="grid gap-3 p-4">
								<Toolbar.Root>
									<Toolbar.Button aria-label="Reply">
										<Reply strokeWidth={1.75} />
									</Toolbar.Button>
									<Toolbar.Button aria-label="Forward">
										<Forward strokeWidth={1.75} />
									</Toolbar.Button>
									<Toolbar.Separator />
									<Toolbar.Button aria-label="Snooze">
										<Clock strokeWidth={1.75} />
									</Toolbar.Button>
									<Toolbar.Button aria-label="Archive">
										<Archive strokeWidth={1.75} />
									</Toolbar.Button>
									<Toolbar.Button aria-label="Delete">
										<Trash2 strokeWidth={1.75} />
									</Toolbar.Button>
								</Toolbar.Root>
								<Separator />
								<h3 className="text-xl font-semibold">Keys for the new flat</h3>
								<p className="text-lg">I left them with the neighbour on the second floor, she is home after six.</p>
							</div>
						</Resizable.Panel>
					</Resizable.Group>
				</div>
			</Section>
		</main>
	);
}

// biome-ignore lint/style/noNonNullAssertion: root is in index.html
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<TooltipProvider>
			<ToastProvider>
				<App />
			</ToastProvider>
		</TooltipProvider>
	</StrictMode>,
);
