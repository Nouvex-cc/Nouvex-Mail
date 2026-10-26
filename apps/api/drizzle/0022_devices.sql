CREATE TABLE "device" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"time_zone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_user_id_index" ON "device" USING btree ("user_id");