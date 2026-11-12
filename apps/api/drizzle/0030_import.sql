CREATE TABLE "import_job" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"source_id" text NOT NULL,
	"folders" jsonb NOT NULL,
	"folder" integer DEFAULT 0 NOT NULL,
	"after_uid" bigint DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_account_id_mail_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_source_id_mail_account_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."mail_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_job_account_id_index" ON "import_job" USING btree ("account_id");