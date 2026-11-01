--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "applied_by" varchar(255) REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "applied_email" varchar(255);
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "applied_phone" varchar(20);
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "rejection_notify_sent" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "rejection_notified_at" timestamp;