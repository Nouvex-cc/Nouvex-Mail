-- Mail stored in clear goes: the engine fetches it again, sealed for each user (engine/internal/seal). Its objects in
-- S3 go when the engine starts (Bucket.Sweep), and clients start over with the new format.
DELETE FROM "change_log";--> statement-breakpoint
DELETE FROM "mailbox";--> statement-breakpoint
CREATE TABLE "user_key" (
	"user_id" text PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"wrapped_private" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "sealed_to" "bytea";--> statement-breakpoint
ALTER TABLE "user_key" ADD CONSTRAINT "user_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "subject";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "snippet";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "from_name";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "from_addr";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "to_addrs";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "cc_addrs";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "attachments";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "actions";