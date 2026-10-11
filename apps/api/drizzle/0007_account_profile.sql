ALTER TABLE "mail_account" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "signature" text DEFAULT '' NOT NULL;