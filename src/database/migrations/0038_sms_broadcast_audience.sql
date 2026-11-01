-- Broadcast targeting: who a developer broadcast was sent to.
-- 'all' = every shop owner/admin user; 'approved_senders' = only shops that
-- have at least one approved own Sender ID (to encourage SMS usage).

ALTER TABLE "sms_broadcasts" ADD COLUMN "audience" varchar(30) DEFAULT 'all' NOT NULL;
