CREATE TABLE "send_count" (
	"account_id" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "send_count_account_id_day_pk" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "sending_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "send_count" ADD CONSTRAINT "send_count_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;