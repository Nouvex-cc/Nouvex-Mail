UPDATE "message" SET "to_addrs" = '{}' WHERE "to_addrs" IS NULL;--> statement-breakpoint
UPDATE "message" SET "cc_addrs" = '{}' WHERE "cc_addrs" IS NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "to_addrs" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "to_addrs" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "cc_addrs" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "cc_addrs" SET NOT NULL;