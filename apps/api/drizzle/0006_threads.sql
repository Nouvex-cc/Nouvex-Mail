ALTER TABLE "message" ADD COLUMN "refs" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "thread_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "message_account_id_thread_id_index" ON "message" USING btree ("account_id","thread_id");--> statement-breakpoint
CREATE INDEX "message_account_id_message_id_index" ON "message" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX "message_refs_index" ON "message" USING gin ("refs");