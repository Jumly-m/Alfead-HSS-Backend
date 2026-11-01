-- Credits held for a queued SMS are refunded when the message permanently fails
-- after all retries (provider outage, no sender, etc). This flag makes the
-- refund exactly-once even if the flusher reruns.

ALTER TABLE "sms_messages" ADD COLUMN "refunded" boolean DEFAULT false NOT NULL;
