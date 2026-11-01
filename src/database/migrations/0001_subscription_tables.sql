CREATE TYPE "public"."subscription_status" AS ENUM('active', 'expired', 'pending', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sub_payment_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"price_tzs" integer NOT NULL,
	"full_price_tzs" integer NOT NULL,
	"discount_percent" integer DEFAULT 0 NOT NULL,
	"duration_days" integer DEFAULT 30 NOT NULL,
	"description" text,
	"badge" varchar(50),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tenant_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'pending' NOT NULL,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"snippe_reference" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"snippe_reference" varchar(255) NOT NULL,
	"snippe_event_id" varchar(255),
	"amount_tzs" integer NOT NULL,
	"status" "sub_payment_status" DEFAULT 'pending' NOT NULL,
	"payment_channel" varchar(50),
	"payment_type" varchar(20),
	"customer_phone" varchar(20),
	"metadata" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "subscription_payments_snippe_reference_unique" UNIQUE("snippe_reference")
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"action" varchar(100) NOT NULL,
	"target_tenant_id" uuid,
	"target_subscription_id" uuid,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscription_id_tenant_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."tenant_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_id_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sub_tenant_id_idx" ON "tenant_subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sub_status_idx" ON "tenant_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subpay_tenant_id_idx" ON "subscription_payments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "subpay_ref_idx" ON "subscription_payments" USING btree ("snippe_reference");--> statement-breakpoint
-- Seed default subscription plans
INSERT INTO "subscription_plans" ("name", "price_tzs", "full_price_tzs", "discount_percent", "duration_days", "description", "badge", "is_active") VALUES
('Basic Monthly', 15000, 15000, 0, 30, 'Full access for 30 days', NULL, true),
('3-Month Plan', 40500, 45000, 10, 90, 'Save 10% — pay once, use 3 months', 'Popular', true),
('6-Month Plan', 72000, 90000, 20, 180, 'Save 20% — best for growing teams', 'Great Deal', true),
('Annual Plan', 120000, 180000, 33, 365, 'Save 33% — full year access', 'Best Value', true)
ON CONFLICT DO NOTHING;