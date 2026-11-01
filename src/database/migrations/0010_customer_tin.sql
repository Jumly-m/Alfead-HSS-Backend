-- Add customer TIN (Taxpayer Identification Number) to sales table
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_tin" VARCHAR(50);
