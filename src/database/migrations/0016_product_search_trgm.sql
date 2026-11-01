-- 0016_product_search_trgm.sql
-- Speed up product search. The products list query uses:
--   WHERE p.name ILIKE '%term%' OR p.sku ILIKE '%term%' OR p.barcode ILIKE '%term%'
-- A btree index cannot serve mid-string (%term%) patterns. Only `name` had a GIN
-- trigram index, so sku/barcode matches forced a sequential scan of the whole shop.
CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON products USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_barcode_trgm ON products USING gin (barcode gin_trgm_ops);
