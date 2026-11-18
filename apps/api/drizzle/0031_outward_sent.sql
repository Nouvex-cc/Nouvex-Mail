CREATE TABLE "outward_sent" (
	"message_id" text NOT NULL,
	"recipient" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outward_sent_message_id_recipient_pk" PRIMARY KEY("message_id","recipient")
);
