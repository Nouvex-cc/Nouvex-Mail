CREATE TABLE "address" (
	"address" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"domain_id" text,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"verify_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"catch_all_account_id" text,
	"dkim_public" text NOT NULL,
	"dkim_private" "bytea" NOT NULL,
	"dns_check" jsonb,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_domain_id_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_catch_all_account_id_mail_account_id_fk" FOREIGN KEY ("catch_all_account_id") REFERENCES "public"."mail_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "address_account_id_index" ON "address" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_verified_name" ON "domain" USING btree ("name") WHERE verified_at IS NOT NULL;--> statement-breakpoint
-- Hosted mailboxes made before domains existed get their address, so our MX keeps delivering to them.
INSERT INTO "address" ("address", "account_id", "kind") SELECT lower("email"), "id", 'primary' FROM "mail_account" WHERE "kind" = 'hosted' ON CONFLICT DO NOTHING;
