CREATE TABLE "account_group" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"focus" jsonb
);
--> statement-breakpoint
CREATE TABLE "account_group_member" (
	"group_id" text NOT NULL,
	"account_id" text NOT NULL,
	CONSTRAINT "account_group_member_group_id_account_id_pk" PRIMARY KEY("group_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "nickname" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_group" ADD CONSTRAINT "account_group_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_group_member" ADD CONSTRAINT "account_group_member_group_id_account_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."account_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_group_member" ADD CONSTRAINT "account_group_member_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;