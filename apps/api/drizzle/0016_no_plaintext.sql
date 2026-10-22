-- Mail stored in clear goes: the engine fetches it again, sealed for each user (engine/internal/seal). Its objects in
-- S3 go when the engine starts (mail.Sweep), and clients start over with the new format.
DELETE FROM "change_log";--> statement-breakpoint
DELETE FROM "mailbox";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "subject";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "snippet";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "from_name";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "from_addr";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "to_addrs";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "cc_addrs";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "attachments";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "actions";