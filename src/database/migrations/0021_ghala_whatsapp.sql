--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghala_notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" varchar(255) NOT NULL,
	"status" varchar(20) NOT NULL DEFAULT 'sent',
	"message_id" varchar(100),
	"error" text,
	"recipient" varchar(20),
	"template_name" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ghala_notification_log_dedupe_key_unique" UNIQUE ("dedupe_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghala_notification_log_created_at_idx" ON "ghala_notification_log" USING btree ("created_at" DESC);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "marketing_opt_in" boolean DEFAULT false;
