// SPDX-License-Identifier: AGPL-3.0-only
import {
	AccountSwitcher,
	AppShell,
	BulkBar,
	Button,
	Menu,
	MessageList,
	MessageRow,
	SearchField,
	type SearchQuery,
	Sidebar,
	useToast,
} from "@nouvex/ui";
import {
	Archive,
	Clock,
	File,
	Folder,
	Inbox as InboxIcon,
	LogOut,
	PenLine,
	Send,
	Settings,
	ShieldAlert,
	Star,
	Trash2,
} from "@nouvex/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { Dexie } from "dexie";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import { AddAccount } from "../add-account";
import { auth } from "../auth";
import { db, type Message } from "../db";
import { body, Reader, text } from "../reader";
import { matches } from "../search";
import { forget, listen, pull, update } from "../sync";
import { type Draft, Write, when } from "../write";

const standard = [
	{ role: "inbox", label: "Inbox", Icon: InboxIcon },
	{ role: "snoozed", label: "Snoozed", Icon: Clock },
	{ role: "archive", label: "Archive", Icon: Archive },
	{ role: "sent", label: "Sent", Icon: Send },
	{ role: "drafts", label: "Drafts", Icon: File },
	{ role: "junk", label: "Junk", Icon: ShieldAlert },
	{ role: "trash", label: "Trash", Icon: Trash2 },
] as const;

const page = 100;

// Rows are conversations; the key is what selection and opening go by.
const keyOf = (m: Message) => m.threadId || m.id;
const key = (thread: Message[]) => (thread[0] ? keyOf(thread[0]) : "");

// The folder and the open conversation live in the URL, so the browser's back button goes from a message to its
// folder and from folder to folder, and a link to a conversation opens it.
type Search = { folder?: string; thread?: string };

export const Route = createFileRoute("/")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		folder: typeof s.folder === "string" ? s.folder : undefined,
		thread: typeof s.thread === "string" ? s.thread : undefined,
	}),
	beforeLoad: async () => {
		const { data } = await auth.getSession();
		if (!data) throw redirect({ to: "/login" });
		return { user: data.user };
	},
	component: Inbox,
});

function Inbox() {
	const { user } = Route.useRouteContext();
	const navigate = useNavigate();
	const [current, setCurrent] = useState("all");
	const search = Route.useSearch();
	const router = useRouter();
	// A role shows that folder of every account in view; the user's own folders are picked by id.
	const folder = search.folder ?? "inbox";
	const setFolder = (f: string) => navigate({ to: "/", search: { folder: f === "inbox" ? undefined : f } });
	const open = search.thread;
	// Opening adds a history entry; closing goes back to it, unless the conversation was opened from a link.
	const opened = useRef(false);
	const setOpen = (thread?: string) => {
		if (thread) {
			opened.current = true;
			navigate({ to: "/", search: { ...search, thread } });
		} else if (opened.current) {
			opened.current = false;
			router.history.back();
		} else navigate({ to: "/", search: { ...search, thread: undefined }, replace: true });
	};
	// While searching, every folder in view counts.
	const [query, setQuery] = useState<SearchQuery>({ text: "", filters: [] });
	const searching = query.text !== "" || query.filters.length > 0;
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState<Draft>();
	const toast = useToast();
	const queryClient = useQueryClient();
	const accounts = useAccounts();
	const ids = (accounts.data ?? []).map((a) => a.id).join();

	useEffect(() => {
		if (!ids) return;
		const list = ids.split(",");
		for (const id of list) void pull(id);
		return listen(
			list,
			(e) =>
				toast.add(
					e.error ? { title: `Couldn't send “${e.subject}”`, description: e.error } : { title: `Sent “${e.subject}”` },
				),
			// A sync that failed or worked again changes the account's error.
			() => void accounts.refetch(),
		);
	}, [ids, toast, accounts.refetch]);

	const boxes =
		useLiveQuery(
			() => (current === "all" ? db.mailboxes.toArray() : db.mailboxes.where("accountId").equals(current).toArray()),
			[current],
		) ?? [];
	// Starred and search look across every folder in view.
	const everywhere = searching || folder === "starred";
	const shown = boxes.filter((b) => everywhere || (b.role ? b.role === folder : b.id === folder)).map((b) => b.id);
	// Only a page of the newest messages is read and rendered; scrolling to the end asks for the next one. Each folder
	// is read newest first through its index, so the cost doesn't grow with the mailbox.
	const [limit, setLimit] = useState(page);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different view starts at the first page again
	useEffect(() => setLimit(page), [shown.join(), query]);
	const messages = useLiveQuery(async () => {
		const inView = new Set(shown);
		if (searching) {
			return db.messages
				.orderBy("sentAt")
				.reverse()
				.filter((m) => inView.has(m.mailboxId) && matches(m, query))
				.limit(limit)
				.toArray();
		}
		if (folder === "starred") {
			return db.messages
				.where("[starred+sentAt]")
				.between([1, Dexie.minKey], [1, Dexie.maxKey])
				.reverse()
				.filter((m) => inView.has(m.mailboxId))
				.limit(limit)
				.toArray();
		}
		const newest = await Promise.all(
			shown.map((id) =>
				db.messages
					.where("[mailboxId+sentAt]")
					.between([id, Dexie.minKey], [id, Dexie.maxKey])
					.reverse()
					.limit(limit)
					.toArray(),
			),
		);
		return newest
			.flat()
			.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
			.slice(0, limit);
	}, [shown.join(), query, limit, folder]);
	const inboxes = boxes.filter((b) => b.role === "inbox").map((b) => b.id);
	const unread = useLiveQuery(
		async () =>
			(await Promise.all(inboxes.map((id) => db.messages.where("[mailboxId+seen]").equals([id, 0]).count()))).some(
				Boolean,
			),
		[inboxes.join()],
	);
	const own = current === "all" ? [] : boxes.filter((b) => !b.role).sort((a, b) => a.name.localeCompare(b.name));

	// One row per conversation, at its newest message in view.
	const threads = [...Map.groupBy(messages ?? [], keyOf).values()];
	// The count covers the whole conversation, your replies in Sent included.
	const threadIds = threads.map((t) => t[0]?.threadId ?? "").filter(Boolean);
	const sizes = useLiveQuery(
		async () =>
			new Map(
				await Promise.all(
					threadIds.map(async (id) => [id, await db.messages.where("threadId").equals(id).count()] as const),
				),
			),
		[threadIds.join()],
	);
	// The open conversation, from every folder: replies from Sent show up next to what they answer.
	const reading = useLiveQuery(async () => {
		if (!open) return undefined;
		const thread = await db.messages.where("threadId").equals(open).sortBy("sentAt");
		// A message whose conversation hasn't arrived yet opens on its own.
		return thread.length ? thread : db.messages.where("id").equals(open).toArray();
	}, [open]);
	// Moving a conversation moves what of it is in the folder in view; Sent keeps its copies.
	const sent = new Set(boxes.filter((b) => b.role === "sent").map((b) => b.id));
	const inView = (thread: Message[]) =>
		thread.filter((m) => shown.includes(m.mailboxId) && (folder === "sent" || !sent.has(m.mailboxId)));
	const moveThread = (thread: Message[], change: { trash?: boolean; archive?: boolean; snoozeUntil?: string }) => {
		setOpen(undefined);
		for (const m of inView(thread)) void update(m, change);
	};
	// A draft opens in the composer. Ours carry their id in the Message-ID, so saving replaces them; a draft
	// written elsewhere is continued as a new one.
	const resume = async (m: Message) => {
		const html = await queryClient.fetchQuery({ queryKey: ["body", m.id], queryFn: () => body(m) }).catch(() => "");
		setDraft({
			accountId: m.accountId,
			to: m.to,
			subject: m.subject,
			body: text(html),
			draftId: /^draft-([0-9a-f-]{36})@/.exec(m.messageId)?.[1] ?? crypto.randomUUID(),
		});
	};
	const markRead = (thread: Message[]) => {
		for (const m of thread) if (m.seen === 0) void update(m, { seen: true });
	};
	// A conversation is starred when any of its messages is; starring marks the newest.
	const isStarred = (thread: Message[]) => thread.some((m) => m.starred === 1);
	const toggleStar = (thread: Message[]) => {
		if (isStarred(thread)) {
			for (const m of thread) if (m.starred === 1) void update(m, { flagged: false });
		} else {
			const newest = thread.reduce((a, b) => (b.sentAt > a.sentAt ? b : a));
			void update(newest, { flagged: true });
		}
	};
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different view starts without a selection
	useEffect(() => setSelected(new Set()), [shown.join(), query]);
	const picked = threads.filter((t) => selected.has(key(t)));
	const failing = (accounts.data ?? []).filter((a) => a.syncError && (current === "all" || a.id === current));
	const contacts = [
		...new Map(
			(messages ?? []).map((m) => [m.fromAddr, { name: m.fromName || m.fromAddr, email: m.fromAddr }]),
		).values(),
	];

	return (
		<AppShell
			className="h-screen"
			logo={<span role="img" aria-label="Nouvex" className="logo" />}
			sidebar={
				<Sidebar.Root>
					<AccountSwitcher
						accounts={(accounts.data ?? []).map((a) => ({ id: a.id, email: a.email, name: a.email }))}
						current={current}
						onChange={(id) => {
							setCurrent(id);
							setFolder("inbox");
						}}
						onAddAccount={() => setAdding(true)}
					/>
					<Sidebar.Section>
						<Sidebar.Item label="Write" icon={<PenLine strokeWidth={1.75} />} onSelect={() => setDraft({})} />
						{standard
							.filter((f) => f.role === "inbox" || boxes.some((b) => b.role === f.role))
							.map(({ role, label, Icon }) => (
								<Sidebar.Item
									key={role}
									label={label}
									icon={<Icon strokeWidth={1.75} />}
									unread={role === "inbox" && unread}
									active={!searching && folder === role}
									onSelect={() => setFolder(role)}
								/>
							))}
						<Sidebar.Item
							label="Starred"
							icon={<Star strokeWidth={1.75} />}
							active={!searching && folder === "starred"}
							onSelect={() => setFolder("starred")}
						/>
					</Sidebar.Section>
					{own.length > 0 && (
						<Sidebar.Section title="Folders" collapsible>
							{own.map((b) => (
								<Sidebar.Item
									key={b.id}
									label={b.name}
									icon={<Folder strokeWidth={1.75} />}
									active={!searching && folder === b.id}
									onSelect={() => setFolder(b.id)}
								/>
							))}
						</Sidebar.Section>
					)}
					<Sidebar.Profile name={user.name} email={user.email}>
						<Menu.Item onClick={() => navigate({ to: "/settings" })}>
							<Settings strokeWidth={1.75} />
							Settings
						</Menu.Item>
						<Menu.Item onClick={() => auth.signOut().then(() => location.assign("/login"))}>
							<LogOut strokeWidth={1.75} />
							Sign out
						</Menu.Item>
					</Sidebar.Profile>
				</Sidebar.Root>
			}
			header={
				<SearchField
					className="w-full max-w-xl"
					contacts={contacts}
					onSearch={(q) => {
						setQuery(q);
						setOpen(undefined);
					}}
				/>
			}
		>
			{reading?.length ? (
				<Reader
					messages={reading}
					onClose={() => setOpen(undefined)}
					onWrite={setDraft}
					onMarkUnread={() => {
						setOpen(undefined);
						const last = reading.at(-1);
						if (last) void update(last, { seen: false });
					}}
					starred={isStarred(reading)}
					onStar={() => toggleStar(reading)}
					onTrash={() => moveThread(reading, { trash: true })}
					onArchive={folder === "archive" ? undefined : () => moveThread(reading, { archive: true })}
				/>
			) : accounts.data?.length === 0 ? (
				<div className="grid h-full place-items-center">
					<Button variant="primary" onClick={() => setAdding(true)}>
						Add your first account
					</Button>
				</div>
			) : (
				// Full height, so the bulk bar's anchor sits at the bottom of the view even under a short list.
				<div className="flex min-h-full flex-col">
					{failing.map((a) => (
						<div key={a.id} className="m-3 flex items-start gap-3 rounded-lg border border-line bg-raised p-3 text-sm">
							<div className="grid flex-1 gap-0.5">
								<span className="font-medium">Couldn't sync {a.email}</span>
								<span className="text-muted">{a.syncError}</span>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onClick={async () => {
									await forget(a.id);
									if (current === a.id) setCurrent("all");
									void accounts.refetch();
								}}
							>
								Remove account
							</Button>
						</div>
					))}
					<MessageList onSelectionChange={(rows) => setSelected(new Set(rows.map((i) => key(threads[i] ?? []))))}>
						{threads.map((thread) => {
							// biome-ignore lint/style/noNonNullAssertion: groupBy never makes an empty group
							const m = thread[0]!;
							return (
								<MessageRow
									key={keyOf(m)}
									from={m.fromName || m.fromAddr}
									email={m.fromAddr}
									subject={m.subject}
									snippet={m.snippet}
									count={sizes?.get(m.threadId) ?? thread.length}
									attachments={thread.reduce((n, t) => n + t.attachments.length, 0)}
									date={new Date(m.sentAt)}
									unread={thread.some((t) => t.seen === 0)}
									starred={isStarred(thread)}
									onStar={() => toggleStar(thread)}
									selected={selected.has(key(thread))}
									selecting={selected.size > 0}
									onOpen={() => {
										if (folder === "drafts") return void resume(m);
										setOpen(key(thread));
										markRead(thread);
									}}
									onArchive={folder === "archive" ? undefined : () => moveThread(thread, { archive: true })}
									onSnooze={
										folder === "inbox"
											? (until) => {
													moveThread(thread, { snoozeUntil: until.toISOString() });
													toast.add({
														title: `Snoozed until ${when(until)}`,
													});
												}
											: undefined
									}
									onDelete={() => moveThread(thread, { trash: true })}
								/>
							);
						})}
					</MessageList>
					{messages?.length === limit && <More onVisible={() => setLimit((l) => l + page)} />}
					{/* At the bottom of the view: pushed down under a short list, stuck there while a long one scrolls. */}
					<div className="sticky bottom-0 mt-auto h-0">
						<BulkBar
							count={picked.length}
							onArchive={
								folder === "archive"
									? undefined
									: () => {
											for (const t of picked) moveThread(t, { archive: true });
											setSelected(new Set());
										}
							}
							onDelete={() => {
								for (const t of picked) moveThread(t, { trash: true });
								setSelected(new Set());
							}}
							onMarkRead={() => {
								for (const t of picked) markRead(t);
								setSelected(new Set());
							}}
							onClear={() => setSelected(new Set())}
						/>
					</div>
				</div>
			)}
			<AddAccount open={adding} onOpenChange={setAdding} onAdded={() => accounts.refetch()} />
			<Write
				from={accounts.data?.find((a) => a.id === (draft?.accountId ?? current)) ?? accounts.data?.[0]}
				contacts={contacts}
				draft={draft}
				onClose={() => setDraft(undefined)}
			/>
		</AppShell>
	);
}

// Sits under the list and asks for the next page as it scrolls into view.
function More({ onVisible }: { onVisible: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const latest = useRef(onVisible);
	latest.current = onVisible;
	useEffect(() => {
		const io = new IntersectionObserver(([e]) => e?.isIntersecting && latest.current(), { rootMargin: "800px" });
		if (ref.current) io.observe(ref.current);
		return () => io.disconnect();
	}, []);
	return <div ref={ref} className="h-px" />;
}
