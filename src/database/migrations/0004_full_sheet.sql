-- Full product size and pricing for dimensional products (steel bars, glass sheets, pipes, etc.)
-- Allows sellers to define a "full product" (e.g. 580cm steel bar) with its price,
-- while still being able to sell smaller cut pieces. Stock is tracked in base unit.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "full_product_length" DECIMAL(10, 4);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "full_product_width" DECIMAL(10, 4);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "full_product_price" DECIMAL(12, 2);
