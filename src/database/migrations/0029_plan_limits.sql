-- Plan limits & feature entitlements (per-plan limits + trial limits)
ALTER TABLE subscription_plans ADD COLUMN max_products INTEGER;
--> statement-breakpoint
ALTER TABLE subscription_plans ADD COLUMN max_admins INTEGER;
--> statement-breakpoint
ALTER TABLE subscription_plans ADD COLUMN features JSONB;
--> statement-breakpoint
ALTER TABLE subscription_plans ADD COLUMN limits_effective_from TIMESTAMP;
--> statement-breakpoint
ALTER TABLE subscription_plans ADD COLUMN limits_apply_mode VARCHAR(20) DEFAULT 'new';
--> statement-breakpoint
ALTER TABLE subscription_plans ADD COLUMN full_access BOOLEAN DEFAULT FALSE;
