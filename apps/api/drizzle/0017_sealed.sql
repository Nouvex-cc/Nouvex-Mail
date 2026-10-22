ALTER TABLE "mail_account" ADD COLUMN "sealed_to" "bytea";--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "key" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "sealed" "bytea" NOT NULL;