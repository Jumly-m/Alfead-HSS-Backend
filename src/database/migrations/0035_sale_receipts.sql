-- Professional thermal receipts: every sale gets a unique receipt number, a
-- public verification token (QR) and print/reprint audit fields.
ALTER TABLE "sales" ADD COLUMN "receipt_number" character varying(60);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "receipt_token" character varying(40);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "printed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "print_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "last_printed_by" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_receipt_number_uidx" ON "sales" ("receipt_number") WHERE "receipt_number" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_receipt_token_uidx" ON "sales" ("receipt_token") WHERE "receipt_token" IS NOT NULL;
--> statement-breakpoint
-- Per-shop, per-month sequence used to build receipt numbers like
-- JB-202609-000125.
CREATE TABLE IF NOT EXISTS "receipt_counters" (
  "shop_id" uuid NOT NULL,
  "period" character varying(6) NOT NULL,
  "last_number" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("shop_id", "period")
);
