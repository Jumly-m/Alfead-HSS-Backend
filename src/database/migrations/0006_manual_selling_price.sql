-- Migration 0006: Allow NULL selling_price for manual mode products
-- Manual mode products don't have a selling price since sellers enter it per-piece in POS

ALTER TABLE products ALTER COLUMN selling_price DROP NOT NULL;
ALTER TABLE products ALTER COLUMN selling_price SET DEFAULT NULL;
