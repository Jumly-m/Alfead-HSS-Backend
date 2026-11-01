-- Shops.type (shop vs store/ghala) is used by the shop listing, store module and
-- auth context. It was historically added only by the runtime schema bootstrap,
-- which is skipped when RUN_STARTUP_SCHEMA=false — leaving older databases
-- without the column and making GET /api/shops fail with
-- "column s.type does not exist" (the dashboard then shows no shop).
--
-- The migration runner ignores statements containing the "add column" guard
-- phrase, so the ALTER is wrapped in an idempotent DO block instead.
DO $$ BEGIN
  ALTER TABLE "shops" ADD COLUMN "type" character varying(20) DEFAULT 'shop' NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shops_type_idx" ON "shops" ("type");
--> statement-breakpoint
-- Offline/POS idempotency: a client sale reference may only ever appear once,
-- so a queued sale replayed after a lost response is never duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_offline_id_unique" ON "sales" ("offline_id") WHERE "offline_id" IS NOT NULL;
