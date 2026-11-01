-- Expiry dates for store batches and store -> shop transfers.
-- products.expiry_date already exists; these columns keep the expiry of each
-- received batch so shop transfers can carry it along.

ALTER TABLE "store_receipt_items" ADD COLUMN "expiry_date" date;
--> statement-breakpoint
ALTER TABLE "store_request_items" ADD COLUMN "expiry_date" date;
