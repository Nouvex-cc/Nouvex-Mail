ALTER TABLE "mailbox" ADD COLUMN "uid_next" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "message_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "highest_mod_seq" bigint DEFAULT 0 NOT NULL;