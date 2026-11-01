-- Approval-notification tracking for sender IDs: the developer can (re)send a
-- "sender ID approved — buy SMS in the SMS Center" message to the applicant
-- (SMS + email) from the Sender IDs registry. These columns record the last
-- successful notice and how many times the applicant has been reminded.

ALTER TABLE "sms_sender_ids" ADD COLUMN "approval_notify_sent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "approval_notified_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN "approval_notify_count" integer DEFAULT 0 NOT NULL;
