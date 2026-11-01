--> statement-breakpoint
ALTER TABLE "ghala_notification_log" ADD COLUMN "wa_message_id" varchar(100);
--> statement-breakpoint
ALTER TABLE "ghala_notification_log" ADD COLUMN "status_updated_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghala_notification_log_message_id_idx" ON "ghala_notification_log" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghala_notification_log_recipient_idx" ON "ghala_notification_log" USING btree ("recipient");