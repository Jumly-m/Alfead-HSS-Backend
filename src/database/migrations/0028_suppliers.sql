CREATE TABLE IF NOT EXISTS "suppliers" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "phone" character varying(50),
  "email" character varying(255),
  "address" text,
  "notes" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS suppliers_shop_idx ON suppliers(shop_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_orders" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "supplier_id" uuid NOT NULL,
  "order_number" character varying(50),
  "status" character varying(20) DEFAULT 'pending',
  "total_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "paid_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "order_date" date DEFAULT CURRENT_DATE,
  "received_date" date,
  "due_date" date,
  "notes" text,
  "created_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_orders_shop_idx ON supplier_orders(shop_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_orders_supplier_idx ON supplier_orders(supplier_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_orders_status_idx ON supplier_orders(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_orders_date_idx ON supplier_orders(order_date DESC);
--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_order_items" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "product_name" character varying(255) NOT NULL,
  "quantity" numeric(12,3) DEFAULT 1 NOT NULL,
  "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "total_cost" numeric(12,2) DEFAULT 0 NOT NULL,
  "received_quantity" numeric(12,3) DEFAULT 0,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_order_items_order_idx ON supplier_order_items(order_id);
--> statement-breakpoint
ALTER TABLE "supplier_order_items" ADD CONSTRAINT "supplier_order_items_order_id_supplier_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."supplier_orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_payments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "payment_method" character varying(50) DEFAULT 'cash',
  "date" date DEFAULT CURRENT_DATE,
  "notes" text,
  "received_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_payments_order_idx ON supplier_payments(order_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_payments_shop_idx ON supplier_payments(shop_id);
--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_order_id_supplier_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."supplier_orders"("id") ON DELETE cascade ON UPDATE no action;
