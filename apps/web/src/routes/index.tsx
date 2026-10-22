// SPDX-License-Identifier: AGPL-3.0-only
import {
	AccountSwitcher,
	AppShell,
	Backdrop,
	BulkBar,
	Button,
	Menu,
	MessageList,
	MessageRow,
	SearchField,
	type SearchQuery,
	Sidebar,
	useShortcut,
	useShortcutsDialog,
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
import { Fragment, useEffect, useRef, useState } from "react";
import { asleep, useAccounts, wake } from "../accounts";
import { AddAccount } from "../add-account";
import { session } from "../auth";
import { type Category, db, type Message, once } from "../db";
import { signOut, unlocked } from "../keys";
import { Now } from "../now";
import { usePref } from "../prefs";
import { body, Reader, text } from "../reader";
import { matches } from "../search";
import { shortcuts } from "../shortcuts";
import { arrived, forget, listen, pull, update } from "../sync";
import { storedLook } from "../theme";
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

// Kinds of mail the inbox can keep apart; under Inbox in the sidebar, each shows like a folder.
const categories: [Category, string][] = [
	["promotions", "Promotions"],
	["social", "Social"],
	["updates", "Updates"],
	["newsletters", "Newsletters"],
];

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
		const { data } = await session();
		if (!data) throw redirect({ to: "/login" });
		if (!(await unlocked())) throw redirect({ to: "/unlock" });
		return { user: data.user };
	},
	component: Inbox,
});

function Inbox() {
	const { user } = Route.useRouteContext();
	const navigate = useNavigate();
	useShortcut("mod+,", () => navigate({ to: "/settings" }));
	const shortcutsDialog = useShortcutsDialog(shortcuts);
	const [current, setCurrent] = useState("all");
	const search = Route.useSearch();
	const router = useRouter();
	// A role shows that folder of every account in view; the user's own folders are picked by id.
	const folder = search.folder ?? "inbox";
	const setFolder = (f: string) => navigate({ to: "/", search: { folder: f === "inbox" ? undefined : f } });
	const open = search.thread;
	// Opening adds a history entry; closing goes back to it, unless the conversation was opened from a link.
	const opened = useRef(false);
	const openNow = useRef(open);
	openNow.current = open;
	const [markWhen] = usePref("markRead");
	const [afterArchive] = usePref("afterArchive");
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
	const [bundling] = usePref("categories");
	// A category is a part of the inbox; with them on, Inbox itself is what's left (Primary).
	const category = categories.find(([c]) => c === folder)?.[0];
	const role = category ? "inbox" : folder;
	const tab: Category | undefined = searching
		? undefined
		: (category ?? (folder === "inbox" && bundling ? "primary" : undefined));
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState<Draft>();
	const toast = useToast();
	const queryClient = useQueryClient();
	const accounts = useAccounts();
	const ids = (accounts.data ?? []).map((a) => a.id).join();
	const [syncing, setSyncing] = useState<ReadonlySet<string>>(new Set());

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
			(id, running) =>
				setSyncing((s) => {
					if (s.has(id) === running) return s;
					const next = new Set(s);
					if (running) next.add(id);
					else next.delete(id);
					return next;
				}),
		);
	}, [ids, toast, accounts.refetch]);

	const every =
		useLiveQuery(
			() => (current === "all" ? db.mailboxes.toArray() : db.mailboxes.where("accountId").equals(current).toArray()),
			[current],
		) ?? [];
	// Archived accounts stay out of All inboxes, unless a search asks for them.
	const archived = new Set((accounts.data ?? []).filter((a) => a.archivedAt).map((a) => a.id));
	const withArchived = query.filters.some((f) => f.key === "in" && f.value === "archived");
	const boxes = current === "all" && !withArchived ? every.filter((b) => !archived.has(b.accountId)) : every;
	// Starred and search look across every folder in view.
	const everywhere = searching || folder === "starred";
	const shown = boxes.filter((b) => everywhere || (b.role ? b.role === role : b.id === folder)).map((b) => b.id);
	// Only a page of the newest messages is read and rendered; scrolling to the end asks for the next one. Each folder
	// is read newest first through its index, so the cost doesn't grow with the mailbox.
	const [limit, setLimit] = useState(page);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different view starts at the first page again
	useEffect(() => setLimit(page), [shown.join(), query, tab]);
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
				(tab
					? db.messages.where("[mailboxId+category+sentAt]").between([id, tab, Dexie.minKey], [id, tab, Dexie.maxKey])
					: db.messages.where("[mailboxId+sentAt]").between([id, Dexie.minKey], [id, Dexie.maxKey])
				)
					.reverse()
					.limit(limit)
					.toArray(),
			),
		);
		return newest
			.flat()
			.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
			.slice(0, limit);
	}, [shown.join(), query, limit, folder, tab]);
	// Except for answers to what was sent from them: those still show in All inboxes.
	const [archivedReplies] = usePref("archivedReplies");
	const sleeping = every.filter((b) => archived.has(b.accountId) && current === "all" && !withArchived);
	const replyBoxes =
		folder === "inbox" && !searching && archivedReplies ? sleeping.filter((b) => b.role === "inbox") : [];
	const replies = useLiveQuery(async () => {
		const ours = new Set(sleeping.filter((b) => b.role === "sent").map((b) => b.id));
		const recent = (
			await Promise.all(
				replyBoxes.map((b) =>
					db.messages
						.where("[mailboxId+sentAt]")
						.between([b.id, Dexie.minKey], [b.id, Dexie.maxKey])
						.reverse()
						.limit(limit)
						.toArray(),
				),
			)
		).flat();
		const answered = await Promise.all(
			recent.map(
				async (m) =>
					!!m.threadId &&
					(await db.messages
						.where("threadId")
						.equals(m.threadId)
						.filter((t) => ours.has(t.mailboxId))
						.count()) > 0,
			),
		);
		return recent.filter((m, i) => answered[i] && (!tab || m.category === tab));
	}, [replyBoxes.map((b) => b.id).join(), limit, tab]);
	const listed = replies?.length
		? [...(messages ?? []), ...replies].sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, limit)
		: messages;
	const inList = [...shown, ...replyBoxes.map((b) => b.id)];
	const inboxes = boxes.filter((b) => b.role === "inbox").map((b) => b.id);
	// With categories on, Inbox's dot is about Primary; each category has its own.
	const unread = useLiveQuery(
		async () =>
			(
				await Promise.all(
					inboxes.map((id) =>
						bundling
							? db.messages.where("[mailboxId+category+seen]").equals([id, "primary", 0]).first()
							: db.messages.where("[mailboxId+seen]").equals([id, 0]).first(),
					),
				)
			).some(Boolean),
		[inboxes.join(), bundling],
	);
	// Whether each category has unread mail, for its dot.
	const unreadIn = useLiveQuery(
		async () =>
			new Set(
				(
					await Promise.all(
						categories.map(async ([c]) =>
							(
								await Promise.all(
									inboxes.map((id) => db.messages.where("[mailboxId+category+seen]").equals([id, c, 0]).first()),
								)
							).some(Boolean)
								? [c]
								: [],
						),
					)
				).flat(),
			),
		[inboxes.join()],
	);
	const own = current === "all" ? [] : boxes.filter((b) => !b.role).sort((a, b) => a.name.localeCompare(b.name));

	// One row per conversation, at its newest message in view.
	const threads = [...Map.groupBy(listed ?? [], keyOf).values()];
	// The count covers the whole conversation, your replies in Sent included.
	const threadIds = threads.map((t) => t[0]?.threadId ?? "").filter(Boolean);
	const sizes = useLiveQuery(
		async () =>
			new Map(
				await Promise.all(
					threadIds.map(
						async (id) => [id, once(await db.messages.where("threadId").equals(id).toArray()).length] as const,
					),
				),
			),
		[threadIds.join()],
	);
	// The open conversation, from every folder: replies from Sent show up next to what they answer.
	const reading = useLiveQuery(async () => {
		if (!open) return undefined;
		const thread = once(await db.messages.where("threadId").equals(open).sortBy("sentAt"), (m) =>
			inList.includes(m.mailboxId),
		);
		// A message whose conversation hasn't arrived yet opens on its own.
		return thread.length ? thread : db.messages.where("id").equals(open).toArray();
	}, [open, inList.join()]);
	// Moving a conversation moves what of it is in the folder in view; Sent keeps its copies.
	const sent = new Set(every.filter((b) => b.role === "sent").map((b) => b.id));
	// Our drafts in a conversation aren't messages of it; the newest one is what Reply continues.
	const drafts = new Set(every.filter((b) => b.role === "drafts").map((b) => b.id));
	const conversation = reading?.filter((m) => !drafts.has(m.mailboxId));
	const unsent = reading?.findLast((m) => drafts.has(m.mailboxId));
	const inView = (thread: Message[]) =>
		thread.filter((m) => inList.includes(m.mailboxId) && (folder === "sent" || !sent.has(m.mailboxId)));
	const moveThread = (thread: Message[], change: { trash?: boolean; archive?: boolean; snoozeUntil?: string }) => {
		setOpen(undefined);
		for (const m of inView(thread)) void update(m, change);
	};
	// From an open conversation the reader moves on to its neighbour in the list, if the user wants that.
	const moveOpen = (thread: Message[], change: { trash?: boolean; archive?: boolean }) => {
		const at = threads.findIndex((t) => key(t) === open);
		const next = afterArchive === "list" ? undefined : threads[afterArchive === "next" ? at + 1 : at - 1];
		if (!next) return moveThread(thread, change);
		for (const m of inView(thread)) void update(m, change);
		show(next, true);
	};
	// A draft opens in the composer. Ours carry their id in the Message-ID, so saving replaces them; a draft
	// written elsewhere is continued as a new one.
	const resume = async (m: Message, thread?: string) => {
		const html = await queryClient.fetchQuery({ queryKey: ["body", m.id], queryFn: () => body(m) }).catch(() => "");
		// The quoted message folds away again, from the line that introduces it.
		const full = text(html);
		// It answers the newest message of its conversation, so it stays in it and the reply is threaded.
		const earlier = await db.messages.where("threadId").equals(m.threadId).sortBy("sentAt");
		const at = full.search(/\n\s*On [^\n]+ wrote:\n/);
		setDraft({
			accountId: m.accountId,
			to: m.to,
			subject: m.subject,
			body: at < 0 ? full : full.slice(0, at),
			quote: at < 0 ? undefined : full.slice(at),
			inReplyTo: earlier.findLast((e) => !drafts.has(e.mailboxId))?.id,
			thread,
			draftId: /^draft-([0-9a-f-]{36})@/.exec(m.messageId)?.[1] ?? crypto.randomUUID(),
		});
	};
	const markRead = (thread: Message[]) => {
		for (const m of thread) if (m.seen === 0) void update(m, { seen: true });
	};
	const show = (thread: Message[], replace = false) => {
		const k = key(thread);
		if (replace) navigate({ to: "/", search: { ...search, thread: k }, replace: true });
		else setOpen(k);
		if (markWhen === "instant") markRead(thread);
		else if (markWhen === "delay") setTimeout(() => openNow.current === k && markRead(thread), 2000);
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
	// A reply or forward is written in its conversation, anything else in the dock.
	const writer = (placement: "dock" | "reply") =>
		draft && (
			<Write
				key={draft.draftId ?? `${draft.thread}-${draft.subject}`}
				from={accounts.data?.find((a) => a.id === (draft.accountId ?? current)) ?? accounts.data?.[0]}
				contacts={contacts}
				draft={draft}
				placement={placement}
				onClose={() => setDraft(undefined)}
			/>
		);
	const [look] = useState(storedLook);
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
			// The background belongs to the list; a conversation is read on plain paper.
			backdrop={
				look.image && !conversation?.length ? (
					<Backdrop src={look.image} blur={look.blur} grain={look.grain} strength={look.strength} />
				) : undefined
			}
			className="h-screen"
			syncing={[...syncing].some((id) => (current === "all" ? !archived.has(id) : id === current))}
			logo={<span role="img" aria-label="Nouvex" className="logo" />}
			sidebar={
				<Sidebar.Root>
					<AccountSwitcher
						accounts={(accounts.data ?? [])
							.filter((a) => a.id === current || !asleep(a))
							.map((a) => ({ id: a.id, email: a.email, name: a.email }))}
						archived={(accounts.data ?? [])
							.filter((a) => a.id !== current && asleep(a))
							.map((a) => ({ id: a.id, email: a.email, name: a.email }))}
						current={current}
						onChange={(id) => {
							if (archived.has(id)) wake(id);
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
								<Fragment key={role}>
									<Sidebar.Item
										label={label}
										icon={<Icon strokeWidth={1.75} />}
										unread={role === "inbox" && unread}
										active={!searching && folder === role}
										onSelect={() => setFolder(role)}
									/>
									{role === "inbox" &&
										bundling &&
										categories.map(([c, name]) => (
											<Sidebar.Item
												key={c}
												inset
												label={name}
												unread={unreadIn?.has(c)}
												active={!searching && folder === c}
												onSelect={() => setFolder(c)}
											/>
										))}
								</Fragment>
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
					<Now
						accountIds={(accounts.data ?? [])
							.filter((a) => (current === "all" ? !a.archivedAt : a.id === current))
							.map((a) => a.id)}
						onOpen={(m) => show([m])}
					/>
					<Sidebar.Profile name={user.name} email={user.email}>
						<Menu.Item onClick={() => navigate({ to: "/settings" })}>
							<Settings strokeWidth={1.75} />
							Settings
						</Menu.Item>
						<Menu.Item onClick={signOut}>
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
					archived={archived.size > 0}
					onSearch={(q) => {
						setQuery(q);
						setOpen(undefined);
					}}
				/>
			}
		>
			{conversation?.length ? (
				<Reader
					messages={conversation}
					draft={unsent}
					onResume={(m) => void resume(m, open)}
					onClose={() => setOpen(undefined)}
					onWrite={(d) => setDraft({ ...d, thread: open })}
					composer={draft?.thread !== undefined && draft.thread === open && writer("reply")}
					onMarkUnread={() => {
						setOpen(undefined);
						const last = conversation.at(-1);
						if (last) void update(last, { seen: false });
					}}
					starred={isStarred(conversation)}
					onStar={() => toggleStar(conversation)}
					onTrash={() => moveOpen(conversation, { trash: true })}
					onArchive={folder === "archive" ? undefined : () => moveOpen(conversation, { archive: true })}
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
									fresh={thread.some((t) => Date.now() - (arrived.get(t.id) ?? 0) < 3000)}
									starred={isStarred(thread)}
									onStar={() => toggleStar(thread)}
									selected={selected.has(key(thread))}
									selecting={selected.size > 0}
									onOpen={() => {
										if (folder === "drafts") return void resume(m);
										show(thread);
									}}
									// The body is there by the time the click lands, so the mail shows at once.
									onPreload={() =>
										void queryClient.prefetchQuery({
											queryKey: ["body", m.id],
											queryFn: () => body(m),
											staleTime: Number.POSITIVE_INFINITY,
										})
									}
									onArchive={folder === "archive" ? undefined : () => moveThread(thread, { archive: true })}
									onSnooze={
										role === "inbox"
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
			{shortcutsDialog}
			{draft?.thread === undefined && writer("dock")}
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
