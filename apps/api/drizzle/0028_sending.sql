CREATE TABLE "internal_delivery" (
	"sender_account_id" text NOT NULL,
	"message_id" text NOT NULL,
	"recipient_account_id" text NOT NULL,
	"recipient_message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_delivery_sender_account_id_message_id_recipient_account_id_pk" PRIMARY KEY("sender_account_id","message_id","recipient_account_id")
);
--> statement-breakpoint
CREATE TABLE "send_event" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "ses_status" text;--> statement-breakpoint
ALTER TABLE "internal_delivery" ADD CONSTRAINT "internal_delivery_sender_account_id_mail_account_id_fk" FOREIGN KEY ("sender_account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_delivery" ADD CONSTRAINT "internal_delivery_recipient_account_id_mail_account_id_fk" FOREIGN KEY ("recipient_account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_delivery" ADD CONSTRAINT "internal_delivery_recipient_message_id_message_id_fk" FOREIGN KEY ("recipient_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_event" ADD CONSTRAINT "send_event_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "send_event_account_id_created_at_index" ON "send_event" USING btree ("account_id","created_at");