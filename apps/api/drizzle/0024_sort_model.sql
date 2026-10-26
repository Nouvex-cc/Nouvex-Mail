CREATE TABLE "sort_model" (
	"user_id" text PRIMARY KEY NOT NULL,
	"weights" "bytea" NOT NULL,
	"metrics" jsonb NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sort_model" ADD CONSTRAINT "sort_model_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;