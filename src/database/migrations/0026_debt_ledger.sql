ALTER TABLE "debt_items" ADD COLUMN "paid_amount" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN "item_id" uuid;
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN "date" date;
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN "discount" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS debt_payments_item_idx ON debt_payments(item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS debt_items_debtor_created_idx ON debt_items(debtor_id, created_at DESC);
