-- Add customer address to sales table
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_address" TEXT;
