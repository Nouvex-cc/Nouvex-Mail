CREATE TABLE "account_key" (
	"account_id" text NOT NULL,
	"version" integer NOT NULL,
	"public_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_key_account_id_version_pk" PRIMARY KEY("account_id","version")
);
--> statement-breakpoint
CREATE TABLE "account_member" (
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"key_version" integer NOT NULL,
	"wrapped_key" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_member_account_id_user_id_key_version_pk" PRIMARY KEY("account_id","user_id","key_version")
);
--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "kind" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_key" ADD CONSTRAINT "account_key_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_member" ADD CONSTRAINT "account_member_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_member" ADD CONSTRAINT "account_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_member_user_id_index" ON "account_member" USING btree ("user_id");