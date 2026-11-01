--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "queued_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "error" text;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "ai_reviewed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "ai_risk" varchar(20);
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "ai_flags" jsonb;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "ai_reviewed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "sender_row_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "sender_provider_id" text;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "min_purchase" integer NOT NULL DEFAULT 50;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_messages_queued_idx" ON "sms_messages" ("status", "created_at") WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_messages_ai_review_idx" ON "sms_messages" ("ai_reviewed", "created_at");
