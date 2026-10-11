CREATE TABLE "scheduled" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled" ADD CONSTRAINT "scheduled_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_run_at_index" ON "scheduled" USING btree ("run_at");