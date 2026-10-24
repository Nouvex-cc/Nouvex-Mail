CREATE TABLE "contact" (
	"user_id" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "contact_user_id_hash_pk" PRIMARY KEY("user_id","hash")
);
--> statement-breakpoint
CREATE TABLE "sender_rule" (
	"user_id" text NOT NULL,
	"sender" text NOT NULL,
	"category" text,
	"spam" boolean,
	CONSTRAINT "sender_rule_user_id_sender_pk" PRIMARY KEY("user_id","sender")
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "spam" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_rule" ADD CONSTRAINT "sender_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;