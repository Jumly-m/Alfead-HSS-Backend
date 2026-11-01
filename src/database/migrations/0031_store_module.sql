-- Store / Back office (Ghala) module
-- Stores live in the same tenant as shops but are flagged with type='store'
-- (the shops.type column is added by the runtime schema bootstrap, which is
-- how this codebase upgrades existing tables).

-- Goods received into a store (from a supplier or anywhere else). Every receipt
-- is kept forever so the owner can always see what was received and at what cost.
CREATE TABLE IF NOT EXISTS "store_receipts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "store_shop_id" uuid NOT NULL,
  "tenant_id" uuid,
  "supplier_id" uuid,
  "supplier_name" character varying(255),
  "receipt_number" character varying(60),
  "total_cost" numeric(14,2) DEFAULT 0 NOT NULL,
  "notes" text,
  "received_by" text,
  "received_by_name" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "store_receipt_items" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "receipt_id" uuid NOT NULL,
  "product_id" uuid,
  "product_name" character varying(255) NOT NULL,
  "quantity" numeric(12,3) DEFAULT 0 NOT NULL,
  "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "total_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_receipts_store_idx ON store_receipts(store_shop_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_receipt_items_receipt_idx ON store_receipt_items(receipt_id);
--> statement-breakpoint

-- Shop -> store requests (mzigo/oda). Lifecycle: pending -> issued -> received,
-- or pending -> rejected / cancelled.
CREATE TABLE IF NOT EXISTS "store_requests" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid,
  "store_shop_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "request_number" character varying(60),
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "total_cost" numeric(14,2) DEFAULT 0 NOT NULL,
  "notes" text,
  "reject_reason" text,
  "created_by" text,
  "created_by_name" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "issued_by" text,
  "issued_by_name" character varying(255),
  "issued_at" timestamp,
  "received_by" text,
  "received_by_name" character varying(255),
  "received_at" timestamp,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_requests_store_idx ON store_requests(store_shop_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_requests_shop_idx ON store_requests(shop_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "store_request_items" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "product_id" uuid,
  "product_name" character varying(255) NOT NULL,
  "barcode" character varying(255),
  "unit_type" character varying(20) DEFAULT 'PCS',
  "requested_qty" numeric(12,3) DEFAULT 0 NOT NULL,
  "issued_qty" numeric(12,3) DEFAULT 0 NOT NULL,
  "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "total_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "available_at_request" numeric(12,3) DEFAULT 0,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_request_items_request_idx ON store_request_items(request_id);
--> statement-breakpoint

-- Auditable stock ledger for every store in/out movement.
CREATE TABLE IF NOT EXISTS "store_stock_movements" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "store_shop_id" uuid NOT NULL,
  "product_id" uuid,
  "product_name" character varying(255),
  "type" character varying(30) NOT NULL,
  "quantity" numeric(12,3) DEFAULT 0 NOT NULL,
  "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "total_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "reference_type" character varying(30),
  "reference_id" uuid,
  "supplier_name" character varying(255),
  "notes" text,
  "created_by" text,
  "created_by_name" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_stock_movements_store_idx ON store_stock_movements(store_shop_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_stock_movements_product_idx ON store_stock_movements(product_id);
