CREATE TABLE "user_key" (
	"user_id" text PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"wrapped_private" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_key" ADD CONSTRAINT "user_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;