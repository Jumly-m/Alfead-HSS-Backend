-- Store receipts now record how the goods were paid for, so the owner can see
-- which stock came in on credit (deni) and what is still owed to suppliers.
ALTER TABLE "store_receipts" ADD COLUMN "payment_status" character varying(20) DEFAULT 'paid';
--> statement-breakpoint
ALTER TABLE "store_receipts" ADD COLUMN "amount_paid" numeric(14,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "store_receipts" ADD COLUMN "due_date" date;
--> statement-breakpoint
-- The owner monitor filters stock adjustments per shop and date.
CREATE INDEX IF NOT EXISTS "stock_adjustments_shop_created_idx" ON "stock_adjustments" ("shop_id", "created_at" DESC);
