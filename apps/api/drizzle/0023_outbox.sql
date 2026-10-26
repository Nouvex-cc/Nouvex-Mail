CREATE TABLE "outbox" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"state" text NOT NULL,
	"run_at" timestamp with time zone,
	"error" text,
	"payload" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_account_id_index" ON "outbox" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "outbox_state_run_at_index" ON "outbox" USING btree ("state","run_at");