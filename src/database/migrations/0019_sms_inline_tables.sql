--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
	"phone" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"status" varchar(20) NOT NULL DEFAULT 'queued',
	"batch_id" varchar(100),
	"message_id" varchar(100),
	"error_message" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_log_tenant_idx" ON "sms_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_log_status_idx" ON "sms_log" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_log_created_idx" ON "sms_log" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"recipient_type" varchar(50) NOT NULL DEFAULT 'all',
	"recipient_count" integer DEFAULT 0,
	"sent_count" integer DEFAULT 0,
	"failed_count" integer DEFAULT 0,
	"status" varchar(20) NOT NULL DEFAULT 'draft',
	"scheduled_at" timestamp,
	"sent_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_campaigns_status_idx" ON "sms_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_campaigns_scheduled_idx" ON "sms_campaigns" USING btree ("scheduled_at");--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "balance_exhausted_notified" boolean NOT NULL DEFAULT false;
