--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" varchar(20) NOT NULL DEFAULT 'webhook',
	"webhook_url" text NOT NULL,
	"method" varchar(10) NOT NULL DEFAULT 'POST',
	"headers" jsonb NOT NULL DEFAULT '{}',
	"body_template" text NOT NULL DEFAULT '{"heading":"{{heading}}","message":"{{message}}","timestamp":"{{now}}"}',
	"is_active" boolean NOT NULL DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"heading" text,
	"message" text,
	"status" varchar(20) NOT NULL DEFAULT 'unknown',
	"received_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_status_received_at_idx" ON "backup_status" USING btree ("received_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifier_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notifier_id" uuid,
	"heading" text,
	"message" text,
	"status" varchar(20) NOT NULL DEFAULT 'pending',
	"response" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
