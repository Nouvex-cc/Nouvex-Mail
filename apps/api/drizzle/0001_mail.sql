CREATE TABLE "mail_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"username" text NOT NULL,
	"secret" "bytea" NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"uid_validity" bigint NOT NULL,
	CONSTRAINT "mailbox_account_id_name_unique" UNIQUE("account_id","name")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"uid" bigint NOT NULL,
	"message_id" text NOT NULL,
	"subject" text NOT NULL,
	"from_name" text NOT NULL,
	"from_addr" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"flags" text[] NOT NULL,
	"size" integer NOT NULL,
	CONSTRAINT "message_mailbox_id_uid_unique" UNIQUE("mailbox_id","uid")
);
--> statement-breakpoint
ALTER TABLE "mail_account" ADD CONSTRAINT "mail_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_account_id_sent_at_index" ON "message" USING btree ("account_id","sent_at");