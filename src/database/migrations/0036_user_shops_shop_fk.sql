-- Repair stale shop references and enforce user_shops -> shops.
--
-- `user_shops.shop_id` was created without a foreign key on databases that
-- predate the shops FK, and `"user".shop_id` never had one. Deleting a shop
-- therefore left orphaned shop ids behind. When such an account opens a
-- shop-scoped feature the orphan id reaches INSERTs and fails with errors like:
--   insert or update on table "sms_sender_ids" violates foreign key constraint
--   "sms_sender_ids_shop_id_fkey"
-- (the SMS Center sender-ID application was the most visible case).
--
-- 1) Drop memberships pointing at a shop that no longer exists. The auth
--    middleware re-assigns the user to a live shop (or creates one) on the
--    next request.
DELETE FROM "user_shops" us
 WHERE NOT EXISTS (SELECT 1 FROM "shops" s WHERE s.id = us.shop_id);--> statement-breakpoint
-- 2) Clear the primary-shop pointer for users whose shop is gone.
UPDATE "user" u
   SET shop_id = NULL, updated_at = NOW()
 WHERE u.shop_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "shops" s WHERE s.id::text = u.shop_id);--> statement-breakpoint
-- 3) Enforce the relationship so no future orphan can appear (deleting a shop
--    now cascades to memberships).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'user_shops'
       AND c.contype = 'f'
       AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES shops(id)%'
  ) THEN
    ALTER TABLE "user_shops"
      ADD CONSTRAINT "user_shops_shop_id_fkey"
      FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE;
  END IF;
END $$;
