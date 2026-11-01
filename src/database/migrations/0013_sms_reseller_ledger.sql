--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN "provider_cost" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN "profit" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_provider_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(20) NOT NULL DEFAULT 'spend',
	"sms_quantity" integer NOT NULL DEFAULT 0,
	"amount_tzs" integer NOT NULL DEFAULT 0,
	"cost_per_sms" integer NOT NULL DEFAULT 0,
	"reference" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_provider_ledger_created_at_idx" ON "sms_provider_ledger" USING btree ("created_at" DESC);
