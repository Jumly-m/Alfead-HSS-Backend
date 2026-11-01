ALTER TABLE "debt_items" ADD COLUMN "date" date;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS debt_items_debtor_date_idx ON debt_items(debtor_id, date DESC);
