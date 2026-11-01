--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "performance_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(40) NOT NULL DEFAULT 'unknown',
	"url" varchar(500),
	"route" varchar(200),
	"load_ms" integer,
	"payload" jsonb,
	"ip" varchar(64),
	"emailed" boolean NOT NULL DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_alerts_created_at_idx" ON "performance_alerts" USING btree ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_alerts_url_idx" ON "performance_alerts" USING btree ("url", "kind");
