--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghala_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" varchar(100) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"payload" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ghala_webhook_events_delivery_id_unique" UNIQUE ("delivery_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghala_webhook_events_received_at_idx" ON "ghala_webhook_events" USING btree ("received_at" DESC);
