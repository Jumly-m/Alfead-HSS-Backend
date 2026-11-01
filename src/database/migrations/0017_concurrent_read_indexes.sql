-- 0017_concurrent_read_indexes.sql
-- Composite indexes for the high-frequency tenant-scoped reads used by the
-- session bootstrap, POS catalog, reports, and dashboard aggregates.

CREATE INDEX IF NOT EXISTS session_user_expires_idx
  ON "session" (user_id, expires_at);

CREATE INDEX IF NOT EXISTS user_shops_user_id_idx
  ON user_shops (user_id);

CREATE INDEX IF NOT EXISTS products_shop_active_name_idx
  ON products (shop_id, is_active, name);

CREATE INDEX IF NOT EXISTS invoice_payments_sale_created_idx
  ON invoice_payments (sale_id, created_at);

CREATE INDEX IF NOT EXISTS debt_payments_debtor_created_idx
  ON debt_payments (debtor_id, created_at);

CREATE INDEX IF NOT EXISTS pre_order_payments_order_created_idx
  ON pre_order_payments (pre_order_id, created_at);

CREATE INDEX IF NOT EXISTS expenses_shop_date_idx
  ON expenses (shop_id, date);

CREATE INDEX IF NOT EXISTS pre_orders_shop_created_idx
  ON pre_orders (shop_id, created_at);

CREATE INDEX IF NOT EXISTS customers_shop_created_idx
  ON customers (shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS activity_logs_shop_created_idx
  ON activity_logs (shop_id, created_at DESC);
