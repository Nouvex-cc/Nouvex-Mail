// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	customType,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export * from "./auth-schema";

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

// The API creates accounts; everything below them (mailboxes, messages, change_log, version) is written by the engine.
export const mailAccount = pgTable("mail_account", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	email: text("email").notNull(),
	// imap: a mailbox elsewhere that the engine syncs. hosted: mail lives only with us, received by our MX; its folders
	// are local and its mail is sealed to the account's own key (account_key), so sharing and resets keep it.
	// ponytail: hosted rows leave the IMAP and SMTP columns empty rather than splitting the table.
	kind: text("kind").$type<"imap" | "hosted">().notNull().default("imap"),
	// What recipients see next to the address, and what new messages end with.
	displayName: text("display_name").notNull().default(""),
	signature: text("signature").notNull().default(""),
	imapHost: text("imap_host").notNull(),
	imapPort: integer("imap_port").notNull(),
	smtpHost: text("smtp_host").notNull(),
	smtpPort: integer("smtp_port").notNull(),
	username: text("username").notNull(),
	// Password sealed with a per-secret key, see secret.ts.
	secret: bytea("secret").notNull(),
	version: bigint("version", { mode: "number" }).notNull().default(0),
	// Why the last sync failed, cleared by the next one that works. Written by the engine.
	syncError: text("sync_error"),
	// Archived accounts stay out of All inboxes and aren't watched; the engine checks them once a day.
	archivedAt: timestamp("archived_at", { withTimezone: true }),
	// The public key the stored mail is sealed to. When the user's key changes (a reset), the engine drops the mail
	// and fetches it again for the new one.
	sealedTo: bytea("sealed_to"),
	// How the user tells their accounts apart: a short name, one of the label hues, the place in the account picker,
	// and whether it counts for unread dots and notifications.
	nickname: text("nickname").notNull().default(""),
	color: text("color").$type<LabelColor>(),
	position: integer("position").notNull().default(0),
	muted: boolean("muted").notNull().default(false),
	// Set by the SES webhook when too many of a hosted mailbox's messages bounce or are marked as spam; it then sends
	// only to Nouvex mailboxes until someone clears it (docs/deploy.md, Hosted mail).
	sendingPausedAt: timestamp("sending_paused_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const labelColors = ["gray", "red", "orange", "green", "blue", "purple"] as const;
export type LabelColor = (typeof labelColors)[number];

// Days are 0 (Sunday) to 6, times are the device's own; outside them the group rests.
export type Focus = { days: number[]; from: string; to: string };

// Accounts read together, like one inbox. An account can be in several.
export const accountGroup = pgTable("account_group", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	position: integer("position").notNull().default(0),
	muted: boolean("muted").notNull().default(false),
	focus: jsonb("focus").$type<Focus>(),
});

export const accountGroupMember = pgTable(
	"account_group_member",
	{
		groupId: text("group_id")
			.notNull()
			.references(() => accountGroup.id, { onDelete: "cascade" }),
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.groupId, t.accountId] })],
);

// Settings that follow the user to every device; what's only right for one screen stays in that browser.
export const userPrefs = pgTable("user_prefs", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	prefs: jsonb("prefs").notNull().default({}),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The user's key pair for mail encrypted at rest (engine/internal/seal). The private half is wrapped with a key that
// only the user's password gives, on their device; the server never sees either.
export const userKey = pgTable("user_key", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	publicKey: bytea("public_key").notNull(),
	wrappedPrivate: bytea("wrapped_private").notNull(),
	// The same private key wrapped with the user's recovery key (packages/sdk sealRecovery), which only they have. A
	// reset keeps it, so the key and the mail sealed to it can come back.
	recoveryWrapped: bytea("recovery_wrapped"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A domain someone hosts mail with us for. It receives once the TXT record at _nouvex.<name> shows verifyToken; the
// rest of its records (MX, SPF, DKIM, DMARC, the bounce domain for SES) are checked and reported in dnsCheck.
// Anyone may add a name, so nobody blocks it by adding it first; only one can verify it.
// ponytail: owned by a user; an organization with billing comes with the plans.
export const domain = pgTable(
	"domain",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		verifyToken: text("verify_token").notNull(),
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
		// Mail to an address nobody has goes here instead of being refused.
		catchAllAccountId: text("catch_all_account_id").references(() => mailAccount.id, { onDelete: "set null" }),
		// The key mail from this domain is signed with: the public half in DNS at nx1._domainkey, the private half sealed
		// with SECRETS_KEY for SES (and later our own servers) to sign with.
		dkimPublic: text("dkim_public").notNull(),
		dkimPrivate: bytea("dkim_private").notNull(),
		dnsCheck: jsonb("dns_check").$type<Record<string, { ok: boolean; found: string[] }>>(),
		// Amazon SES's view of it once verified: pending, ready, or what went wrong. Written by the engine.
		sesStatus: text("ses_status"),
		checkedAt: timestamp("checked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("domain_verified_name").on(t.name).where(sql`verified_at IS NOT NULL`),
		unique().on(t.userId, t.name),
	],
);

// Mail a hosted mailbox sent to other Nouvex mailboxes went straight into theirs; this is how to take it back.
// Written by the engine.
export const internalDelivery = pgTable(
	"internal_delivery",
	{
		senderAccountId: text("sender_account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		// The sent message's Message-ID, SHA-256 like message.message_id.
		messageId: text("message_id").notNull(),
		recipientAccountId: text("recipient_account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		recipientMessageId: text("recipient_message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.senderAccountId, t.messageId, t.recipientAccountId] })],
);

// What Amazon SES reported about mail a hosted mailbox sent out: how often it bounced or was marked as spam, to see
// abuse early. Who it went to stays out: that's in the sealed notice the sender gets.
export const sendEvent = pgTable(
	"send_event",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		kind: text("kind").$type<"bounce" | "complaint">().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index().on(t.accountId, t.createdAt)],
);

// How many recipients outside Nouvex each hosted mailbox sent to on a day (UTC): its daily limit, and the share of
// them that bounced or complained. Written by the engine.
export const sendCount = pgTable(
	"send_count",
	{
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		day: date("day").notNull(),
		count: integer("count").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.accountId, t.day] })],
);

// Where our MX delivers each address: a hosted account's own address, or an alias of it. Lowercase.
export const address = pgTable(
	"address",
	{
		address: text("address").primaryKey(),
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		domainId: text("domain_id").references(() => domain.id, { onDelete: "cascade" }),
		kind: text("kind").$type<"primary" | "alias">().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index().on(t.accountId)],
);

// A hosted account's public keys: new mail is sealed to the newest (mail_account.sealed_to), older mail stays on the
// version it was sealed to. A new version follows when someone loses access.
export const accountKey = pgTable(
	"account_key",
	{
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		publicKey: bytea("public_key").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.accountId, t.version] })],
);

// Who can read a hosted account: its private key, wrapped by a device to the member's own public key (user_key). The
// owner has a row too. A grant without a key waits for a member's device to wrap one.
export const accountMember = pgTable(
	"account_member",
	{
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").$type<"owner" | "member">().notNull(),
		keyVersion: integer("key_version").notNull(),
		wrappedKey: bytea("wrapped_key"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.accountId, t.userId, t.keyVersion] }), index().on(t.userId)],
);

export const mailbox = pgTable(
	"mailbox",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		// inbox, sent, drafts, trash, junk, archive, or empty for the user's own folders.
		role: text("role").notNull().default(""),
		uidValidity: bigint("uid_validity", { mode: "number" }).notNull(),
		// The folder as of the last sync. On servers with CONDSTORE, a folder where none of them moved is skipped.
		uidNext: bigint("uid_next", { mode: "number" }).notNull().default(0),
		messageCount: bigint("message_count", { mode: "number" }).notNull().default(0),
		highestModSeq: bigint("highest_mod_seq", { mode: "number" }).notNull().default(0),
		// Only in Nouvex, for mail Nouvex put into the inbox itself (announce.ts); syncing leaves it alone.
		local: boolean("local").notNull().default(false),
	},
	(t) => [unique().on(t.accountId, t.name)],
);

export const message = pgTable(
	"message",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailbox.id, { onDelete: "cascade" }),
		uid: bigint("uid", { mode: "number" }).notNull(),
		// SHA-256 of the Message-ID and of the ones this message answers (In-Reply-To and References): enough to put
		// conversations together without keeping the headers. The conversation's id is one of them.
		messageId: text("message_id").notNull(),
		refs: text("refs").array().notNull().default([]),
		threadId: text("thread_id").notNull().default(""),
		sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
		flags: text("flags").array().notNull(),
		size: integer("size").notNull(),
		// This message's own key, sealed to the user's public key (engine/internal/seal), and what only it opens: the
		// fields in Meta (engine/internal/mail/sync.go). Body and attachments are in S3 as body/<id>.html and
		// att/<id>/<index>, encrypted with it too.
		key: bytea("key").notNull(),
		sealed: bytea("sealed").notNull(),
		// The inbox tab, sorted by the engine from the headers (engine/internal/mail/category.go).
		category: text("category", { enum: ["primary", "promotions", "social", "updates", "newsletters"] })
			.notNull()
			.default("primary"),
		// The engine thinks it's spam (engine/internal/mail/spam.go); it stays where it is on the server, clients show it
		// under Junk.
		spam: boolean("spam").notNull().default(false),
	},
	(t) => [
		unique().on(t.mailboxId, t.uid),
		index().on(t.accountId, t.sentAt),
		index().on(t.accountId, t.threadId),
		index().on(t.accountId, t.messageId),
		index().using("gin", t.refs),
	],
);

// Addresses the user wrote to, as SHA-256 of the lowercased address: mail from them is from people, never spam.
export const contact = pgTable(
	"contact",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		hash: text("hash").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.hash] })],
);

// Where the user put a sender's mail: a tab, spam or not spam. sender is the SHA-256 of the lowercased address, or of
// "@domain" for a whole domain.
export const senderRule = pgTable(
	"sender_rule",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		sender: text("sender").notNull(),
		category: text("category", { enum: ["primary", "promotions", "social", "updates", "newsletters"] }),
		spam: boolean("spam"),
	},
	(t) => [primaryKey({ columns: [t.userId, t.sender] })],
);

// One row per change, version is monotonic per account. Clients ask for "everything after version N".
export const changeLog = pgTable(
	"change_log",
	{
		accountId: text("account_id").notNull(),
		version: bigint("version", { mode: "number" }).notNull(),
		entity: text("entity").notNull(),
		entityId: text("entity_id").notNull(),
		op: text("op", { enum: ["upsert", "delete"] }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.accountId, t.version] }), index().on(t.entity, t.entityId)],
);

// Work the engine does later: sending a message at a chosen time, bringing a snoozed message back to the INBOX.
export const scheduled = pgTable(
	"scheduled",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		runAt: timestamp("run_at", { withTimezone: true }).notNull(),
		kind: text("kind", { enum: ["send", "unsnooze"] }).notNull(),
		payload: jsonb("payload").notNull(),
	},
	(t) => [index().on(t.runAt)],
);

// Every message on its way out, by the draft it was written in: one draft goes out once, however often the command
// arrives. Written by the engine; the API lists and cancels what waits. payload is the send command sealed with
// SECRETS_KEY, so a scheduled or failed one can go out later or back to Drafts.
export const outbox = pgTable(
	"outbox",
	{
		draftId: text("draft_id").primaryKey(),
		accountId: text("account_id")
			.notNull()
			.references(() => mailAccount.id, { onDelete: "cascade" }),
		state: text("state", { enum: ["scheduled", "sending", "sent", "failed"] }).notNull(),
		runAt: timestamp("run_at", { withTimezone: true }),
		error: text("error"),
		payload: bytea("payload").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index().on(t.accountId), index().on(t.state, t.runAt)],
);

// iPhones that get a push for new mail (apps/api/src/push.ts). Focus times are judged in the device's time zone.
export const device = pgTable(
	"device",
	{
		token: text("token").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Debug builds get their pushes from APNs' sandbox.
		sandbox: boolean("sandbox").notNull().default(false),
		timeZone: text("time_zone").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index().on(t.userId)],
);

// Each user's sorting model (engine/internal/mail/head.go), sealed with SECRETS_KEY: the engine sorts with it while
// it syncs. metrics are only counts, from the mail it held back while training.
export const sortModel = pgTable("sort_model", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	weights: bytea("weights").notNull(),
	metrics: jsonb("metrics").notNull(),
	trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
});
