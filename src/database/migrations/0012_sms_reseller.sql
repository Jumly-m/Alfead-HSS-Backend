--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_accounts" (
	"shop_id" uuid PRIMARY KEY REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"balance" integer NOT NULL DEFAULT 0,
	"total_bought" integer NOT NULL DEFAULT 0,
	"total_sent" integer NOT NULL DEFAULT 0,
	"low_balance_notified" boolean NOT NULL DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_sender_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"sender_id" varchar(11) NOT NULL,
	"purpose" text,
	"status" varchar(20) NOT NULL DEFAULT 'pending',
	"provider_id" text,
	"submitted_by" uuid,
	"submitted_at" timestamp,
	"rejected_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sms_sender_ids_shop_sender_unique" UNIQUE ("shop_id", "sender_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"recipient" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"parts" integer NOT NULL DEFAULT 1,
	"credits" integer NOT NULL DEFAULT 1,
	"cost" integer NOT NULL DEFAULT 0,
	"status" varchar(20) NOT NULL DEFAULT 'pending',
	"provider_message_id" text,
	"sender_id" varchar(11),
	"campaign_id" uuid,
	"source" varchar(20) NOT NULL DEFAULT 'manual',
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_messages_shop_id_idx" ON "sms_messages" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_messages_created_at_idx" ON "sms_messages" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_user_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"name" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"sender_id" uuid,
	"recipients" jsonb,
	"total_recipients" integer NOT NULL DEFAULT 0,
	"parts" integer NOT NULL DEFAULT 1,
	"total_credits" integer NOT NULL DEFAULT 0,
	"type" varchar(20) NOT NULL DEFAULT 'one_time',
	"status" varchar(20) NOT NULL DEFAULT 'draft',
	"scheduled_at" timestamp,
	"recurrence" varchar(20),
	"sent_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_user_campaigns_shop_id_idx" ON "sms_user_campaigns" USING btree ("shop_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"name" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"category" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"name" varchar(255),
	"phone" varchar(20) NOT NULL,
	"email" varchar(255),
	"group_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sms_contacts_shop_phone_unique" UNIQUE ("shop_id", "phone")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_contacts_shop_id_idx" ON "sms_contacts" USING btree ("shop_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"type" varchar(20) NOT NULL DEFAULT 'credit',
	"credits" integer NOT NULL,
	"amount_tzs" integer NOT NULL DEFAULT 0,
	"price_per_sms" integer NOT NULL DEFAULT 25,
	"status" varchar(20) NOT NULL DEFAULT 'completed',
	"reference" text,
	"snippe_reference" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_transactions_shop_id_idx" ON "sms_transactions" USING btree ("shop_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE NOT NULL,
	"credits" integer NOT NULL,
	"amount_tzs" integer NOT NULL,
	"price_per_sms" integer NOT NULL,
	"phone_number" varchar(20),
	"snippe_reference" text,
	"status" varchar(20) NOT NULL DEFAULT 'pending',
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_purchases_shop_id_idx" ON "sms_purchases" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_purchases_snippe_reference_idx" ON "sms_purchases" USING btree ("snippe_reference");
