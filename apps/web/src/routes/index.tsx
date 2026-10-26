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
	Tabs,
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
	Layers,
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
import { asleep, named, resting, useAccounts, useGroups, wake, wakes } from "../accounts";
import { AddAccount } from "../add-account";
import { text } from "../answering";
import { session } from "../auth";
import { type Category, db, type Message, once, tabs } from "../db";
import { signOut, unlocked } from "../keys";
import { Now } from "../now";
import { Outbox, useOutbox } from "../outbox";
import { usePref } from "../prefs";
import { attachment, body, Reader } from "../reader";
import { matches } from "../search";
import { shortcuts } from "../shortcuts";
import { arrived, forget, listen, pull, sortSender, unsubscribe, update } from "../sync";
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
type Search = { folder?: string; thread?: string; tab?: Category };

export const Route = createFileRoute("/")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		folder: typeof s.folder === "string" ? s.folder : undefined,
		thread: typeof s.thread === "string" ? s.thread : undefined,
		tab: tabs.find(([c]) => c === s.tab)?.[0],
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
	// "all", "group:<id>" or an account id.
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
		: (category ?? (folder === "inbox" ? (bundling ? "primary" : search.tab) : undefined));
	const setTab = (t?: Category) => navigate({ to: "/", search: { folder: search.folder, tab: t } });
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState<Draft>();
	// A composer's draft gets its id as it opens, so the same draft keeps it when it opens again.
	const write = (d: Omit<Draft, "draftId"> & { draftId?: string }) =>
		setDraft({ ...d, draftId: d.draftId ?? crypto.randomUUID() });
	// Messages handed to the server, to open again when the engine can't send one.
	const outgoing = useRef(new Map<string, Draft>());
	useShortcut("c", () => write({}));
	// A reply belongs to its conversation: leaving it keeps the reply as a draft (Write saves as it goes) and closes it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when another conversation opens
	useEffect(() => {
		if (draft?.thread && draft.thread !== open) setDraft(undefined);
	}, [open]);
	const toast = useToast();
	const queryClient = useQueryClient();
	const accounts = useAccounts();
	const outbox = useOutbox((accounts.data ?? []).filter((a) => !asleep(a)).map((a) => a.id));
	const groups = useGroups().data ?? [];
	const group = groups.find((g) => `group:${g.id}` === current);
	// A resting group's accounts wait out of All inboxes; muted ones and those in a muted group don't count as unread.
	const now = new Date();
	const restingIds = new Set(groups.filter((g) => resting(g, now)).flatMap((g) => g.accountIds));
	const quiet = new Set([
		...(accounts.data ?? []).filter((a) => a.muted).map((a) => a.id),
		...groups.filter((g) => g.muted).flatMap((g) => g.accountIds),
	]);
	const members = group ? group.accountIds : [current];
	const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]));
	const ids = (accounts.data ?? []).map((a) => a.id).join();
	const [syncing, setSyncing] = useState<ReadonlySet<string>>(new Set());

	// biome-ignore lint/correctness/useExhaustiveDependencies: the socket stays open across renders; what a tapped toast calls only has to exist then
	useEffect(() => {
		if (!ids) return;
		const list = ids.split(",");
		for (const id of list) void pull(id);
		return listen(
			list,
			(e) => {
				void queryClient.invalidateQueries({ queryKey: ["outbox"] });
				// Scheduled: the composer said so already.
				if (e.scheduled) return;
				const sent = outgoing.current.get(e.draftId);
				outgoing.current.delete(e.draftId);
				if (!e.error) return toast.add({ title: "Sent" });
				// The engine put it back into Drafts; this tab may still have it as it was written.
				toast.add({
					title: sent ? `Couldn't send “${sent.subject || "(no subject)"}”` : "Couldn't send",
					description: `${e.error}${e.error.endsWith(".") ? "" : "."} It's back in Drafts.`,
					actionProps: sent
						? { children: "Open", onClick: () => setDraft(sent) }
						: { children: "Drafts", onClick: () => setFolder("drafts") },
				});
			},
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
			() => (current === "all" ? db.mailboxes.toArray() : db.mailboxes.where("accountId").anyOf(members).toArray()),
			[current, members.join()],
		) ?? [];
	// Archived accounts stay out of All inboxes, unless a search asks for them.
	const archived = new Set((accounts.data ?? []).filter((a) => a.archivedAt).map((a) => a.id));
	const withArchived = query.filters.some((f) => f.key === "in" && f.value === "archived");
	const boxes =
		current === "all" && !withArchived
			? every.filter((b) => !archived.has(b.accountId) && !restingIds.has(b.accountId))
			: every;
	// Where several accounts mix, a sender takes its account's color.
	const mixed = current === "all" || (group?.accountIds.length ?? 0) > 1;
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
				.filter((m) => inView.has(m.mailboxId) && !m.spam && matches(m, query))
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
					// Spam shows under Junk only, from whichever folder it's in.
					.filter((m) => folder === "junk" || !m.spam)
					.limit(limit)
					.toArray(),
			),
		);
		if (folder === "junk") {
			const mine = new Set(boxes.map((b) => b.id));
			newest.push(
				await db.messages
					.where("[spam+sentAt]")
					.between([1, Dexie.minKey], [1, Dexie.maxKey])
					.reverse()
					.filter((m) => mine.has(m.mailboxId))
					.limit(limit)
					.toArray(),
			);
		}
		return [...new Map(newest.flat().map((m) => [m.id, m])).values()]
			.flat()
			.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
			.slice(0, limit);
	}, [shown.join(), boxes.length, query, limit, folder, tab]);
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
	const inList = [...shown, ...replyBoxes.map((b) => b.id), ...(folder === "junk" ? boxes.map((b) => b.id) : [])];
	const inboxes = boxes
		.filter((b) => b.role === "inbox" && (current !== "all" || !quiet.has(b.accountId)))
		.map((b) => b.id);
	// With categories on, Inbox's dot is about Primary; each category has its own.
	const unread = useLiveQuery(
		async () =>
			(
				await Promise.all(
					inboxes.map((id) =>
						bundling
							? db.messages.where("[mailboxId+category+seen]").equals([id, "primary", 0]).first()
							: db.messages
									.where("[mailboxId+seen]")
									.equals([id, 0])
									.filter((m) => !m.spam)
									.first(),
					),
				)
			).some(Boolean),
		[inboxes.join(), bundling],
	);
	// Which categories have mail in the inbox, and which unread mail, for their chips and dots.
	const inCategory = (c: Category, seen?: 0) =>
		Promise.all(
			inboxes.map((id) =>
				(seen === 0
					? db.messages.where("[mailboxId+category+seen]").equals([id, c, 0])
					: db.messages.where("[mailboxId+category+sentAt]").between([id, c, Dexie.minKey], [id, c, Dexie.maxKey])
				)
					.filter((m) => !m.spam)
					.first(),
			),
		).then((found) => found.some(Boolean));
	const unreadIn = useLiveQuery(
		async () => new Set((await Promise.all(tabs.map(async ([c]) => ((await inCategory(c, 0)) ? [c] : [])))).flat()),
		[inboxes.join()],
	);
	const present = useLiveQuery(
		async () => new Set((await Promise.all(tabs.map(async ([c]) => ((await inCategory(c)) ? [c] : [])))).flat()),
		[inboxes.join()],
	);
	// Junk shows wherever there's spam, also for accounts without a junk folder.
	const hasSpam = useLiveQuery(async () => {
		const mine = new Set(boxes.map((b) => b.id));
		return !!(await db.messages
			.where("[spam+sentAt]")
			.between([1, Dexie.minKey], [1, Dexie.maxKey])
			.filter((m) => mine.has(m.mailboxId))
			.first());
	}, [boxes.map((b) => b.id).join()]);
	const own =
		current === "all" || group ? [] : boxes.filter((b) => !b.role).sort((a, b) => a.name.localeCompare(b.name));

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
		const earlier = (await db.messages.where("threadId").equals(m.threadId).sortBy("sentAt")).filter(
			(e) => !drafts.has(e.mailboxId),
		);
		const parent = earlier.at(-1);
		const at = full.search(/\n\s*On [^\n]+ wrote:\n/);
		const files = await Promise.all(m.attachments.map((_, i) => attachment(m, i))).catch(() => []);
		setDraft({
			accountId: m.accountId,
			kind: parent && thread ? "reply" : undefined,
			to: m.to,
			cc: m.cc,
			subject: m.subject,
			body: at < 0 ? full : full.slice(0, at),
			quote: at < 0 ? undefined : full.slice(at),
			files,
			inReplyTo: parent?.messageId || undefined,
			references: earlier
				.map((e) => e.messageId)
				.filter(Boolean)
				.slice(-20),
			person: parent ? parent.fromName || parent.fromAddr : undefined,
			thread: parent ? thread : undefined,
			saved: true,
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
	// What the user says about a sender holds for all of its mail, new mail too; a toast can take it back.
	const sortAs = async (thread: Message[], change: { category?: Category; spam?: boolean }) => {
		const m = thread.at(-1);
		if (!m) return;
		if (change.spam !== undefined) setOpen(undefined);
		const undo = await sortSender(m.fromAddr, change);
		const name = m.fromName || m.fromAddr;
		toast.add({
			title:
				change.spam === true
					? `Mail from ${name} goes to Junk`
					: change.spam === false
						? `Mail from ${name} isn't spam`
						: `Mail from ${name} goes to ${tabs.find(([c]) => c === change.category)?.[1]}`,
			actionProps: { children: "Undo", onClick: () => void undo() },
		});
	};
	const leave = async (thread: Message[]) => {
		const m = thread.findLast((t) => t.unsubscribe);
		if (!m) return;
		const ok = await unsubscribe(m).catch(() => false);
		toast.add(
			ok
				? {
						title: `Unsubscribed from ${m.fromName || m.fromAddr}`,
						actionProps: { children: "Archive this", onClick: () => moveThread(thread, { archive: true }) },
					}
				: {
						title: "Couldn't unsubscribe",
						description: "The sender didn't take it.",
						...(m.unsubscribe?.url && {
							actionProps: {
								children: "Open their page",
								onClick: () => window.open(m.unsubscribe?.url, "_blank", "noopener"),
							},
						}),
					},
		);
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
				from={
					accounts.data?.find((a) => a.id === (draft.accountId ?? group?.accountIds[0] ?? current)) ??
					accounts.data?.find((a) => !asleep(a))
				}
				accounts={(accounts.data ?? []).filter((a) => !asleep(a))}
				contacts={contacts}
				draft={draft}
				placement={placement}
				onClose={() => setDraft(undefined)}
				onSent={(d) => outgoing.current.set(d.draftId, d)}
				onReopen={setDraft}
			/>
		);
	const [look] = useState(storedLook);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different view starts without a selection
	useEffect(() => setSelected(new Set()), [shown.join(), query]);
	const picked = threads.filter((t) => selected.has(key(t)));
	const inScope = (id: string) => (current === "all" ? !archived.has(id) && !restingIds.has(id) : members.includes(id));
	const failing = (accounts.data ?? []).filter((a) => a.syncError && inScope(a.id));
	// 1 is All inboxes, then the groups and the accounts in the user's order.
	const order = [
		"all",
		...groups.map((g) => `group:${g.id}`),
		...(accounts.data ?? []).filter((a) => !asleep(a)).map((a) => a.id),
	];
	const choose = (id: string) => {
		if (archived.has(id)) wake(id);
		setCurrent(id);
		setFolder("inbox");
	};
	const keyFor = (id: string) => {
		const i = order.indexOf(id);
		return i >= 0 && i < 9 ? String(i + 1) : undefined;
	};
	useShortcut(["1", "2", "3", "4", "5", "6", "7", "8", "9"], (e) => {
		const id = order[Number(e.key) - 1];
		if (id) choose(id);
	});
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
			syncing={[...syncing].some(inScope)}
			logo={<span role="img" aria-label="Nouvex" className="logo" />}
			sidebar={
				<Sidebar.Root>
					<AccountSwitcher
						accounts={(accounts.data ?? [])
							.filter((a) => a.id === current || !asleep(a))
							.map((a) => ({ id: a.id, email: a.email, name: named(a), color: a.color, shortcut: keyFor(a.id) }))}
						groups={groups.map((g) => ({
							id: `group:${g.id}`,
							name: g.name,
							detail: g.accountIds
								.flatMap((id) => {
									const a = byId.get(id);
									return a ? [named(a)] : [];
								})
								.join(", "),
							shortcut: keyFor(`group:${g.id}`),
						}))}
						archived={(accounts.data ?? [])
							.filter((a) => a.id !== current && asleep(a))
							.map((a) => ({ id: a.id, email: a.email, name: named(a), color: a.color }))}
						allShortcut="1"
						current={current}
						onChange={choose}
						onAddAccount={() => setAdding(true)}
					/>
					<Sidebar.Section>
						<Sidebar.Item label="Write" icon={<PenLine strokeWidth={1.75} />} onSelect={() => write({})} />
						{standard
							.filter(
								(f) => f.role === "inbox" || (f.role === "junk" && hasSpam) || boxes.some((b) => b.role === f.role),
							)
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
						{/* Only while something waits there, or couldn't be sent. */}
						{((outbox.data?.length ?? 0) > 0 || folder === "outbox") && (
							<Sidebar.Item
								label="Outbox"
								icon={<Layers strokeWidth={1.75} />}
								unread={outbox.data?.some((w) => w.error)}
								active={!searching && folder === "outbox"}
								onSelect={() => setFolder("outbox")}
							/>
						)}
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
						accountIds={(accounts.data ?? []).filter((a) => inScope(a.id)).map((a) => a.id)}
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
					onWrite={(d) => write({ ...d, thread: d.kind ? open : undefined })}
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
					onSort={(category) => void sortAs(conversation, { category })}
					onSpam={(spam) => void sortAs(conversation, { spam })}
					onUnsubscribe={() => void leave(conversation)}
				/>
			) : folder === "outbox" && !searching ? (
				<Outbox
					accountIds={(accounts.data ?? []).filter((a) => !asleep(a)).map((a) => a.id)}
					onDrafts={() => setFolder("drafts")}
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
					{group?.focus && resting(group, now) && (
						<p className="mx-4 mt-3 text-sm text-muted">
							Resting until {when(wakes(group.focus, now) ?? now)}, so it stays out of All inboxes.
						</p>
					)}
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
					{folder === "inbox" && !bundling && !searching && (present?.size ?? 0) > 1 && (
						<Tabs.Root value={tab ?? "all"} onValueChange={(v) => setTab(v === "all" ? undefined : (v as Category))}>
							<Tabs.List variant="chips">
								<Tabs.Tab variant="chips" value="all">
									All
								</Tabs.Tab>
								{tabs
									.filter(([c]) => present?.has(c))
									.map(([c, name]) => (
										<Tabs.Tab key={c} variant="chips" value={c}>
											{name}
											{unreadIn?.has(c) && (
												<span className="size-1.5 rounded-full bg-accent">
													<span className="sr-only">Unread</span>
												</span>
											)}
										</Tabs.Tab>
									))}
							</Tabs.List>
						</Tabs.Root>
					)}
					<MessageList onSelectionChange={(rows) => setSelected(new Set(rows.map((i) => key(threads[i] ?? []))))}>
						{threads.map((thread) => {
							// biome-ignore lint/style/noNonNullAssertion: groupBy never makes an empty group
							const m = thread[0]!;
							const to = byId.get(m.accountId);
							return (
								<MessageRow
									key={keyOf(m)}
									from={m.fromName || m.fromAddr}
									email={m.fromAddr}
									account={mixed && to ? { name: named(to), color: to.color } : undefined}
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
