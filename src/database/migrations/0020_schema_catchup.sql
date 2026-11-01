-- Catch-up migration: brings any database in line with the current live schema.
-- Idempotent: safe to run on fresh DBs and existing DBs. Auto-applied on startup.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account" (
  "id" character varying(255) NOT NULL,
  "user_id" character varying(255) NOT NULL,
  "account_id" character varying(255) NOT NULL,
  "provider_id" character varying(255) NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp,
  "refresh_token_expires_at" timestamp,
  "scope" text,
  "password" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "id" character varying(255);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "user_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "account_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "provider_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "access_token" text;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "refresh_token" text;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "id_token" text;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "access_token_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "scope" text;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "password" character varying(255);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "shop_id" uuid,
  "user_id" character varying(255),
  "user_name" character varying(255),
  "user_email" character varying(255),
  "action" character varying(100) NOT NULL,
  "entity_type" character varying(50),
  "entity_id" uuid,
  "details" jsonb,
  "ip_address" character varying(45),
  "user_agent" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "user_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "user_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "user_email" character varying(255);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "action" character varying(100);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "entity_type" character varying(50);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "entity_id" uuid;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "details" jsonb;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "ip_address" character varying(45);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "admin_id" text NOT NULL,
  "action" character varying(100) NOT NULL,
  "target_tenant_id" uuid,
  "target_subscription_id" uuid,
  "notes" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "admin_id" text;
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "action" character varying(100);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "target_tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "target_subscription_id" uuid;
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid,
  "action" character varying(50) NOT NULL,
  "entity_type" character varying(50) NOT NULL,
  "entity_id" uuid,
  "old_values" text,
  "new_values" text,
  "ip_address" character varying(45),
  "user_agent" text,
  "created_at" timestamp DEFAULT now(), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "action" character varying(50);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "entity_type" character varying(50);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "entity_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "old_values" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "new_values" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "ip_address" character varying(45);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_history" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "shop_id" uuid,
  "filename" character varying(255) NOT NULL,
  "filepath" text NOT NULL,
  "filesize" integer,
  "backup_type" character varying(20) DEFAULT 'full' NOT NULL,
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "cloud_uploaded" boolean DEFAULT false NOT NULL,
  "error_message" text,
  "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "filename" character varying(255);
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "filepath" text;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "filesize" integer;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "backup_type" character varying(20) DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "cloud_uploaded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "error_message" text;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "backup_history" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_settings" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "shop_id" uuid,
  "backup_type" character varying(20) DEFAULT 'full' NOT NULL,
  "backup_location" text,
  "custom_path" text,
  "frequency" character varying(20) DEFAULT 'weekly' NOT NULL,
  "retention_days" integer DEFAULT 30 NOT NULL,
  "is_enabled" boolean DEFAULT true,
  "last_backup_at" timestamp,
  "next_backup_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "backup_type" character varying(20) DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "backup_location" text;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "custom_path" text;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "frequency" character varying(20) DEFAULT 'weekly' NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "retention_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "is_enabled" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "last_backup_at" timestamp;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "next_backup_at" timestamp;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cargo_entries" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "product_id" uuid NOT NULL,
  "quantity" numeric(12,4) DEFAULT 0 NOT NULL,
  "buying_price_per_unit" numeric(12,2) DEFAULT 0,
  "transport_cost" numeric(12,2) DEFAULT 0,
  "supplier_name" character varying(255),
  "notes" text,
  "created_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "shop_id" uuid, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "quantity" numeric(12,4) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "buying_price_per_unit" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "transport_cost" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "supplier_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cargo_entries" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categories" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(100) NOT NULL,
  "description" text,
  "color" character varying(7),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "name" character varying(100);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "color" character varying(7);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "chat_id" uuid,
  "sender_id" text NOT NULL,
  "sender_role" character varying(20) DEFAULT 'user' NOT NULL,
  "message" text NOT NULL,
  "is_admin_message" boolean DEFAULT false NOT NULL,
  "is_read" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "chat_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "sender_id" text;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "sender_role" character varying(20) DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "is_admin_message" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "is_read" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_requests" (
  "id" SERIAL NOT NULL,
  "name" character varying(255),
  "email" character varying(255) NOT NULL,
  "message" text,
  "status" character varying(50) DEFAULT 'pending',
  "admin_notes" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "id" SERIAL;
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "status" character varying(50) DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "admin_notes" text;
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "phone" character varying(20),
  "email" character varying(255),
  "company" character varying(255),
  "address" text,
  "tin" character varying(50),
  "notes" text,
  "is_returned" boolean DEFAULT false,
  "return_count" integer DEFAULT 0,
  "total_visits" integer DEFAULT 0,
  "total_spent" numeric(12,2) DEFAULT 0,
  "last_purchase_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "company" character varying(255);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "address" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "tin" character varying(50);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "is_returned" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "return_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "total_visits" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "total_spent" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "last_purchase_at" timestamp;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "debt_items" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "debtor_id" uuid NOT NULL,
  "product_id" uuid,
  "product_name" character varying(255) NOT NULL,
  "quantity" numeric(12,3) DEFAULT 1 NOT NULL,
  "unit_price" numeric(12,2) DEFAULT 0 NOT NULL,
  "discount" numeric(12,2) DEFAULT 0,
  "total_price" numeric(12,2) DEFAULT 0 NOT NULL,
  "buying_price" numeric(12,2) DEFAULT 0,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "debtor_id" uuid;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "product_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "quantity" numeric(12,3) DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "unit_price" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "discount" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "total_price" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "buying_price" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "debt_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "debt_payments" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "debtor_id" uuid NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "payment_method" character varying(50) DEFAULT 'cash',
  "notes" text,
  "received_by" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "debtor_id" uuid;
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "amount" numeric(12,2);
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "payment_method" character varying(50) DEFAULT 'cash';
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "received_by" character varying(255);
--> statement-breakpoint
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "debtors" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "sale_id" uuid,
  "customer_name" character varying(255),
  "customer_phone" character varying(50),
  "customer_email" character varying(255),
  "total_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "paid_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "status" character varying(20) DEFAULT 'unpaid',
  "due_date" timestamp,
  "notes" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "sale_id" uuid;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "customer_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "customer_phone" character varying(50);
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "customer_email" character varying(255);
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "total_amount" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "paid_amount" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'unpaid';
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "due_date" timestamp;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "debtors" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_campaign_recipients" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "tenant_id" uuid,
  "email" character varying(255) NOT NULL,
  "name" character varying(255),
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "error_message" text,
  "sent_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "campaign_id" uuid;
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "error_message" text;
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "sent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_campaigns" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "admin_id" text NOT NULL,
  "subject" character varying(500) NOT NULL,
  "html_content" text NOT NULL,
  "template_key" character varying(100),
  "recipient_type" character varying(50) DEFAULT 'all' NOT NULL,
  "recipient_count" integer DEFAULT 0,
  "sent_count" integer DEFAULT 0,
  "failed_count" integer DEFAULT 0,
  "status" character varying(20) DEFAULT 'draft' NOT NULL,
  "scheduled_at" timestamp,
  "sent_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "source" character varying(20) DEFAULT 'manual' NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "admin_id" text;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "subject" character varying(500);
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "html_content" text;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "template_key" character varying(100);
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "recipient_type" character varying(50) DEFAULT 'all' NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "recipient_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "sent_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "failed_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "sent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "source" character varying(20) DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_events" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "event_type" character varying(20) NOT NULL,
  "template_key" character varying(100),
  "email" character varying(255) NOT NULL,
  "tenant_id" uuid,
  "campaign_id" uuid,
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "event_type" character varying(20);
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "template_key" character varying(100);
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "campaign_id" uuid;
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_categories" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid,
  "name" character varying(100) NOT NULL,
  "description" text,
  "is_default" boolean DEFAULT false,
  "created_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "name" character varying(100);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_workers" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "expense_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "expense_workers" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_workers" ADD COLUMN IF NOT EXISTS "expense_id" uuid;
--> statement-breakpoint
ALTER TABLE "expense_workers" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "expense_workers" ADD COLUMN IF NOT EXISTS "amount" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_workers" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expenses" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "category" character varying(100) NOT NULL,
  "amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "description" text,
  "paid_to" character varying(255),
  "details" jsonb DEFAULT '{}',
  "period_start" date,
  "period_end" date,
  "date" date DEFAULT CURRENT_DATE NOT NULL,
  "created_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "tenant_id" character varying(255), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "category" character varying(100);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "amount" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "paid_to" character varying(255);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "details" jsonb DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "period_start" date;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "period_end" date;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "date" date DEFAULT CURRENT_DATE NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "tenant_id" character varying(255);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flags" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "feature_key" character varying(100) NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "rollout_percent" integer DEFAULT 0 NOT NULL,
  "description" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "feature_key" character varying(100);
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "rollout_percent" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_emails" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "email_id" character varying(255) NOT NULL,
  "message_id" character varying(255),
  "from" character varying(512) NOT NULL,
  "to" text[] DEFAULT '{}' NOT NULL,
  "cc" text[] DEFAULT '{}',
  "bcc" text[] DEFAULT '{}',
  "subject" text,
  "html_body" text,
  "text_body" text,
  "headers" jsonb DEFAULT '{}',
  "attachments" jsonb DEFAULT '[]',
  "replied_at" timestamp,
  "reply_html" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "email_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "message_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "from" character varying(512);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "to" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "cc" text[] DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "bcc" text[] DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "subject" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "html_body" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "text_body" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "headers" jsonb DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "attachments" jsonb DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "replied_at" timestamp;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "reply_html" text;
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_payments" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "sale_id" uuid NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "payment_method" character varying(50) DEFAULT 'cash',
  "payment_reference" character varying(255),
  "notes" text,
  "recorded_by" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "sale_id" uuid;
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "amount" numeric(12,2);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "payment_method" character varying(50) DEFAULT 'cash';
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "payment_reference" character varying(255);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "recorded_by" character varying(255);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_history" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "user_id" character varying(255),
  "user_email" character varying(255),
  "user_name" character varying(255),
  "login_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "logout_at" timestamp,
  "ip_address" character varying(45),
  "user_agent" text,
  "status" character varying(20) DEFAULT 'success' NOT NULL,
  "failure_reason" text, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "user_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "user_email" character varying(255);
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "user_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "login_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "logout_at" timestamp;
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "ip_address" character varying(45);
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'success' NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_history" ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "user_id" text,
  "title" character varying(255) NOT NULL,
  "message" text NOT NULL,
  "type" character varying(50) DEFAULT 'info' NOT NULL,
  "is_read" boolean DEFAULT false NOT NULL,
  "action_url" character varying(500),
  "created_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "title" character varying(255);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "type" character varying(50) DEFAULT 'info' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "is_read" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "action_url" character varying(500);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "performance_alerts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "kind" character varying(40) DEFAULT 'unknown' NOT NULL,
  "url" character varying(500),
  "route" character varying(200),
  "load_ms" integer,
  "payload" jsonb,
  "ip" character varying(64),
  "emailed" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "kind" character varying(40) DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "url" character varying(500);
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "route" character varying(200);
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "load_ms" integer;
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "payload" jsonb;
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "ip" character varying(64);
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "emailed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "performance_alerts" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pre_order_payments" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "pre_order_id" uuid NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "payment_method" character varying(50) DEFAULT 'cash',
  "notes" text,
  "received_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "pre_order_payments" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_order_payments" ADD COLUMN IF NOT EXISTS "pre_order_id" uuid;
--> statement-breakpoint
ALTER TABLE "pre_order_payments" ADD COLUMN IF NOT EXISTS "amount" numeric(12,2);
--> statement-breakpoint
ALTER TABLE "pre_order_payments" ADD COLUMN IF NOT EXISTS "payment_method" character varying(50) DEFAULT 'cash';
--> statement-breakpoint
ALTER TABLE "pre_order_payments" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "pre_order_payments" ADD COLUMN IF NOT EXISTS "received_by" text;
--> statement-breakpoint
ALTER TABLE "pre_order_payments" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pre_orders" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "customer_name" character varying(255),
  "customer_phone" character varying(50),
  "customer_email" character varying(255),
  "product_name" character varying(255) NOT NULL,
  "quantity" numeric(12,4) DEFAULT 1 NOT NULL,
  "total_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "paid_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "expected_date" timestamp,
  "notes" text,
  "created_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "product_id" uuid,
  "items_data" jsonb DEFAULT '[]',
  "sale_id" uuid, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "customer_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "customer_phone" character varying(50);
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "customer_email" character varying(255);
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "product_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "quantity" numeric(12,4) DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "total_amount" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "paid_amount" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "expected_date" timestamp;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "items_data" jsonb DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE "pre_orders" ADD COLUMN IF NOT EXISTS "sale_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "category_id" uuid,
  "name" character varying(255) NOT NULL,
  "sku" character varying(100),
  "barcode" character varying(100),
  "qr_code" character varying(100),
  "description" text,
  "buying_price" numeric(12,2) DEFAULT 0,
  "selling_price" numeric(12,2) DEFAULT NULL::numeric,
  "current_stock" numeric(12,4) DEFAULT 0,
  "low_stock_threshold" numeric(12,4) DEFAULT 10,
  "enable_fractions" boolean DEFAULT false,
  "fraction_types" jsonb DEFAULT '[]',
  "fraction_prices" jsonb DEFAULT '{}',
  "expiry_date" timestamp,
  "images" text[],
  "is_active" boolean DEFAULT true,
  "created_by" text,
  "cost_per_qty" numeric(12,4) DEFAULT 1,
  "cost_per_qty_price" numeric(12,2) DEFAULT 0,
  "cost_per_qty_buy_price" numeric(12,2) DEFAULT 0,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "unit_type" character varying(20) DEFAULT 'PCS',
  "requires_dimensions" boolean DEFAULT false,
  "unit_conversions" jsonb DEFAULT '{}',
  "dimension_unit" character varying(5) DEFAULT 'm',
  "full_product_length" numeric(10,4),
  "full_product_width" numeric(10,4),
  "full_product_price" numeric(12,2), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "category_id" uuid;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sku" character varying(100);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "barcode" character varying(100);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "qr_code" character varying(100);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "buying_price" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "selling_price" numeric(12,2) DEFAULT NULL::numeric;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "current_stock" numeric(12,4) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "low_stock_threshold" numeric(12,4) DEFAULT 10;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "enable_fractions" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fraction_types" jsonb DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fraction_prices" jsonb DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "expiry_date" timestamp;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "images" text[];
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cost_per_qty" numeric(12,4) DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cost_per_qty_price" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cost_per_qty_buy_price" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unit_type" character varying(20) DEFAULT 'PCS';
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "requires_dimensions" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unit_conversions" jsonb DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dimension_unit" character varying(5) DEFAULT 'm';
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "full_product_length" numeric(10,4);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "full_product_width" numeric(10,4);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "full_product_price" numeric(12,2);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_items" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "sale_id" uuid NOT NULL,
  "product_id" uuid,
  "product_name" character varying(255) NOT NULL,
  "quantity" numeric(12,4) NOT NULL,
  "fraction_type" character varying(20) DEFAULT 'whole',
  "unit_price" numeric(12,2) NOT NULL,
  "discount" numeric(12,2) DEFAULT 0,
  "buying_price_at_sale" numeric(12,2) DEFAULT 0,
  "total_price" numeric(12,2) NOT NULL,
  "profit" numeric(12,2) DEFAULT 0,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "unit_type" character varying(20) DEFAULT 'PCS',
  "dimension_l" numeric(12,4),
  "dimension_w" numeric(12,4),
  "dimension_h" numeric(12,4),
  "dimension_label" text,
  "custom_unit_code" character varying(20),
  "manual_description" text,
  "is_manual" boolean DEFAULT false, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "sale_id" uuid;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "product_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "quantity" numeric(12,4);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "fraction_type" character varying(20) DEFAULT 'whole';
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "unit_price" numeric(12,2);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "discount" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "buying_price_at_sale" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "total_price" numeric(12,2);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "profit" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "unit_type" character varying(20) DEFAULT 'PCS';
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "dimension_l" numeric(12,4);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "dimension_w" numeric(12,4);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "dimension_h" numeric(12,4);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "dimension_label" text;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "custom_unit_code" character varying(20);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "manual_description" text;
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "is_manual" boolean DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "seller_id" character varying(255) NOT NULL,
  "offline_id" character varying(255),
  "total_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "payment_method" character varying(50) DEFAULT 'cash' NOT NULL,
  "amount_paid" numeric(12,2) DEFAULT 0,
  "change_due" numeric(12,2) DEFAULT 0,
  "discount_amount" numeric(12,2) DEFAULT 0,
  "customer_name" character varying(255),
  "customer_phone" character varying(20),
  "customer_email" character varying(255),
  "invoice_sent" boolean DEFAULT false,
  "due_date" timestamp,
  "payment_reference" character varying(255),
  "verification_code" character varying(100),
  "notes" text,
  "payment_status" character varying(20) DEFAULT 'pending',
  "customer_company" character varying(255),
  "bank_name" character varying(100),
  "sale_type" character varying(20) DEFAULT 'normal',
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "source" character varying(10) DEFAULT 'pos',
  "customer_address" text,
  "customer_tin" character varying(50), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "seller_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "offline_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "total_amount" numeric(12,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "payment_method" character varying(50) DEFAULT 'cash' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "amount_paid" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "change_due" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "discount_amount" numeric(12,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_email" character varying(255);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "invoice_sent" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "due_date" timestamp;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "payment_reference" character varying(255);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "verification_code" character varying(100);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "payment_status" character varying(20) DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_company" character varying(255);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "bank_name" character varying(100);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "sale_type" character varying(20) DEFAULT 'normal';
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "source" character varying(10) DEFAULT 'pos';
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_address" text;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "customer_tin" character varying(50);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_during_stock_take" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "sale_id" uuid NOT NULL,
  "session_id" uuid,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sales_during_stock_take" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_during_stock_take" ADD COLUMN IF NOT EXISTS "sale_id" uuid;
--> statement-breakpoint
ALTER TABLE "sales_during_stock_take" ADD COLUMN IF NOT EXISTS "session_id" uuid;
--> statement-breakpoint
ALTER TABLE "sales_during_stock_take" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
  "id" character varying(255) NOT NULL,
  "user_id" character varying(255) NOT NULL,
  "token" character varying(255) NOT NULL,
  "expires_at" timestamp NOT NULL,
  "ip_address" character varying(45),
  "user_agent" text,
  "impersonated_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "id" character varying(255);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "user_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "token" character varying(255);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "ip_address" character varying(45);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "impersonated_by" text;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "shop_id" uuid,
  "key" character varying(100) NOT NULL,
  "value" jsonb,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "key" character varying(100);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "value" jsonb;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_units" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(50) NOT NULL,
  "code" character varying(20) NOT NULL,
  "abbreviation" character varying(10),
  "decimal_places" integer DEFAULT 2,
  "stock_multiplier" numeric(12,6) DEFAULT 1,
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "name" character varying(50);
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "code" character varying(20);
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "abbreviation" character varying(10);
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "decimal_places" integer DEFAULT 2;
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "stock_multiplier" numeric(12,6) DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "shop_units" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shops" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "name" character varying(255) NOT NULL,
  "code" character varying(50),
  "address" text,
  "phone" character varying(20),
  "email" character varying(255),
  "is_super_admin" boolean DEFAULT false,
  "business_name" character varying(255),
  "branch_name" character varying(255),
  "serial_number" character varying(50),
  "logo" text,
  "invoice_footer" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "description" text,
  "is_active" boolean DEFAULT true,
  "tin_number" character varying(50),
  "vrn_number" character varying(50), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "code" character varying(50);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "address" text;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "is_super_admin" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "business_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "branch_name" character varying(255);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "serial_number" character varying(50);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "logo" text;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "invoice_footer" text;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "tin_number" character varying(50);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "vrn_number" character varying(50);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_accounts" (
  "shop_id" uuid NOT NULL,
  "balance" integer DEFAULT 0 NOT NULL,
  "total_bought" integer DEFAULT 0 NOT NULL,
  "total_sent" integer DEFAULT 0 NOT NULL,
  "low_balance_notified" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "balance_exhausted_notified" boolean DEFAULT false NOT NULL, PRIMARY KEY ("shop_id")
);
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "balance" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "total_bought" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "total_sent" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "low_balance_notified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_accounts" ADD COLUMN IF NOT EXISTS "balance_exhausted_notified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_campaigns" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "title" character varying(255) NOT NULL,
  "message" text NOT NULL,
  "recipient_type" character varying(50) DEFAULT 'all' NOT NULL,
  "recipient_count" integer DEFAULT 0,
  "sent_count" integer DEFAULT 0,
  "failed_count" integer DEFAULT 0,
  "status" character varying(20) DEFAULT 'draft' NOT NULL,
  "scheduled_at" timestamp,
  "sent_at" timestamp,
  "created_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "title" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "recipient_type" character varying(50) DEFAULT 'all' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "recipient_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "sent_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "failed_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "sent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_contacts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(255),
  "phone" character varying(20) NOT NULL,
  "email" character varying(255),
  "group_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_contacts" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_contacts" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_contacts" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_contacts" ADD COLUMN IF NOT EXISTS "phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "sms_contacts" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_contacts" ADD COLUMN IF NOT EXISTS "group_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_contacts" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_groups" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_groups" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_groups" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_groups" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_groups" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_log" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "phone" character varying(20) NOT NULL,
  "message" text NOT NULL,
  "status" character varying(20) DEFAULT 'queued' NOT NULL,
  "batch_id" character varying(100),
  "message_id" character varying(100),
  "error_message" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'queued' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "batch_id" character varying(100);
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "message_id" character varying(100);
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "error_message" text;
--> statement-breakpoint
ALTER TABLE "sms_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_messages" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "recipient" character varying(20) NOT NULL,
  "message" text NOT NULL,
  "parts" integer DEFAULT 1 NOT NULL,
  "credits" integer DEFAULT 1 NOT NULL,
  "cost" integer DEFAULT 0 NOT NULL,
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "provider_message_id" text,
  "sender_id" character varying(11),
  "campaign_id" uuid,
  "source" character varying(20) DEFAULT 'manual' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "recipient" character varying(20);
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "parts" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "credits" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "cost" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "provider_message_id" text;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "sender_id" character varying(11);
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "campaign_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "source" character varying(20) DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_provider_ledger" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "type" character varying(20) DEFAULT 'spend' NOT NULL,
  "sms_quantity" integer DEFAULT 0 NOT NULL,
  "amount_tzs" integer DEFAULT 0 NOT NULL,
  "cost_per_sms" integer DEFAULT 0 NOT NULL,
  "reference" text,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "type" character varying(20) DEFAULT 'spend' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "sms_quantity" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "amount_tzs" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "cost_per_sms" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "reference" text;
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "note" text;
--> statement-breakpoint
ALTER TABLE "sms_provider_ledger" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_purchases" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "credits" integer NOT NULL,
  "amount_tzs" integer NOT NULL,
  "price_per_sms" integer NOT NULL,
  "phone_number" character varying(20),
  "snippe_reference" text,
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "paid_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "provider_cost" integer DEFAULT 0 NOT NULL,
  "profit" integer DEFAULT 0 NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "credits" integer;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "amount_tzs" integer;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "price_per_sms" integer;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "phone_number" character varying(20);
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "snippe_reference" text;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "paid_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "provider_cost" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_purchases" ADD COLUMN IF NOT EXISTS "profit" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_sender_ids" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "sender_id" character varying(11) NOT NULL,
  "purpose" text,
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "provider_id" text,
  "submitted_by" uuid,
  "submitted_at" timestamp,
  "rejected_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "applied_by" character varying(255),
  "applied_email" character varying(255),
  "applied_phone" character varying(20),
  "rejection_notify_sent" boolean DEFAULT false NOT NULL,
  "rejection_notified_at" timestamp, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "sender_id" character varying(11);
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "purpose" text;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "provider_id" text;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "submitted_by" uuid;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "rejected_reason" text;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "is_system" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "applied_by" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "applied_email" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "applied_phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "rejection_notify_sent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_sender_ids" ADD COLUMN IF NOT EXISTS "rejection_notified_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_templates" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "message" text NOT NULL,
  "category" character varying(50),
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_templates" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_templates" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_templates" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_templates" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "sms_templates" ADD COLUMN IF NOT EXISTS "category" character varying(50);
--> statement-breakpoint
ALTER TABLE "sms_templates" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_transactions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "type" character varying(20) DEFAULT 'credit' NOT NULL,
  "credits" integer NOT NULL,
  "amount_tzs" integer DEFAULT 0 NOT NULL,
  "price_per_sms" integer DEFAULT 25 NOT NULL,
  "status" character varying(20) DEFAULT 'completed' NOT NULL,
  "reference" text,
  "snippe_reference" text,
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "type" character varying(20) DEFAULT 'credit' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "credits" integer;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "amount_tzs" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "price_per_sms" integer DEFAULT 25 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'completed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "reference" text;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "snippe_reference" text;
--> statement-breakpoint
ALTER TABLE "sms_transactions" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_user_campaigns" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "message" text NOT NULL,
  "sender_id" uuid,
  "recipients" jsonb,
  "total_recipients" integer DEFAULT 0 NOT NULL,
  "parts" integer DEFAULT 1 NOT NULL,
  "total_credits" integer DEFAULT 0 NOT NULL,
  "type" character varying(20) DEFAULT 'one_time' NOT NULL,
  "status" character varying(20) DEFAULT 'draft' NOT NULL,
  "scheduled_at" timestamp,
  "recurrence" character varying(20),
  "sent_at" timestamp,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "sender_id" uuid;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "recipients" jsonb;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "total_recipients" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "parts" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "total_credits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "type" character varying(20) DEFAULT 'one_time' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "recurrence" character varying(20);
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "sent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "sms_user_campaigns" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_adjustments" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "product_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "previous_quantity" integer NOT NULL,
  "new_quantity" integer NOT NULL,
  "difference" integer NOT NULL,
  "adjustment_type" character varying(50) NOT NULL,
  "reference_id" uuid,
  "approved_by" text,
  "notes" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "created_by" text NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "previous_quantity" integer;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "new_quantity" integer;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "difference" integer;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "adjustment_type" character varying(50);
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "reference_id" uuid;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "approved_by" text;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_take_items" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "session_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "system_quantity" numeric(12,4) DEFAULT 0 NOT NULL,
  "physical_quantity" numeric(12,4),
  "difference" integer DEFAULT 0,
  "notes" text,
  "counted_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "session_id" uuid;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "product_id" uuid;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "system_quantity" numeric(12,4) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "physical_quantity" numeric(12,4);
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "difference" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "counted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_take_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_take_sessions" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "shop_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "started_by" text NOT NULL,
  "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "ended_at" timestamp,
  "status" character varying(50) DEFAULT 'in_progress' NOT NULL,
  "notes" text,
  "approved_by" text,
  "approved_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "started_by" text;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "ended_at" timestamp;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "status" character varying(50) DEFAULT 'in_progress' NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "approved_by" text;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_take_sessions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_offers" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "title" character varying(255) NOT NULL,
  "description" text,
  "offer_type" character varying(50) DEFAULT 'discount' NOT NULL,
  "discount_percent" integer DEFAULT 0,
  "bonus_days" integer DEFAULT 0,
  "max_uses" integer,
  "used_count" integer DEFAULT 0,
  "expires_at" timestamp,
  "is_active" boolean DEFAULT true,
  "tenant_ids" uuid[],
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "title" character varying(255);
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "offer_type" character varying(50) DEFAULT 'discount' NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "discount_percent" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "bonus_days" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "max_uses" integer;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "used_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "tenant_ids" uuid[];
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_offers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_payments" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "snippe_reference" character varying(255) NOT NULL,
  "snippe_event_id" character varying(255),
  "amount_tzs" integer NOT NULL,
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "payment_channel" character varying(50),
  "payment_type" character varying(20),
  "customer_phone" character varying(20),
  "metadata" text,
  "paid_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "subscription_id" uuid;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "snippe_reference" character varying(255);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "snippe_event_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "amount_tzs" integer;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "payment_channel" character varying(50);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "payment_type" character varying(20);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "customer_phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "metadata" text;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "paid_at" timestamp;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_plans" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "name" character varying(100) NOT NULL,
  "price_tzs" integer NOT NULL,
  "full_price_tzs" integer NOT NULL,
  "discount_percent" integer DEFAULT 0 NOT NULL,
  "duration_days" integer DEFAULT 30 NOT NULL,
  "max_shops" integer,
  "max_sellers" integer,
  "description" text,
  "badge" character varying(50),
  "is_active" boolean DEFAULT true,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "name" character varying(100);
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "price_tzs" integer;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "full_price_tzs" integer;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "discount_percent" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "duration_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "max_shops" integer;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "max_sellers" integer;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "badge" character varying(50);
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_chats" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "user_id" text NOT NULL,
  "admin_id" text,
  "status" character varying(20) DEFAULT 'open' NOT NULL,
  "subject" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "admin_id" text;
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'open' NOT NULL;
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "subject" character varying(255);
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "support_chats" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_ticket_replies" (
  "reply_id" uuid,
  "chat_id" uuid,
  "replied_by" text,
  "reply" text,
  "created_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "support_ticket_replies" ADD COLUMN IF NOT EXISTS "reply_id" uuid;
--> statement-breakpoint
ALTER TABLE "support_ticket_replies" ADD COLUMN IF NOT EXISTS "chat_id" uuid;
--> statement-breakpoint
ALTER TABLE "support_ticket_replies" ADD COLUMN IF NOT EXISTS "replied_by" text;
--> statement-breakpoint
ALTER TABLE "support_ticket_replies" ADD COLUMN IF NOT EXISTS "reply" text;
--> statement-breakpoint
ALTER TABLE "support_ticket_replies" ADD COLUMN IF NOT EXISTS "created_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" uuid,
  "tenant_id" uuid,
  "user_id" text,
  "admin_id" text,
  "status" character varying(20),
  "subject" character varying(255),
  "created_at" timestamp,
  "updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "id" uuid;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "admin_id" text;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "status" character varying(20);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "subject" character varying(255);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "created_at" timestamp;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "updated_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_queue" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "device_id" character varying(255) NOT NULL,
  "operation_type" character varying(50) NOT NULL,
  "entity_type" character varying(50) NOT NULL,
  "offline_id" character varying(255) NOT NULL,
  "payload" text NOT NULL,
  "status" character varying(20) DEFAULT 'pending',
  "retry_count" integer DEFAULT 0,
  "error_message" text,
  "created_at" timestamp DEFAULT now(),
  "processed_at" timestamp, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "device_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "operation_type" character varying(50);
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "entity_type" character varying(50);
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "offline_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "payload" text;
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "error_message" text;
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
--> statement-breakpoint
ALTER TABLE "sync_queue" ADD COLUMN IF NOT EXISTS "processed_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_errors" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid,
  "shop_id" uuid,
  "error_type" character varying(100) NOT NULL,
  "message" text NOT NULL,
  "stack_trace" text,
  "user_id" character varying(255),
  "request_path" character varying(255),
  "request_method" character varying(10),
  "ip_address" character varying(45),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "error_type" character varying(100);
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "message" text;
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "stack_trace" text;
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "user_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "request_path" character varying(255);
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "request_method" character varying(10);
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "ip_address" character varying(45);
--> statement-breakpoint
ALTER TABLE "system_errors" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_settings" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "key" character varying(100) NOT NULL,
  "value" jsonb,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "key" character varying(100);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "value" jsonb;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_subscriptions" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "status" character varying(20) DEFAULT 'pending' NOT NULL,
  "current_period_start" timestamp,
  "current_period_end" timestamp,
  "snippe_reference" character varying(255),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "plan_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "current_period_start" timestamp;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "current_period_end" timestamp;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "snippe_reference" character varying(255);
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "name" character varying(255) NOT NULL,
  "slug" character varying(100) NOT NULL,
  "email" character varying(255),
  "is_active" boolean DEFAULT true,
  "plan_type" character varying(50) DEFAULT 'basic',
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "subscription_enabled" boolean DEFAULT true,
  "subscription_required" boolean DEFAULT true,
  "trial_start" timestamp,
  "trial_end" timestamp,
  "trial_activated" boolean DEFAULT false,
  "phone" character varying(20), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "slug" character varying(100);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan_type" character varying(50) DEFAULT 'basic';
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "subscription_enabled" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "subscription_required" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "trial_start" timestamp;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "trial_end" timestamp;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "trial_activated" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "phone" character varying(20);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user" (
  "id" character varying(255) NOT NULL,
  "email" character varying(255) NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "name" character varying(255),
  "image" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "banned" boolean DEFAULT false NOT NULL,
  "ban_reason" text,
  "ban_expires" timestamp,
  "role" character varying(50) DEFAULT 'user' NOT NULL,
  "tenant_id" character varying(255),
  "shop_id" character varying(255),
  "first_name" character varying(100),
  "last_name" character varying(100),
  "phone" character varying(20),
  "password_hash" character varying(255),
  "last_login_at" timestamp,
  "welcome_email_sent" boolean DEFAULT false,
  "welcome_email_sent_at" timestamp, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "id" character varying(255);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "name" character varying(255);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "image" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "banned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_reason" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_expires" timestamp;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "role" character varying(50) DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "tenant_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "shop_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "first_name" character varying(100);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "last_name" character varying(100);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "password_hash" character varying(255);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "welcome_email_sent" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "welcome_email_sent_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_feedback" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "days_used" integer DEFAULT 0 NOT NULL,
  "liked" text,
  "disliked" text,
  "suggestions" text,
  "status" character varying(20) DEFAULT 'new' NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "reviewed_at" timestamp, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "days_used" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "liked" text;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "disliked" text;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "suggestions" text;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'new' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_permissions" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "user_id" character varying(255) NOT NULL,
  "shop_id" uuid NOT NULL,
  "permission" character varying(100) NOT NULL,
  "granted" boolean DEFAULT true,
  "granted_by" character varying(255),
  "granted_at" timestamp DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "user_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "permission" character varying(100);
--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "granted" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "granted_by" character varying(255);
--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "granted_at" timestamp DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_shop_access" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "can_create_sales" boolean DEFAULT true,
  "can_view_reports" boolean DEFAULT false,
  "can_manage_inventory" boolean DEFAULT false,
  "created_at" timestamp DEFAULT now(), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "user_shop_access" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_shop_access" ADD COLUMN IF NOT EXISTS "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_shop_access" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_shop_access" ADD COLUMN IF NOT EXISTS "can_create_sales" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "user_shop_access" ADD COLUMN IF NOT EXISTS "can_view_reports" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "user_shop_access" ADD COLUMN IF NOT EXISTS "can_manage_inventory" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "user_shop_access" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_shops" (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "user_id" character varying(255) NOT NULL,
  "shop_id" uuid NOT NULL,
  "role" character varying(50) DEFAULT 'seller',
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "user_shops" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_shops" ADD COLUMN IF NOT EXISTS "user_id" character varying(255);
--> statement-breakpoint
ALTER TABLE "user_shops" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_shops" ADD COLUMN IF NOT EXISTS "role" character varying(50) DEFAULT 'seller';
--> statement-breakpoint
ALTER TABLE "user_shops" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "email" character varying(255) NOT NULL,
  "password_hash" character varying(255) NOT NULL,
  "first_name" character varying(100) NOT NULL,
  "last_name" character varying(100) NOT NULL,
  "phone" character varying(20),
  "role" text NOT NULL,
  "is_active" boolean DEFAULT true,
  "email_verified" boolean DEFAULT false,
  "last_login_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(), PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" character varying(255);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" character varying(255);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" character varying(100);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" character varying(100);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" character varying(20);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification" (
  "id" character varying(255) NOT NULL,
  "identifier" character varying(255) NOT NULL,
  "value" character varying(255) NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("id")
);
--> statement-breakpoint
ALTER TABLE "verification" ADD COLUMN IF NOT EXISTS "id" character varying(255);
--> statement-breakpoint
ALTER TABLE "verification" ADD COLUMN IF NOT EXISTS "identifier" character varying(255);
--> statement-breakpoint
ALTER TABLE "verification" ADD COLUMN IF NOT EXISTS "value" character varying(255);
--> statement-breakpoint
ALTER TABLE "verification" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "verification" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE "verification" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid WHERE c.relname = 'subscription_payments' AND a.attname = 'status' AND t.typname IN ('sub_payment_status')) THEN
    ALTER TABLE "subscription_payments" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "subscription_payments" ALTER COLUMN "status" TYPE character varying USING ("status")::character varying;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid WHERE c.relname = 'tenant_subscriptions' AND a.attname = 'status' AND t.typname IN ('subscription_status')) THEN
    ALTER TABLE "tenant_subscriptions" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "tenant_subscriptions" ALTER COLUMN "status" TYPE character varying USING ("status")::character varying;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid WHERE c.relname = 'sales' AND a.attname = 'payment_method' AND t.typname IN ('payment_method')) THEN
    ALTER TABLE "sales" ALTER COLUMN "payment_method" DROP DEFAULT;
    ALTER TABLE "sales" ALTER COLUMN "payment_method" TYPE character varying USING ("payment_method")::character varying;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid WHERE c.relname = 'debtors' AND a.attname = 'status' AND t.typname IN ('debt_status')) THEN
    ALTER TABLE "debtors" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "debtors" ALTER COLUMN "status" TYPE character varying USING ("status")::character varying;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid WHERE c.relname = 'admin_audit_log' AND a.attname = 'admin_id' AND t.typname IN ('uuid')) THEN
    ALTER TABLE "admin_audit_log" ALTER COLUMN "admin_id" DROP DEFAULT;
    ALTER TABLE "admin_audit_log" ALTER COLUMN "admin_id" TYPE text USING ("admin_id")::text;
  END IF;
END $$;
--> statement-breakpoint