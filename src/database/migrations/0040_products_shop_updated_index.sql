-- 0040_products_shop_updated_index.sql
-- Supports the POS incremental product sync (GET /api/products/sync), which
-- pages a shop's products by their last-modified time. The (shop_id,
-- updated_at) shape also serves any per-shop "changed since" scan.

CREATE INDEX IF NOT EXISTS idx_products_shop_updated
  ON products (shop_id, updated_at);
