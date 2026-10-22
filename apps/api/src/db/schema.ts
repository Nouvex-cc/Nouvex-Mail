// SPDX-License-Identifier: AGPL-3.0-only
import {
	bigint,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
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
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
		// fields in Meta (engine/internal/mail/sync.go). Body and attachments are in S3 as body/<id>.html and att/<id>/<index>, encrypted with it too.
		key: bytea("key").notNull(),
		sealed: bytea("sealed").notNull(),
		// The inbox tab, sorted by the engine from the headers (engine/internal/mail/category.go).
		category: text("category", { enum: ["primary", "promotions", "social", "updates", "newsletters"] })
			.notNull()
			.default("primary"),
	},
	(t) => [
		unique().on(t.mailboxId, t.uid),
		index().on(t.accountId, t.sentAt),
		index().on(t.accountId, t.threadId),
		index().on(t.accountId, t.messageId),
		index().using("gin", t.refs),
	],
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
