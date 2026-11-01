-- Manual sale items: allow sale_items without a product_id
ALTER TABLE "sale_items" ALTER COLUMN "product_id" DROP NOT NULL;
ALTER TABLE "sale_items" ALTER COLUMN "buying_price_at_sale" DROP NOT NULL;
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "manual_description" TEXT;
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "is_manual" BOOLEAN DEFAULT FALSE;
