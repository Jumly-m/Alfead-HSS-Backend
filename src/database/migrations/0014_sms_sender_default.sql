--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "is_default" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "is_system" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sms_sender_ids_one_default_idx" ON "sms_sender_ids" USING btree ("shop_id") WHERE "is_default";
