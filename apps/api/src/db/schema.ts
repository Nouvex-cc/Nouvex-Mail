// SPDX-License-Identifier: AGPL-3.0-only
import { bigint, customType, index, integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
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
	imapHost: text("imap_host").notNull(),
	imapPort: integer("imap_port").notNull(),
	smtpHost: text("smtp_host").notNull(),
	smtpPort: integer("smtp_port").notNull(),
	username: text("username").notNull(),
	// Password sealed with a per-secret key, see secret.ts.
	secret: bytea("secret").notNull(),
	version: bigint("version", { mode: "number" }).notNull().default(0),
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
		messageId: text("message_id").notNull(),
		subject: text("subject").notNull(),
		fromName: text("from_name").notNull(),
		fromAddr: text("from_addr").notNull(),
		sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
		flags: text("flags").array().notNull(),
		size: integer("size").notNull(),
	},
	(t) => [unique().on(t.mailboxId, t.uid), index().on(t.accountId, t.sentAt)],
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
