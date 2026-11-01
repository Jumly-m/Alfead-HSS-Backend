-- Store -> shop transfers apply stock to the destination shop the moment the
-- store manager issues the goods (no manual stock gain needed on the shop
-- side). This timestamp records when the shop stock was updated, so a later
-- "received" confirmation never adds the same goods twice.
ALTER TABLE "store_requests" ADD COLUMN "stock_applied_at" timestamp;
