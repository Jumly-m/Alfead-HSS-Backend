import adminRoutes from "./modules/auth/admin.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import backupRoutes from "./modules/backup/backup.routes.js";
import bcrypt from "bcryptjs";
import cache, { CACHE_KEYS, invalidateCache } from "./utils/cache.js";
import debtorRoutes from "./modules/debtors/debtor.routes.js";
import dotenv from "dotenv";
import emailRoutes from "./modules/email/email.routes.js";
import emailManagementRoutes from "./modules/email/email-management.routes.js";
import expenseRoutes from "./modules/expenses/expense.routes.js";
import exportRoutes from "./modules/export/export.routes.js";
import feedbackRoutes from "./modules/feedback/feedback.routes.js";
import landingRoutes from "./modules/landing/landing.routes.js";
import fs from "fs";
import path from "path";
import performanceRoutes from "./modules/performance/performance.routes.js";
import preorderRoutes from "./modules/preorders/preorder.routes.js";
import productRoutes from "./modules/products/product.routes.js";
import publicRoutes from "./modules/public/public.routes.js";
import saleRoutes from "./modules/sales/sale.routes.js";
import { saleService } from "./modules/sales/sale.service.js";
import shopRoutes, { listShopsForUser } from "./modules/shops/shop.routes.js";
import shopMembersRoutes from "./modules/shop-members/shop-members.routes.js";
import stockTakeRoutes from "./modules/stock-take/stock-take.routes.js";
import subscriptionRoutes from "./modules/subscriptions/subscription.routes.js";
import subscriptionAdminRoutes from "./modules/subscriptions/subscription.admin.routes.js";
import superAdminRoutes from "./modules/admin/super-admin.routes.js";
import backupNotificationsRoutes from "./modules/backup-notifications/backup-notifications.routes.js";
import smsRoutes from "./modules/sms/sms.routes.js";
import smsUserRoutes from "./modules/sms/sms-user.routes.js";
import systemConfigRoutes from "./modules/system/system-config.routes.js";
import unitRoutes from "./modules/units/unit.routes.js";
import { ensureShopUnitsSchema } from "./modules/units/unit.service.js";
import customerRoutes from "./modules/customers/customer.routes.js";
import aiRoutes from "./modules/ai/ai.routes.js";
import webhookRoutes from "./modules/webhooks/webhook.routes.js";
import categoryRoutes from "./modules/categories/category.routes.js";
import combinedRoutes from "./modules/combined/combined.routes.js";
import serviceRoutes from "./modules/services/service.routes.js";
import supplierRoutes from "./modules/suppliers/supplier.routes.js";
import storeRoutes from "./modules/store/store.routes.js";
import receiptRoutes from "./modules/receipts/receipt.routes.js";
import notesRoutes, { ensureNotesSchema } from "./modules/notes/notes.routes.js";
import { brotliCompressSync, gzipSync } from "zlib";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { fileURLToPath } from "url";
import { auth } from "./auth.js";
import { pool } from "./config/drizzle.js";
import { db } from "./config/database.js";
import { SERVER_CONFIG, DEBUG_LOGS, STARTUP_SCHEMA, OFFLINE_MODE } from "./config/index.js";
import { removePasswordPrefix } from "./database/fix-password-prefix.js";
import { authMiddleware, invalidateUserAuthCache } from "./middleware/auth.middleware.js";
import { errorHandler } from "./middleware/error.middleware.js";
import { subscriptionGuard } from "./middleware/subscription.middleware.js";
import { hasPermission } from "./middleware/rbac.middleware.js";
import { requirePermission } from "./middleware/rbac.middleware.js";
import { backupScheduler } from "./modules/backup/backup.scheduler.js";
import { checkRequiredEnvVars, initializeSuperAdminShop } from "./utils/startup.js";
import { ensurePlanLimitSetup } from "./services/plan-limits.service.js";
import { acquireLeaderLease } from "./utils/leader-lease.js";
import { waitForDatabase, runMigrations } from "./database/migrate.js";
import { bootstrapSystemSenders, handleAutoSmsOnSale, handleAdminSaleSmsOnSale } from "./services/sms-reseller.service.js";
import { sendSupportMessageAlert } from "./services/email.service.js";
import { generateSupportReply, supportFallbackMessage } from "./services/support-ai.service.js";
import { startDailySalesReportCron, ensureDailyReportTable, sendDailySalesReports } from "./jobs/dailySalesReport.js";
import { blogPublicRoutes, blogDevRoutes, ensureBlogTables } from "./modules/blog/blog.routes.js";
import referralRoutes, { ensureReferralSchema } from "./modules/referrals/referral.routes.js";
import { startSmsCampaignCron } from "./jobs/smsCampaignScheduler.js";
import { startUserSmsCampaignCron } from "./jobs/smsUserCampaignScheduler.js";
import { startProviderWalletMonitor } from "./jobs/providerWalletMonitor.js";
import { startQueuedSmsFlusher } from "./jobs/queuedSmsFlusher.js";
import { startAutoSmsReminderCron } from "./jobs/smsAutoReminders.js";
import { startSenderIdStatusSyncCron } from "./jobs/senderIdStatusSync.js";
import { startSmsDeliverySync } from "./jobs/smsDeliverySync.js";
import { startSmsPurchaseReconcileCron } from "./jobs/smsPurchaseReconcile.js";
import { logSnippeConfigStatus } from "./services/snippe.service.js";
import { startExpiryReminderCron } from "./jobs/expiryReminders.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_FILE = path.join(__dirname, '..', 'auth-debug.log');
// Auth debug logging is opt-in. In production, this function must stay off the
// hot path: fs.appendFileSync is a synchronous disk write on every /api/auth/* request,
// which measurably slows down login and grows the log file without bound.
const DEBUG_AUTH = process.env.DEBUG_AUTH === 'true';
function debugLog(msg: string) {
  if (!DEBUG_AUTH) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log(msg);
}


// Routes

dotenv.config({ quiet: true });

// Startup checks
console.log('\n🔍 Running startup checks...\n');

const envOk = checkRequiredEnvVars();
if (!envOk) {
  console.error('\n❌ Startup failed: Missing environment variables');
  process.exit(1);
}

console.log('\n🔄 Connecting to database (with retries)...\n');
const dbOk = await waitForDatabase();

if (!dbOk) {
  console.warn('\n⚠️  Warning: Database not connected after retries');
  console.warn('   Server will start but database operations will fail');
  console.warn('   To fix: Ensure PostgreSQL is running and run:');
  console.warn(`   createdb ${process.env.DB_NAME || 'hardware'} && npm run db:migrate\n`);
}

if (dbOk && !STARTUP_SCHEMA) {
  console.log('\n⏭️  RUN_STARTUP_SCHEMA=false — skipping migrations/schema checks. Make sure `npm run db:migrate` runs at deploy time.\n');
}

if (dbOk && STARTUP_SCHEMA) {
  console.log('\n🔄 Running database migrations...\n');
  await runMigrations();
  if (!OFFLINE_MODE) {
    try {
      await bootstrapSystemSenders();
    } catch (e: any) {
      console.warn('  ⚠️  System sender bootstrap skipped:', e.message);
    }
  }
  try {
    // Enable uuid-ossp extension
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    console.log('✅ UUID extension enabled');

    // Ensure Better Auth tables exist FIRST — auth queries depend on these
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user" (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        name VARCHAR(255), image TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        banned BOOLEAN NOT NULL DEFAULT FALSE,
        ban_reason TEXT, ban_expires TIMESTAMP,
        role VARCHAR(50) NOT NULL DEFAULT 'user',
        tenant_id VARCHAR(255), shop_id VARCHAR(255),
        first_name VARCHAR(100), last_name VARCHAR(100),
        phone VARCHAR(20), password_hash VARCHAR(255)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        ip_address VARCHAR(45), user_agent TEXT,
        impersonated_by TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "account" (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        account_id VARCHAR(255) NOT NULL, provider_id VARCHAR(255) NOT NULL,
        access_token TEXT, refresh_token TEXT, id_token TEXT,
        access_token_expires_at TIMESTAMP, refresh_token_expires_at TIMESTAMP,
        scope TEXT, password VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "verification" (
        id VARCHAR(255) PRIMARY KEY,
        identifier VARCHAR(255) NOT NULL, value VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`SELECT 1 FROM "session" LIMIT 1`);
    console.log('✅ Better Auth tables created');

    // Check and fix existing tables instead of dropping them
    // This preserves user data across restarts
    console.log('🔍 Checking database schema...');
    
    // Check if user table has wrong UUID type and fix if needed (without dropping data)
    try {
      const userIdType = await pool.query(`
        SELECT data_type FROM information_schema.columns 
        WHERE table_name = 'user' AND column_name = 'id'
      `);
      
      if (userIdType.rows.length > 0 && userIdType.rows[0].data_type === 'uuid') {
        console.log('  ⚠️  Converting user table id from UUID to VARCHAR...');
        // Drop constraints first
        await pool.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS session_user_id_fkey`);
        await pool.query(`ALTER TABLE account DROP CONSTRAINT IF EXISTS account_user_id_fkey`);
        
        await pool.query(`ALTER TABLE "user" ALTER COLUMN id TYPE VARCHAR(255)`);
        await pool.query(`ALTER TABLE "session" ALTER COLUMN user_id TYPE VARCHAR(255)`);
        await pool.query(`ALTER TABLE account ALTER COLUMN user_id TYPE VARCHAR(255)`);
        
        // Recreate constraints
        await pool.query(`ALTER TABLE "session" ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE`);
        await pool.query(`ALTER TABLE account ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE`);
        
        console.log('  ✅ Converted user table id to VARCHAR');
      } else {
        console.log('  ✅ User table schema is correct');
      }
    } catch (e) {
      console.log('  ⚠️  User table check:', (e as Error).message);
    }
    
    console.log('✅ Schema check complete - user data preserved');

    // Create inbound_emails table for Resend webhook receiving
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS inbound_emails (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email_id VARCHAR(255) UNIQUE NOT NULL,
          message_id VARCHAR(255),
          "from" VARCHAR(512) NOT NULL,
          "to" TEXT[] NOT NULL DEFAULT '{}',
          cc TEXT[] DEFAULT '{}',
          bcc TEXT[] DEFAULT '{}',
          subject TEXT,
          html_body TEXT,
          text_body TEXT,
          headers JSONB DEFAULT '{}',
          attachments JSONB DEFAULT '[]',
          replied_at TIMESTAMP,
          reply_html TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbound_emails_email_id ON inbound_emails(email_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbound_emails_created_at ON inbound_emails(created_at DESC)`);
      console.log('✅ inbound_emails table ready');
    } catch (e) {
      console.log('  ⚠️  inbound_emails table check:', (e as Error).message);
    }
    
    // Fix sales.seller_id if it's UUID (should be VARCHAR for Better Auth IDs)
    try {
      const sellerIdType = await pool.query(`
        SELECT data_type FROM information_schema.columns 
        WHERE table_name = 'sales' AND column_name = 'seller_id'
      `);
      
      if (sellerIdType.rows.length > 0 && sellerIdType.rows[0].data_type === 'uuid') {
        console.log('  ⚠️  Converting sales.seller_id from UUID to VARCHAR...');
        // Drop FK constraint first if exists
        await pool.query(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_seller_id_users_id_fk`);
        // Convert column type
        await pool.query(`ALTER TABLE sales ALTER COLUMN seller_id TYPE VARCHAR(255)`);
        console.log('  ✅ Converted sales.seller_id to VARCHAR');
      }
    } catch (e) {
      console.log('  ⚠️  Sales table check:', (e as Error).message);
    }
    
    // Create all core tables using raw SQL
    await pool.query(`
      -- Tenants table
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        email VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        plan_type VARCHAR(50) DEFAULT 'basic',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Prevent duplicate tenants for same email (stops double shop creation)
      CREATE UNIQUE INDEX IF NOT EXISTS tenants_email_unique ON tenants (email) WHERE email IS NOT NULL;
      
      -- Shops table
      CREATE TABLE IF NOT EXISTS shops (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50),
        address TEXT,
        phone VARCHAR(20),
        email VARCHAR(255),
        is_super_admin BOOLEAN DEFAULT FALSE,
        business_name VARCHAR(255),
        branch_name VARCHAR(255),
        serial_number VARCHAR(50),
        logo TEXT,
        invoice_footer TEXT,
        type VARCHAR(20) NOT NULL DEFAULT 'shop',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Store / Back office (Ghala): shops flagged type='store'. Added for
      -- existing databases where the shops table already exists.
      DO $$ BEGIN
        ALTER TABLE shops ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'shop';
        CREATE INDEX IF NOT EXISTS shops_type_idx ON shops(type);
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Store -> shop transfers: stock lands in the destination shop the
      -- moment the store issues the goods. stock_applied_at guards against
      -- applying the same goods twice when the shop confirms receipt.
      DO $$ BEGIN
        ALTER TABLE store_requests ADD COLUMN IF NOT EXISTS stock_applied_at TIMESTAMP;
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Store receipts: how the goods were paid for (cash / credit-deni) so
      -- the owner can see supplier debt on store stock.
      DO $$ BEGIN
        ALTER TABLE store_receipts ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'paid';
        ALTER TABLE store_receipts ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) DEFAULT 0;
        ALTER TABLE store_receipts ADD COLUMN IF NOT EXISTS due_date DATE;
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Thermal receipts: unique receipt number, public verification token and
      -- print/reprint audit trail. receipt_counters holds the per-shop,
      -- per-month sequence (e.g. JB-202609-000125).
      DO $$ BEGIN
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(60);
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_token VARCHAR(40);
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS printed_at TIMESTAMP;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS print_count INTEGER DEFAULT 0;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS last_printed_by TEXT;
      EXCEPTION WHEN others THEN NULL;
      END $$;
      CREATE TABLE IF NOT EXISTS receipt_counters (
        shop_id UUID NOT NULL,
        period VARCHAR(6) NOT NULL,
        last_number INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (shop_id, period)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sales_receipt_number_uidx ON sales(receipt_number) WHERE receipt_number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS sales_receipt_token_uidx ON sales(receipt_token) WHERE receipt_token IS NOT NULL;
      
      -- Categories table
      CREATE TABLE IF NOT EXISTS categories (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        color VARCHAR(7),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Products table
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        sku VARCHAR(100),
        barcode VARCHAR(100),
        qr_code VARCHAR(100),
        description TEXT,
        buying_price DECIMAL(12,2) DEFAULT 0,
        selling_price DECIMAL(12,2) DEFAULT 0,
        current_stock DECIMAL(12,4) DEFAULT 0,
        low_stock_threshold DECIMAL(12,4) DEFAULT 10,
        enable_fractions BOOLEAN DEFAULT FALSE,
        fraction_types JSONB DEFAULT '[]',
        fraction_prices JSONB DEFAULT '{}',
        expiry_date TIMESTAMP,
        images TEXT[],
        is_active BOOLEAN DEFAULT TRUE,
        created_by TEXT,
        cost_per_qty DECIMAL(12,4) DEFAULT 1,
        cost_per_qty_price DECIMAL(12,2) DEFAULT 0,
        cost_per_qty_buy_price DECIMAL(12,2) DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Add cost_per_qty columns for existing databases
      DO $$ BEGIN
        ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_per_qty DECIMAL(12,4) DEFAULT 1;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_per_qty_price DECIMAL(12,2) DEFAULT 0;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_per_qty_buy_price DECIMAL(12,2) DEFAULT 0;
      EXCEPTION WHEN others THEN NULL;
      END $$;
      
      -- Sales table
      CREATE TABLE IF NOT EXISTS sales (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        seller_id VARCHAR(255) NOT NULL,
        offline_id VARCHAR(255),
        total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
        amount_paid DECIMAL(12,2) DEFAULT 0,
        change_due DECIMAL(12,2) DEFAULT 0,
        discount_amount DECIMAL(12,2) DEFAULT 0,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(20),
        customer_email VARCHAR(255),
        invoice_sent BOOLEAN DEFAULT FALSE,
        due_date TIMESTAMP,
        payment_reference VARCHAR(255),
        verification_code VARCHAR(100),
        notes TEXT,
        payment_status VARCHAR(20) DEFAULT 'pending',
        customer_company VARCHAR(255),
        bank_name VARCHAR(100),
        sale_type VARCHAR(20) DEFAULT 'normal',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Add sale_type column for existing databases
      DO $$ BEGIN
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_type VARCHAR(20) DEFAULT 'normal';
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Offline/POS idempotency: a client sale reference may only ever appear
      -- once, so a queued sale replayed after a lost response is never
      -- duplicated (and stock is never deducted twice).
      DO $$ BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS sales_offline_id_unique
          ON sales (offline_id) WHERE offline_id IS NOT NULL;
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Invoice payments tracking (for partial payments)
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        amount DECIMAL(12,2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'cash',
        payment_reference VARCHAR(255),
        notes TEXT,
        recorded_by VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Customers table (standalone customer registry)
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(255),
        company VARCHAR(255),
        address TEXT,
        tin VARCHAR(50),
        notes TEXT,
        is_returned BOOLEAN DEFAULT FALSE,
        return_count INTEGER DEFAULT 0,
        total_visits INTEGER DEFAULT 0,
        total_spent DECIMAL(12,2) DEFAULT 0,
        last_purchase_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      DO $$ BEGIN
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS return_count INTEGER DEFAULT 0;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_returned BOOLEAN DEFAULT FALSE;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_visits INTEGER DEFAULT 0;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_spent DECIMAL(12,2) DEFAULT 0;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMP;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS company VARCHAR(255);
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS tin VARCHAR(50);
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS vrn VARCHAR(50);
      EXCEPTION WHEN others THEN NULL;
      END $$;
      
      -- Sale items table
      CREATE TABLE IF NOT EXISTS sale_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        product_name VARCHAR(255) NOT NULL,
        quantity DECIMAL(12,4) NOT NULL,
        fraction_type VARCHAR(20) DEFAULT 'whole',
        unit_price DECIMAL(12,2) NOT NULL,
        discount DECIMAL(12,2) DEFAULT 0,
        buying_price_at_sale DECIMAL(12,2) DEFAULT 0,
        total_price DECIMAL(12,2) NOT NULL,
        profit DECIMAL(12,2) DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Better Auth - User table
      CREATE TABLE IF NOT EXISTS "user" (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        name VARCHAR(255),
        image TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        banned BOOLEAN NOT NULL DEFAULT FALSE,
        ban_reason TEXT,
        ban_expires TIMESTAMP,
        role VARCHAR(50) NOT NULL DEFAULT 'user',
        tenant_id VARCHAR(255),
        shop_id VARCHAR(255),
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        phone VARCHAR(20),
        password_hash VARCHAR(255),
        last_login_at TIMESTAMP
      );
      
      -- Better Auth - Session table
      CREATE TABLE IF NOT EXISTS "session" (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        impersonated_by TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Better Auth - Account table
      CREATE TABLE IF NOT EXISTS account (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        account_id VARCHAR(255) NOT NULL,
        provider_id VARCHAR(255) NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        id_token TEXT,
        access_token_expires_at TIMESTAMP,
        refresh_token_expires_at TIMESTAMP,
        scope TEXT,
        password VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Trigger function to create credential account after user creation
      -- DISABLED: Better Auth handles account creation automatically
      -- This trigger was causing duplicate key violations with Better Auth
      -- CREATE OR REPLACE FUNCTION create_credential_account()
      -- RETURNS TRIGGER AS $$
      -- BEGIN
      --   INSERT INTO account (id, user_id, account_id, provider_id, created_at, updated_at)
      --   VALUES (NEW.id, NEW.id, NEW.id, 'credential', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      --   ON CONFLICT DO NOTHING;
      --   RETURN NEW;
      -- END;
      -- $$ LANGUAGE plpgsql;
      
      -- Create trigger for user creation
      -- DISABLED: Better Auth handles account creation
      -- DROP TRIGGER IF EXISTS create_credential_account_trigger ON "user";
      -- CREATE TRIGGER create_credential_account_trigger
      -- AFTER INSERT ON "user"
      -- FOR EACH ROW
      -- EXECUTE FUNCTION create_credential_account();
      
      -- Better Auth - Verification table
      CREATE TABLE IF NOT EXISTS verification (
        id VARCHAR(255) PRIMARY KEY,
        identifier VARCHAR(255) NOT NULL,
        value VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- User shops table
      CREATE TABLE IF NOT EXISTS user_shops (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id VARCHAR(255) NOT NULL,
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'seller',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, shop_id)
      );
      
      -- User permissions table
      CREATE TABLE IF NOT EXISTS user_permissions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id VARCHAR(255) NOT NULL,
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        permission VARCHAR(100) NOT NULL,
        granted BOOLEAN DEFAULT true,
        granted_by VARCHAR(255),
        granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, shop_id, permission)
      );
      
      -- Activity Logs table
      CREATE TABLE IF NOT EXISTS activity_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id UUID,
        shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
        user_id VARCHAR(255),
        user_name VARCHAR(255),
        user_email VARCHAR(255),
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id UUID,
        details JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Login History table
      CREATE TABLE IF NOT EXISTS login_history (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id VARCHAR(255),
        user_email VARCHAR(255),
        user_name VARCHAR(255),
        login_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        logout_at TIMESTAMP,
        ip_address VARCHAR(45),
        user_agent TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'success',
        failure_reason TEXT
      );
      
      -- System Errors table
      CREATE TABLE IF NOT EXISTS system_errors (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id UUID,
        shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
        error_type VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        stack_trace TEXT,
        user_id VARCHAR(255),
        request_path VARCHAR(255),
        request_method VARCHAR(10),
        ip_address VARCHAR(45),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Indexes for login_history
      CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_login_history_login_at ON login_history(login_at);
      CREATE INDEX IF NOT EXISTS idx_login_history_status ON login_history(status);
      
      -- Indexes for system_errors
      CREATE INDEX IF NOT EXISTS idx_system_errors_created_at ON system_errors(created_at);
      CREATE INDEX IF NOT EXISTS idx_system_errors_error_type ON system_errors(error_type);
      CREATE INDEX IF NOT EXISTS idx_system_errors_shop_id ON system_errors(shop_id);
      
      -- Settings table (using key-value approach)
      CREATE TABLE IF NOT EXISTS settings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
        key VARCHAR(100) NOT NULL,
        value JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(shop_id, key)
      );
      
      -- Insert default settings if not exists
      INSERT INTO settings (key, value) 
       SELECT 'system', '{"systemName":"ALFEAN ENTERPRISES","systemDescription":"Store Management","currency":"TSh","receiptFooter":"Thank you for your business!","showLogoOnInvoice":true}'
      WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'system');

      -- One-time rebrand: any existing global settings row still carrying the
      -- old system name is updated so the rename applies to live databases too.
      -- Wrapped so an unexpected settings shape can never abort the rest of the
      -- schema migration (the whole block is one implicit transaction).
      DO $$ BEGIN
        UPDATE settings
           SET value = jsonb_set(value, '{systemName}', '"ALFEAN ENTERPRISES"'),
               updated_at = CURRENT_TIMESTAMP
         WHERE key = 'system' AND value->>'systemName' = 'ALFEAN ENTERPRISES';
      EXCEPTION WHEN others THEN NULL;
      END $$;
      
      -- System-wide settings (global, not tenant-specific)
      CREATE TABLE IF NOT EXISTS system_settings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        key VARCHAR(100) NOT NULL UNIQUE,
        value JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Insert default system settings
      INSERT INTO system_settings (key, value)
      VALUES 
        ('subscription', '{"enabled": false, "grace_period_days": 3, "trial_days": 7}')
      ON CONFLICT (key) DO NOTHING;
      
      -- Subscription offers table
      CREATE TABLE IF NOT EXISTS subscription_offers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        offer_type VARCHAR(50) NOT NULL DEFAULT 'discount',
        discount_percent INTEGER DEFAULT 0,
        bonus_days INTEGER DEFAULT 0,
        max_uses INTEGER,
        used_count INTEGER DEFAULT 0,
        expires_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        tenant_ids UUID[], -- NULL means all tenants
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
      CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
      CREATE INDEX IF NOT EXISTS idx_products_active ON products(shop_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_products_low_stock ON products(shop_id, current_stock, low_stock_threshold);
      CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      CREATE INDEX IF NOT EXISTS idx_users_email ON "user"(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON "user"(role);
      CREATE INDEX IF NOT EXISTS idx_users_tenant ON "user"(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_shops_tenant ON shops(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_categories_shop ON categories(shop_id);
      CREATE INDEX IF NOT EXISTS idx_sales_shop ON sales(shop_id);
      CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
      CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
      CREATE INDEX IF NOT EXISTS idx_session_user ON "session"(user_id);
      CREATE INDEX IF NOT EXISTS idx_session_token ON "session"(token);
      CREATE INDEX IF NOT EXISTS idx_account_user ON account(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_shops_user ON user_shops(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_shops_shop ON user_shops(shop_id);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_shop ON activity_logs(shop_id);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(is_active);
      -- Performance indexes for dashboard/sales/expense aggregates
      CREATE INDEX IF NOT EXISTS idx_sales_shop_created ON sales(shop_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sales_shop_payment ON sales(shop_id, payment_method);
      CREATE INDEX IF NOT EXISTS idx_sales_payment_status ON sales(payment_status);
      CREATE INDEX IF NOT EXISTS idx_sales_sale_type ON sales(sale_type);
      CREATE INDEX IF NOT EXISTS idx_invoice_payments_sale ON invoice_payments(sale_id);
      CREATE INDEX IF NOT EXISTS idx_invoice_payments_created ON invoice_payments(created_at);
      CREATE INDEX IF NOT EXISTS idx_debt_payments_debtor ON debt_payments(debtor_id);
      CREATE INDEX IF NOT EXISTS idx_debt_payments_created ON debt_payments(created_at);
      CREATE INDEX IF NOT EXISTS idx_debtors_shop ON debtors(shop_id);
      CREATE INDEX IF NOT EXISTS idx_debtors_status ON debtors(status);
      CREATE INDEX IF NOT EXISTS idx_pre_order_payments_preorder ON pre_order_payments(pre_order_id);
      CREATE INDEX IF NOT EXISTS idx_pre_orders_created ON pre_orders(created_at);
      CREATE INDEX IF NOT EXISTS idx_products_shop_stock ON products(shop_id, current_stock);
      CREATE INDEX IF NOT EXISTS idx_customers_shop ON customers(shop_id);
    `);
    console.log('✅ Database tables created');
  } catch (e: any) {
    console.log('⚠️  Migration error:', e.message);
  }

  // Search & scale indexes. pg_trgm powers fast ILIKE '%term%' search used by
  // the POS product picker, products page, customer/debtor search — critical
  // when a shop has 1000+ products. Isolated in its own try/catch: if the
  // extension is unavailable the app still starts and search falls back to
  // sequential scans.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON products USING gin (sku gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_products_barcode_trgm ON products USING gin (barcode gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_customers_phone_trgm ON customers USING gin (phone gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_debtors_name_trgm ON debtors USING gin (customer_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_debtors_phone_trgm ON debtors USING gin (customer_phone gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_products_shop_name ON products(shop_id, name);
      CREATE INDEX IF NOT EXISTS idx_products_shop_updated ON products(shop_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_products_shop_active_name ON products(shop_id, is_active, name);
      CREATE INDEX IF NOT EXISTS idx_sales_shop_created_id ON sales(shop_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_sales_shop_payment_status ON sales(shop_id, payment_status);
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale_product ON sale_items(sale_id, product_id);
      CREATE INDEX IF NOT EXISTS idx_debt_payments_debtor_created ON debt_payments(debtor_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_invoice_payments_sale_created ON invoice_payments(sale_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pre_order_payments_order_created ON pre_order_payments(pre_order_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pre_orders_shop_created ON pre_orders(shop_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_service_records_shop_created_at ON service_records(shop_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_debtors_shop_created ON debtors(shop_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_expenses_shop_date ON expenses(shop_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_customers_shop_name ON customers(shop_id, name);
    `);
    console.log('✅ Search & performance indexes ready');
  } catch (e: any) {
    console.log('⚠️  Search index migration skipped:', e.message);
  }
}

// Add is_super_admin column to shops if not exists
if (dbOk && STARTUP_SCHEMA) {
  try {
    await pool.query(`
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE
    `);
    console.log('✅ Shops table updated with is_super_admin column');
  } catch (e: any) {
    console.log('⚠️  is_super_admin column might already exist:', e.message);
  }

  // Add source column to sales for chat/POS tracking
  try {
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS source VARCHAR(10) DEFAULT 'pos'`);
    console.log('✅ Sales table updated with source column');
  } catch (e: any) {
    console.log('⚠️  source column might already exist:', e.message);
  }

  // Add missing shop detail columns (for business info, invoicing)
  try {
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS business_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS serial_number VARCHAR(50)`);
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo TEXT`);
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS invoice_footer TEXT`);
    console.log('✅ Shops table updated with business detail columns');
  } catch (e: any) {
    console.log('⚠️  Shops business detail columns might already exist:', e.message);
  }

  // Guarantee optional customer columns exist. These used to live in a shared
  // DO-block whose EXCEPTION could abort the remaining ALTERs, leaving
  // customers.vrn missing and breaking customer creation with
  // 'column "vrn" of relation "customers" does not exist'.
  try {
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS tin VARCHAR(50)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS vrn VARCHAR(50)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS company VARCHAR(255)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT`);
    console.log('✅ Customers table updated with tin/vrn/company/address/notes columns');
  } catch (e: any) {
    console.log('⚠️  Customers columns check:', e.message);
  }

  // Add subscription control columns to tenants if not exist
  try {
    await pool.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_enabled BOOLEAN DEFAULT TRUE
    `);
    await pool.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_required BOOLEAN DEFAULT TRUE
    `);
    console.log('✅ Tenants table updated with subscription columns');
  } catch (e: any) {
    console.log('⚠️  Tenant subscription columns might already exist:', e.message);
  }

  // Add missing columns to categories table
  try {
    await pool.query(`
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS color VARCHAR(7)
    `);
    console.log('✅ Categories table updated with color column');
  } catch (e: any) {
    console.log('⚠️  Categories color column might already exist:', e.message);
  }

  // Add missing columns to products table
  try {
    await pool.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS qr_code VARCHAR(100)
    `);
    await pool.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMP
    `);
    await pool.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT[]
    `);
    await pool.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by TEXT
    `);
    console.log('✅ Products table updated with missing columns');
  } catch (e: any) {
    console.log('⚠️  Products columns might already exist:', e.message);
  }

  // Fix activity_logs table - add missing columns if they don't exist
  try {
    await pool.query(`
      ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS user_name VARCHAR(255)
    `);
    await pool.query(`
      ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS user_email VARCHAR(255)
    `);
    console.log('✅ Activity logs columns added');
  } catch (e: any) {
    console.log('⚠️  Activity logs column fix:', e.message);
  }
  
  // Add last_login_at to user table for activity monitoring
  try {
    await pool.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP
    `);
    console.log('✅ User table updated with last_login_at column');
  } catch (e: any) {
    console.log('⚠️  last_login_at column might already exist:', e.message);
  }
  
  // Add welcome_email_sent columns for tracking welcome emails on signups
  try {
    await pool.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS welcome_email_sent BOOLEAN DEFAULT FALSE
    `);
    await pool.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMP
    `);
    console.log('✅ User table updated with welcome_email tracking columns');
  } catch (e: any) {
    console.log('⚠️  welcome_email columns might already exist:', e.message);
  }
  
  // Fix Better Auth user table columns if they have wrong types
  try {
    // Check if user.id is UUID and convert to VARCHAR if needed
    const userIdType = await pool.query(`
      SELECT data_type FROM information_schema.columns 
      WHERE table_name = 'user' AND column_name = 'id'
    `);
    
    if (userIdType.rows.length > 0 && userIdType.rows[0].data_type === 'uuid') {
      console.log('⚠️  Converting user table id from UUID to VARCHAR...');
      
      // Drop constraints and change column type
      await pool.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS session_user_id_fkey`);
      await pool.query(`ALTER TABLE account DROP CONSTRAINT IF EXISTS account_user_id_fkey`);
      
      await pool.query(`ALTER TABLE "user" ALTER COLUMN id TYPE VARCHAR(255)`);
      await pool.query(`ALTER TABLE "session" ALTER COLUMN user_id TYPE VARCHAR(255)`);
      await pool.query(`ALTER TABLE account ALTER COLUMN user_id TYPE VARCHAR(255)`);
      
      // Recreate constraints
      await pool.query(`ALTER TABLE "session" ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE`);
      await pool.query(`ALTER TABLE account ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE`);
      
      console.log('✅ Converted user table id to VARCHAR');
    }
    
    // Fix user_shops table - create if not exists, or fix column types
    try {
      // Check if table exists
      const tableExists = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'user_shops'
        )
      `);
      
      if (!tableExists.rows[0].exists) {
        // Create user_shops table
        await pool.query(`
          CREATE TABLE IF NOT EXISTS user_shops (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id VARCHAR(255) NOT NULL,
            shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
            role VARCHAR(50) DEFAULT 'seller',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, shop_id)
          )
        `);
        console.log('✅ Created user_shops table');
      } else {
        // Fix user_id column type if needed
        const userShopsUserIdType = await pool.query(`
          SELECT data_type FROM information_schema.columns 
          WHERE table_name = 'user_shops' AND column_name = 'user_id'
        `);
        
        if (userShopsUserIdType.rows.length > 0 && userShopsUserIdType.rows[0].data_type === 'uuid') {
          console.log('⚠️  Converting user_shops.user_id from UUID to VARCHAR...');
          await pool.query(`ALTER TABLE user_shops ALTER COLUMN user_id TYPE VARCHAR(255)`);
          console.log('✅ Converted user_shops.user_id to VARCHAR');
        }
      }
    } catch (e: any) {
      console.log('⚠️  user_shops table error:', e.message);
    }
    
    // Fix account table - convert id and user_id to VARCHAR if needed
    try {
      const accountIdType = await pool.query(`
        SELECT data_type FROM information_schema.columns 
        WHERE table_name = 'account' AND column_name = 'id'
      `);
      
      if (accountIdType.rows.length > 0 && accountIdType.rows[0].data_type === 'uuid') {
        console.log('⚠️  Converting account table columns from UUID to VARCHAR...');
        
        // Drop constraints first
        await pool.query(`ALTER TABLE account DROP CONSTRAINT IF EXISTS account_user_id_fkey`);
        
        await pool.query(`ALTER TABLE account ALTER COLUMN id TYPE VARCHAR(255)`);
        await pool.query(`ALTER TABLE account ALTER COLUMN user_id TYPE VARCHAR(255)`);
        
        // Recreate constraint
        await pool.query(`ALTER TABLE account ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE`);
        
        console.log('✅ Converted account table to VARCHAR');
      }
    } catch (e: any) {
      console.log('⚠️  account table fix error:', e.message);
    }
  } catch (e: any) {
    console.log('⚠️  User table fix error:', e.message);
  }
  
  // Initialize super admin shop
  await initializeSuperAdminShop();

  // One-time email-verification grandfather: every account that existed before
  // email verification was enforced is marked verified so nobody is locked out.
  // Runs exactly once (guarded by a system_settings flag) and is transactional:
  // the flag and the update commit together, so a partial failure can never
  // re-run later and accidentally cover newly-registered accounts.
  // It ONLY flips email_verified -> true; passwords, roles, shops, tenants and
  // existing sessions are untouched.
  try {
    const flag = await pool.query(`SELECT 1 FROM system_settings WHERE key = 'email_verification_grandfather_v1' LIMIT 1`);
    if (flag.rows.length === 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const again = await client.query(`SELECT 1 FROM system_settings WHERE key = 'email_verification_grandfather_v1' LIMIT 1`);
        if (again.rows.length === 0) {
          const r = await client.query(`UPDATE "user" SET email_verified = true WHERE email_verified = false`);
          await client.query(
            `INSERT INTO system_settings (key, value) VALUES ('email_verification_grandfather_v1', $1) ON CONFLICT (key) DO NOTHING`,
            [JSON.stringify({ done: true, verified: r.rowCount || 0, at: new Date().toISOString() })]
          );
          console.log(`✅ Email verification: grandfathered ${r.rowCount || 0} existing account(s) as verified`);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
  } catch (e: any) {
    console.warn('⚠️  Email verification grandfather skipped:', e.message);
  }

  // Legacy id cleanup: "user".shop_id / tenant_id are VARCHAR columns, so an
  // old row can hold a non-UUID value. Such a value makes uuid-typed lookups
  // (shops.id = $1, shops.tenant_id = $1) fail with "invalid input syntax for
  // type uuid" — which broke /api/shops and /api/bootstrap. The auth middleware
  // self-heals per request; this clears the bad values once at startup.
  try {
    const UUID_RE_SQL = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    const shopFix = await pool.query(
      `UPDATE "user" SET shop_id = NULL, updated_at = NOW()
        WHERE shop_id IS NOT NULL AND shop_id <> '' AND shop_id !~* $1`,
      [UUID_RE_SQL]
    );
    const tenantFix = await pool.query(
      `UPDATE "user" SET tenant_id = NULL, updated_at = NOW()
        WHERE tenant_id IS NOT NULL AND tenant_id <> '' AND tenant_id !~* $1`,
      [UUID_RE_SQL]
    );
    if ((shopFix.rowCount || 0) > 0 || (tenantFix.rowCount || 0) > 0) {
      console.log(`✅ Legacy id cleanup: cleared ${shopFix.rowCount || 0} invalid shop_id and ${tenantFix.rowCount || 0} invalid tenant_id value(s)`);
    }
  } catch (e: any) {
    console.warn('⚠️  Legacy id cleanup skipped:', e.message);
  }

  // Plan limits & feature entitlements (adds plan columns + 14-day trial defaults)
  await ensurePlanLimitSetup();

  // Referral system tables (codes, referrals, earnings, withdrawals)
  await ensureReferralSchema();

  // Daily sales report log (one report per shop per day)
  await ensureDailyReportTable();

  // Blog tables (isolated — AI articles never touch the main system tables)
  await ensureBlogTables();

  // Personal notebook notes (header + formatted descriptions per user)
  await ensureNotesSchema();

  // Shareable coupon codes on offers (developer-created discounts)
  try {
    await pool.query(`ALTER TABLE subscription_offers ADD COLUMN IF NOT EXISTS code VARCHAR(50)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS subscription_offers_code_unique ON subscription_offers (UPPER(code)) WHERE code IS NOT NULL`);
    console.log('✅ Coupon code column ready');
  } catch (e: any) {
    console.log('⚠️  Coupon code column check:', e.message);
  }

  // SMS delivery tracking + queueing + AI surveillance columns. The migration
  // runner skips "ADD COLUMN IF NOT EXISTS" statements, so every column the SMS
  // service reads/writes is ensured here — otherwise shop sends fail to log and
  // the developer SMS Monitoring page shows nothing.
  try {
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS error TEXT`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS queued_at TIMESTAMP`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS ai_reviewed BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS ai_risk VARCHAR(20)`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS ai_flags JSONB`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS ai_reviewed_at TIMESTAMP`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS sender_row_id UUID`);
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS sender_provider_id TEXT`);
    // Exactly-once refund flag for queued SMS that permanently fail after all
    // retries (provider outage): the shop gets its credits back.
    await pool.query(`ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS refunded BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_provider_msg_idx ON sms_messages (provider_message_id) WHERE provider_message_id IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_queued_idx ON sms_messages (status, created_at) WHERE status = 'queued'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_ai_review_idx ON sms_messages (ai_reviewed, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_shop_created_idx ON sms_messages (shop_id, created_at DESC)`);
    console.log('✅ SMS delivery, queue & AI review columns ready');
  } catch (e: any) {
    console.log('⚠️  SMS delivery columns check:', e.message);
  }
  
  // Create stock take tables if they don't exist
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_take_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        started_by TEXT NOT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        status VARCHAR(50) NOT NULL DEFAULT 'in_progress',
        notes TEXT,
        approved_by TEXT,
        approved_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_take_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        session_id UUID NOT NULL REFERENCES stock_take_sessions(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        system_quantity INTEGER NOT NULL DEFAULT 0,
        physical_quantity INTEGER,
        difference INTEGER DEFAULT 0,
        notes TEXT,
        counted_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, product_id)
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_adjustments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        previous_quantity INTEGER NOT NULL,
        new_quantity INTEGER NOT NULL,
        difference INTEGER NOT NULL,
        adjustment_type VARCHAR(50) NOT NULL,
        reference_id UUID,
        approved_by TEXT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT NOT NULL
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_during_stock_take (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sale_id UUID NOT NULL,
        session_id UUID REFERENCES stock_take_sessions(id),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Stock take tables created');
    
    try {
      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'stock_adjustments' AND column_name = 'created_by' 
            AND data_type = 'uuid'
          ) THEN
            ALTER TABLE stock_adjustments ALTER COLUMN created_by TYPE TEXT;
          END IF;
        END $$;
      `);
      console.log('✅ Stock adjustments column fixed');
    } catch (e: any) {
      console.log('⚠️  Stock adjustments column fix error:', e.message);
    }
    
    try {
      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'stock_take_sessions' AND column_name = 'started_by' 
            AND data_type = 'uuid'
          ) THEN
            ALTER TABLE stock_take_sessions ALTER COLUMN started_by TYPE TEXT;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'stock_take_sessions' AND column_name = 'approved_by' 
            AND data_type = 'uuid'
          ) THEN
            ALTER TABLE stock_take_sessions ALTER COLUMN approved_by TYPE TEXT;
          END IF;
        END $$;
      `);
      console.log('✅ Stock take sessions columns fixed');
    } catch (e: any) {
      console.log('⚠️  Stock take sessions columns fix error:', e.message);
    }

    // Create backup settings table if not exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS backup_settings (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
          backup_type VARCHAR(20) NOT NULL DEFAULT 'full',
          backup_location TEXT,
          custom_path TEXT,
          frequency VARCHAR(20) NOT NULL DEFAULT 'weekly',
          retention_days INTEGER NOT NULL DEFAULT 30,
          is_enabled BOOLEAN DEFAULT TRUE,
          last_backup_at TIMESTAMP,
          next_backup_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS backup_history (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
          filename VARCHAR(255) NOT NULL,
          filepath TEXT NOT NULL,
          filesize INTEGER,
          backup_type VARCHAR(20) NOT NULL DEFAULT 'full',
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          cloud_uploaded BOOLEAN NOT NULL DEFAULT false,
          error_message TEXT,
          started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Create indexes
      await pool.query(`
        CREATE INDEX IF NOT EXISTS backup_history_tenant_id_idx ON backup_history(tenant_id);
        CREATE INDEX IF NOT EXISTS backup_history_shop_id_idx ON backup_history(shop_id);
        CREATE INDEX IF NOT EXISTS backup_history_status_idx ON backup_history(status);
      `);
      
      console.log('✅ Backup tables created');
      await pool.query(`ALTER TABLE backup_history ADD COLUMN IF NOT EXISTS cloud_uploaded BOOLEAN NOT NULL DEFAULT false`);
      console.log('✅ Backup history cloud_uploaded column added');
    } catch (e: any) {
      console.log('⚠️  Backup tables error:', e.message);
    }
    } catch (e: any) {
      console.log('⚠️  Stock take tables error:', e.message);
    }

    // Cargo entries table for tracking product shipments
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cargo_entries (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          quantity DECIMAL(12,4) NOT NULL DEFAULT 0,
          buying_price_per_unit DECIMAL(12,2) DEFAULT 0,
          transport_cost DECIMAL(12,2) DEFAULT 0,
          supplier_name VARCHAR(255),
          notes TEXT,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`ALTER TABLE cargo_entries ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE`);
      await pool.query(`CREATE INDEX IF NOT EXISTS cargo_entries_product_id_idx ON cargo_entries(product_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS cargo_entries_shop_id_idx ON cargo_entries(shop_id)`);
      console.log('✅ Cargo entries table created');
    } catch (e: any) {
      console.log('⚠️  Cargo entries table error:', e.message);
    }

    // Expenses table for tracking shop expenses
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          category VARCHAR(100) NOT NULL,
          amount DECIMAL(12,2) NOT NULL DEFAULT 0,
          description TEXT,
          paid_to VARCHAR(255),
          details JSONB DEFAULT '{}',
          period_start DATE,
          period_end DATE,
          date DATE NOT NULL DEFAULT CURRENT_DATE,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS expenses_shop_id_idx ON expenses(shop_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses(date)`);
      await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255)`);
      console.log('✅ Expenses table created');
    } catch (e: any) {
      console.log('⚠️  Expenses table error:', e.message);
    }

    // Migrate expenses columns for existing installations
    try {
      await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tenant_id UUID`);
      await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_to VARCHAR(255)`);
      await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'`);
      await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS period_start DATE`);
      await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS period_end DATE`);
      console.log('✅ Expenses table updated with extra columns');
    } catch (e: any) {
      console.log('⚠️  Expense migration error:', e.message);
    }

    // Fix tenant_id column type from UUID to VARCHAR (user.tenant_id is VARCHAR)
    try {
      await pool.query(`ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_tenant_id_fkey`);
      await pool.query(`ALTER TABLE expenses ALTER COLUMN tenant_id TYPE VARCHAR(255) USING tenant_id::text`);
      console.log('✅ Expenses tenant_id column fixed to VARCHAR');
    } catch (e: any) {
      console.log('⚠️  Expense tenant_id migration error:', e.message);
    }

    // Ensure created_by is TEXT for proper JOIN with "user".id (VARCHAR)
    try {
      await pool.query(`ALTER TABLE expenses ALTER COLUMN created_by TYPE TEXT USING created_by::text`);
      console.log('✅ Expenses created_by column fixed to TEXT');
    } catch (e: any) {
      console.log('⚠️  Expense created_by migration error:', e.message);
    }

    // Expense workers table for salary breakdown
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS expense_workers (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          amount DECIMAL(12,2) NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS expense_workers_expense_id_idx ON expense_workers(expense_id)`);
      console.log('✅ Expense workers table created');
    } catch (e: any) {
      console.log('⚠️  Expense workers table error:', e.message);
    }

    // Expense Categories table for managing expense categories
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS expense_categories (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          is_default BOOLEAN DEFAULT FALSE,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_shop_name_idx ON expense_categories(shop_id, name) WHERE shop_id IS NOT NULL`);
      console.log('✅ Expense categories table created');

      // Seed default expense categories if none exist
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Rent', 'Shop or office rent payments', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Utilities', 'Electricity, water, internet bills', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Utilities' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Salaries', 'Employee wages and salaries', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Salaries' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Supplies', 'Office and cleaning supplies', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Supplies' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Transport', 'Transportation and delivery costs', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Transport' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Maintenance', 'Equipment and premises maintenance', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Maintenance' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Marketing', 'Advertising and promotions', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Marketing' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Insurance', 'Business insurance premiums', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Insurance' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Taxes', 'Business taxes and licenses', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Taxes' AND is_default = TRUE)
      `);
      await pool.query(`
        INSERT INTO expense_categories (name, description, is_default)
        SELECT 'Other', 'Miscellaneous expenses', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Other' AND is_default = TRUE)
      `);
      console.log('✅ Default expense categories seeded');
    } catch (e: any) {
      console.log('⚠️  Expense categories table error:', e.message);
    }

    // Services (Huduma) tables - service categories, services and service records
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS service_categories (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS service_categories_shop_name_idx
        ON service_categories(shop_id, LOWER(name))
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS services (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          category_id UUID REFERENCES service_categories(id) ON DELETE SET NULL,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(12,2) NOT NULL DEFAULT 0,
          description TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS services_shop_idx ON services(shop_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS services_category_idx ON services(category_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS service_records (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          service_id UUID REFERENCES services(id) ON DELETE SET NULL,
          service_name VARCHAR(255) NOT NULL,
          category_id UUID,
          category_name VARCHAR(100),
          quantity DECIMAL(12,2) NOT NULL DEFAULT 1,
          unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
          total DECIMAL(12,2) NOT NULL DEFAULT 0,
          customer_name VARCHAR(255),
          customer_phone VARCHAR(20),
          notes TEXT,
          recorded_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS service_records_shop_created_idx ON service_records(shop_id, created_at DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS service_records_service_idx ON service_records(service_id)`);
      console.log('✅ Services tables created');
    } catch (e: any) {
      console.log('⚠️  Services tables error:', e.message);
    }

    // Pre-orders table for tracking customer pre-orders
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS pre_orders (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          customer_name VARCHAR(255),
          customer_phone VARCHAR(50),
          customer_email VARCHAR(255),
          product_name VARCHAR(255) NOT NULL,
          quantity DECIMAL(12,4) NOT NULL DEFAULT 1,
          total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
          paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          expected_date TIMESTAMP,
          notes TEXT,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS pre_orders_shop_id_idx ON pre_orders(shop_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS pre_orders_status_idx ON pre_orders(status)`);
      console.log('✅ Pre-orders table created');
    } catch (e: any) {
      console.log('⚠️  Pre-orders table error:', e.message);
    }

    // Add product_id column to pre_orders if not exists
    try {
      await pool.query(`
        ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL
      `);
      console.log('✅ product_id column added to pre_orders');
    } catch (e: any) {
      console.log('⚠️  product_id column error:', e.message);
    }

    // Add quantity column to pre_orders if not exists
    try {
      await pool.query(`
        ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS quantity DECIMAL(12,4) NOT NULL DEFAULT 1
      `);
      console.log('✅ quantity column added to pre_orders');
    } catch (e: any) {
      console.log('⚠️  quantity column error:', e.message);
    }

    // Add items_data column to pre_orders if not exists
    try {
      await pool.query(`
        ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS items_data JSONB DEFAULT '[]'::jsonb
      `);
      console.log('✅ items_data column added to pre_orders');
    } catch (e: any) {
      console.log('⚠️  items_data column error:', e.message);
    }

    // Add sale_id column to pre_orders for linking to a single sale record
    try {
      const colExists = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'pre_orders' AND column_name = 'sale_id'
      `);
      if (colExists.rows.length === 0) {
        await pool.query(`ALTER TABLE pre_orders ADD COLUMN sale_id UUID REFERENCES sales(id) ON DELETE SET NULL`);
        console.log('✅ sale_id column added to pre_orders');
      } else {
        console.log('✅ sale_id column already exists on pre_orders');
      }
    } catch (e: any) {
      console.log('⚠️  sale_id column error:', e.message);
    }

    // Pre-order payments table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS pre_order_payments (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          pre_order_id UUID NOT NULL REFERENCES pre_orders(id) ON DELETE CASCADE,
          amount DECIMAL(12,2) NOT NULL,
          payment_method VARCHAR(50) DEFAULT 'cash',
          notes TEXT,
          received_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS pre_order_payments_pre_order_id_idx ON pre_order_payments(pre_order_id)`);
      console.log('✅ Pre-order payments table created');
    } catch (e: any) {
      console.log('⚠️  Pre-order payments table error:', e.message);
    }

    // Feature flags table for super-admin feature management
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS feature_flags (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          feature_key VARCHAR(100) NOT NULL UNIQUE,
          enabled BOOLEAN NOT NULL DEFAULT false,
          rollout_percent INTEGER NOT NULL DEFAULT 0,
          description TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Feature flags table created');
    } catch (e: any) {
      console.log('⚠️  Feature flags table error:', e.message);
    }

    // Notifications table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          user_id TEXT,
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          type VARCHAR(50) NOT NULL DEFAULT 'info',
          is_read BOOLEAN NOT NULL DEFAULT false,
          action_url VARCHAR(500),
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS notifications_tenant_id_idx ON notifications(tenant_id);
        CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS notifications_is_read_idx ON notifications(is_read);
        CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications(created_at DESC);
      `);
      console.log('✅ Notifications table created');
    } catch (e: any) {
      console.log('⚠️  Notifications table error:', e.message);
    }

    // Support chat tables (also aliased as support_tickets for super-admin routes)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS support_chats (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          admin_id TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'open',
          subject VARCHAR(255),
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Create support_tickets as a view aliasing support_chats for super-admin
      // routes. Done at the END of this block: migration 0020 may have created
      // support_tickets as a real table, and CREATE OR REPLACE VIEW cannot
      // replace a table. The conversion below moves any rows first.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          chat_id UUID REFERENCES support_chats(id) ON DELETE CASCADE,
          sender_id TEXT NOT NULL,
          sender_role VARCHAR(20) NOT NULL DEFAULT 'user',
          message TEXT NOT NULL,
          is_admin_message BOOLEAN NOT NULL DEFAULT false,
          is_read BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Create support_ticket_replies as a view aliasing chat_messages with admin replies
      await pool.query(`
        CREATE OR REPLACE VIEW support_ticket_replies AS
        SELECT id AS reply_id, chat_id, sender_id AS replied_by, message AS reply, created_at
        FROM chat_messages WHERE is_admin_message = true
      `);
      // Add is_read column if it doesn't exist (for existing tables)
      await pool.query(`
        ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false
      `);
      // AI escalation: set when the assistant cannot answer, so the chat shows
      // up as "needs human" in the developer dashboard until a human replies.
      await pool.query(`
        ALTER TABLE support_chats ADD COLUMN IF NOT EXISTS ai_escalated BOOLEAN DEFAULT FALSE
      `);
      await pool.query(`
        ALTER TABLE support_chats ADD COLUMN IF NOT EXISTS ai_escalated_at TIMESTAMP
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS support_chats_tenant_id_idx ON support_chats(tenant_id);
        CREATE INDEX IF NOT EXISTS support_chats_user_id_idx ON support_chats(user_id);
        CREATE INDEX IF NOT EXISTS support_chats_status_idx ON support_chats(status);
        CREATE INDEX IF NOT EXISTS chat_messages_chat_id_idx ON chat_messages(chat_id);
        CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx ON chat_messages(created_at);
      `);

      // support_tickets must be the view over support_chats. Older databases
      // (built from migration 0020) have it as a real table — move its rows into
      // support_chats, drop the table, then create the view. Each step is
      // best-effort so a legacy row shape can never abort the whole block.
      try {
        await pool.query(`
          DO $$ BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'support_tickets' AND table_type = 'BASE TABLE'
            ) THEN
              INSERT INTO support_chats (id, tenant_id, user_id, admin_id, status, subject, created_at, updated_at)
                SELECT id, tenant_id, user_id, admin_id, COALESCE(status, 'open'), subject,
                       COALESCE(created_at, NOW()), COALESCE(updated_at, NOW())
                FROM support_tickets
                WHERE id IS NOT NULL AND user_id IS NOT NULL
                ON CONFLICT (id) DO NOTHING;
              DROP TABLE support_tickets;
            END IF;
          EXCEPTION WHEN others THEN NULL;
          END $$;
        `);
        await pool.query(`
          CREATE OR REPLACE VIEW support_tickets AS
          SELECT id, tenant_id, user_id, admin_id, status, subject, created_at, updated_at
          FROM support_chats
        `);
      } catch (e: any) {
        console.log('⚠️  support_tickets view conversion skipped:', e.message);
      }

      console.log('✅ Support chat tables created');
    } catch (e: any) {
      console.log('⚠️  Support chat tables error:', e.message);
    }

    // Fraction selling migration
    try {
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS enable_fractions BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS fraction_types JSONB DEFAULT '[]'`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS fraction_prices JSONB DEFAULT '{}'`);
      await pool.query(`ALTER TABLE products ALTER COLUMN current_stock TYPE DECIMAL(12,4) USING current_stock::DECIMAL(12,4)`);
      await pool.query(`ALTER TABLE products ALTER COLUMN current_stock SET DEFAULT 0`);
      await pool.query(`ALTER TABLE products ALTER COLUMN low_stock_threshold TYPE DECIMAL(12,4) USING low_stock_threshold::DECIMAL(12,4)`);
      await pool.query(`ALTER TABLE products ALTER COLUMN low_stock_threshold SET DEFAULT 10`);
      await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS fraction_type VARCHAR(20) DEFAULT 'whole'`);
      await pool.query(`ALTER TABLE sale_items ALTER COLUMN quantity TYPE DECIMAL(12,4) USING quantity::DECIMAL(12,4)`);
      await pool.query(`ALTER TABLE cargo_entries ALTER COLUMN quantity TYPE DECIMAL(12,4) USING quantity::DECIMAL(12,4)`);
      await pool.query(`ALTER TABLE stock_take_items ALTER COLUMN system_quantity TYPE DECIMAL(12,4) USING system_quantity::DECIMAL(12,4)`);
      await pool.query(`ALTER TABLE stock_take_items ALTER COLUMN physical_quantity TYPE DECIMAL(12,4) USING physical_quantity::DECIMAL(12,4)`);
      console.log('✅ Fraction selling columns added');
    } catch (e: any) {
      console.log('⚠️  Fraction migration error:', e.message);
    }

    // Invoice payment tracking columns
    try {
      await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending'`);
      await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_company VARCHAR(255)`);
      await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_address TEXT`);
      await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_tin VARCHAR(50)`);
      await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_vrn VARCHAR(50)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS invoice_payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        amount DECIMAL(12,2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'cash',
        payment_reference VARCHAR(255),
        notes TEXT,
        recorded_by VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      console.log('✅ Invoice payment tracking columns added');
    } catch (e: any) {
      console.log('⚠️  Invoice payment migration error:', e.message);
    }

    // Bank payment method column
    try {
      await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100)`);
      console.log('✅ Bank payment column added');
    } catch (e: any) {
      console.log('⚠️  Bank payment migration error:', e.message);
    }

    // Debtors and debt_payments tables
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS debtors (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(50),
        customer_email VARCHAR(255),
        total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) DEFAULT 'unpaid',
        due_date TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS debt_payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        debtor_id UUID NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
        amount DECIMAL(12,2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'cash',
        notes TEXT,
        received_by VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      // Ensure columns exist for older databases
      await pool.query(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`);
      await pool.query(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50)`);
      await pool.query(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255)`);
      await pool.query(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL`);
      await pool.query(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS due_date TIMESTAMP`);
      await pool.query(`ALTER TABLE debtors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
      // Fix NOT NULL constraint on customer_phone column from older schema
      try {
        await pool.query(`ALTER TABLE debtors ALTER COLUMN customer_phone DROP NOT NULL`);
      } catch {}
      await pool.query(`CREATE TABLE IF NOT EXISTS debt_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        debtor_id UUID NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
        product_id UUID REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        quantity DECIMAL(12,3) NOT NULL DEFAULT 1,
        unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        discount DECIMAL(12,2) DEFAULT 0,
        total_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        buying_price DECIMAL(12,2) DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      // Add discount column if not exists (for per-product discounts)
      await pool.query(`ALTER TABLE debt_items ADD COLUMN IF NOT EXISTS discount DECIMAL(12,2) DEFAULT 0`);
      // Add buying_price column if not exists (for accurate profit calculation)
      await pool.query(`ALTER TABLE debt_items ADD COLUMN IF NOT EXISTS buying_price DECIMAL(12,2) DEFAULT 0`);
      console.log('✅ Debtors, debt_payments, and debt_items tables created');
    } catch (e: any) {
      console.log('⚠️  Debtors migration error:', e.message);
    }

    // Free trial columns on tenants
    try {
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_start TIMESTAMP`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_end TIMESTAMP`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_activated BOOLEAN DEFAULT FALSE`);
      console.log('✅ Free trial columns added');
    } catch (e: any) {
      console.log('⚠️  Trial migration error:', e.message);
    }

    // Phone column on tenants (for simu outreach)
    try {
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`);
      console.log('✅ Phone column added to tenants');
    } catch (e: any) {
      console.log('⚠️  Phone column migration error:', e.message);
    }

    // Marketing opt-in column on tenants (required for simu MARKETING templates)
    try {
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN DEFAULT FALSE`);
      console.log('✅ Marketing opt-in column added to tenants');
    } catch (e: any) {
      console.log('⚠️  Marketing opt-in column migration error:', e.message);
    }

    // Auto-activate trials for ALL existing tenants (one-time migration).
    // Offline desktop has no subscription/trial system at all.
    if (!OFFLINE_MODE) {
      try {
        const defaultDays = parseInt(process.env.DEFAULT_TRIAL_DAYS || '14');
      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setDate(trialEnd.getDate() + defaultDays);

      // Activate for tenants that don't have active paid subscriptions
      await pool.query(`
        UPDATE tenants SET
          trial_start = $1,
          trial_end = $2,
          trial_activated = true,
          updated_at = NOW()
        WHERE (trial_activated IS NULL OR trial_activated = false)
          AND NOT EXISTS (
            SELECT 1 FROM tenant_subscriptions ts
            WHERE ts.tenant_id = tenants.id
              AND ts.status = 'active'
              AND ts.current_period_end > $1
          )
      `, [now, trialEnd]);

        console.log(`✅ Auto-activated ${defaultDays}-day trials for all existing tenants`);
      } catch (e: any) {
        console.log('⚠️  Trial auto-activation error:', e.message);
      }
    }

    // Global trial settings
    try {
      const existing = await pool.query(`SELECT value FROM system_settings WHERE key = 'trial_settings'`);
      if (existing.rows.length === 0) {
        await pool.query(`
          INSERT INTO system_settings (key, value) VALUES ('trial_settings', $1)
        `, [JSON.stringify({
          enabled: true,
          defaultDays: 14,
          autoActivate: true,
        })]);
        console.log('✅ Global trial settings initialized (14 days default)');
      }
    } catch (e: any) {
      console.log('⚠️  Trial settings init error:', e.message);
    }

    // Create subscription tables if they don't exist
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS subscription_plans (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          name VARCHAR(100) NOT NULL,
          price_tzs INTEGER NOT NULL,
          full_price_tzs INTEGER NOT NULL,
          discount_percent INTEGER NOT NULL DEFAULT 0,
          duration_days INTEGER NOT NULL DEFAULT 30,
          max_shops INTEGER DEFAULT NULL,
          max_sellers INTEGER DEFAULT NULL,
          description TEXT,
          badge VARCHAR(50),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tenant_subscriptions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          plan_id UUID NOT NULL REFERENCES subscription_plans(id),
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          current_period_start TIMESTAMP,
          current_period_end TIMESTAMP,
          snippe_reference VARCHAR(255),
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS subscription_payments (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          subscription_id UUID NOT NULL REFERENCES tenant_subscriptions(id),
          snippe_reference VARCHAR(255) NOT NULL UNIQUE,
          snippe_event_id VARCHAR(255) UNIQUE,
          amount_tzs INTEGER NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          payment_channel VARCHAR(50),
          payment_type VARCHAR(20),
          customer_phone VARCHAR(20),
          metadata TEXT,
          paid_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Subscription tables created');
    } catch (e: any) {
      console.log('⚠️  Subscription tables creation error:', e.message);
    }

    // Add max_shops and max_sellers columns to subscription_plans (null = unlimited)
    try {
      await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_shops INTEGER DEFAULT NULL`);
      await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_sellers INTEGER DEFAULT NULL`);
      console.log('✅ Plan limit columns added (max_shops, max_sellers)');
    } catch (e: any) {
      console.log('⚠️  Plan limits migration error:', e.message);
    }

    // Seed default subscription plans if table is empty
    try {
      const planCount = await pool.query(`SELECT COUNT(*) FROM subscription_plans`);
      if (parseInt(planCount.rows[0].count) === 0) {
        await pool.query(`
          INSERT INTO subscription_plans (name, price_tzs, full_price_tzs, discount_percent, duration_days, max_shops, max_sellers, description, badge, is_active)
          VALUES
            ('Starter', 1500, 1500, 5, 30, 1, 2, 'Basic access for 30 days', 'Popular', true),
            ('3-Month Plan', 40500, 45000, 10, 90, 2, 5, 'Save 10% — pay once, use 3 months', 'Great Deal', true),
            ('6-Month Plan', 72000, 90000, 20, 180, 3, 10, 'Save 20% — best for growing teams', 'Best Value', true),
            ('Annual Plan', 120000, 180000, 33, 365, null, null, 'Save 33% — full year access', 'Best Value', true)
        `);
        console.log('✅ Default subscription plans seeded');
      }
    } catch (e: any) {
      console.log('⚠️  Plan seeding error:', e.message);
    }

    // Create admin_audit_log table if not exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_audit_log (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          admin_id TEXT NOT NULL,
          action VARCHAR(100) NOT NULL,
          target_tenant_id UUID,
          target_subscription_id UUID,
          notes TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ admin_audit_log table created');
    } catch (e: any) {
      console.log('⚠️  Audit log table migration error:', e.message);
    }

    // Email campaigns table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS email_campaigns (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          admin_id TEXT NOT NULL,
          subject VARCHAR(500) NOT NULL,
          html_content TEXT NOT NULL,
          template_key VARCHAR(100),
          recipient_type VARCHAR(50) NOT NULL DEFAULT 'all',
          recipient_count INTEGER DEFAULT 0,
          sent_count INTEGER DEFAULT 0,
          failed_count INTEGER DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          scheduled_at TIMESTAMP,
          sent_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS email_campaign_recipients (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          campaign_id UUID NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
          tenant_id UUID,
          email VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          error_message TEXT,
          sent_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS email_campaigns_status_idx ON email_campaigns(status)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS email_campaigns_created_at_idx ON email_campaigns(created_at DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS email_campaign_recipients_campaign_idx ON email_campaign_recipients(campaign_id)`);
      // Add source column if it doesn't exist yet
      try {
        await pool.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual'`);
        console.log('✅ Added source column to email_campaigns');
      } catch (e2: any) {
        console.log('⚠️  Source column add error:', e2.message);
      }
      console.log('✅ Email campaigns tables created');
    } catch (e: any) {
      console.log('⚠️  Email campaigns table error:', e.message);
    }

    // Email event tracking table (for per-send open/delivery/click tracking)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS email_events (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          event_type VARCHAR(20) NOT NULL,
          template_key VARCHAR(100),
          email VARCHAR(255) NOT NULL,
          tenant_id UUID,
          campaign_id UUID,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS email_events_type_idx ON email_events(event_type)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS email_events_template_idx ON email_events(template_key)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS email_events_created_idx ON email_events(created_at DESC)`);
      try {
        await pool.query(`ALTER TABLE email_events ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'resend'`);
        await pool.query(`CREATE INDEX IF NOT EXISTS email_events_provider_idx ON email_events(provider)`);
      } catch (e2: any) {
        console.log('⚠️  Email events provider column add error:', e2.message);
      }
      // Delivery-status tracking (updated by the Unosend delivery webhook)
      try {
        await pool.query(`ALTER TABLE email_events ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent'`);
        await pool.query(`ALTER TABLE email_events ADD COLUMN IF NOT EXISTS bounce_reason TEXT`);
        await pool.query(`ALTER TABLE email_events ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);
        await pool.query(`ALTER TABLE email_events ADD COLUMN IF NOT EXISTS last_status_at TIMESTAMP`);
        await pool.query(`CREATE INDEX IF NOT EXISTS email_events_status_idx ON email_events(status)`);
      } catch (e2: any) {
        console.log('⚠️  Email events status columns add error:', e2.message);
      }
      console.log('✅ Email events tracking table created');
    } catch (e: any) {
      console.log('⚠️  Email events table error:', e.message);
    }

    // User feedback table for collecting suggestions
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_feedback (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          days_used INTEGER NOT NULL DEFAULT 0,
          liked TEXT,
          disliked TEXT,
          suggestions TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'new',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          reviewed_at TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS user_feedback_tenant_idx ON user_feedback(tenant_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS user_feedback_status_idx ON user_feedback(status)`);
      console.log('✅ User feedback table created');
    } catch (e: any) {
      console.log('⚠️  User feedback table error:', e.message);
    }

    // SMS log table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_log (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
          phone VARCHAR(20) NOT NULL,
          message TEXT NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'queued',
          batch_id VARCHAR(100),
          message_id VARCHAR(100),
          error_message TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS sms_log_tenant_idx ON sms_log(tenant_id);
        CREATE INDEX IF NOT EXISTS sms_log_status_idx ON sms_log(status);
        CREATE INDEX IF NOT EXISTS sms_log_created_idx ON sms_log(created_at DESC);
      `);
      console.log('✅ SMS log table created');
    } catch (e: any) {
      console.log('⚠️  SMS log table error:', e.message);
    }

    // SMS campaigns table for scheduled marketing SMS
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_campaigns (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          recipient_type VARCHAR(50) NOT NULL DEFAULT 'all',
          recipient_count INTEGER DEFAULT 0,
          sent_count INTEGER DEFAULT 0,
          failed_count INTEGER DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          scheduled_at TIMESTAMP,
          sent_at TIMESTAMP,
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS sms_campaigns_status_idx ON sms_campaigns(status);
        CREATE INDEX IF NOT EXISTS sms_campaigns_scheduled_idx ON sms_campaigns(scheduled_at);
      `);
      console.log('✅ SMS campaigns table created');
    } catch (e: any) {
      console.log('⚠️  SMS campaigns table error:', e.message);
    }

    // SMS user campaigns table (per-shop campaigns created by shop admins)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_user_campaigns (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          shop_id UUID NOT NULL,
          name VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          sender_id UUID,
          recipients JSONB NOT NULL DEFAULT '[]',
          total_recipients INTEGER DEFAULT 0,
          parts INTEGER DEFAULT 0,
          total_credits INTEGER DEFAULT 0,
          type VARCHAR(20) NOT NULL DEFAULT 'one_time',
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          scheduled_at TIMESTAMP,
          sent_at TIMESTAMP,
          recurrence VARCHAR(20),
          created_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS sms_user_campaigns_shop_idx ON sms_user_campaigns(shop_id);
        CREATE INDEX IF NOT EXISTS sms_user_campaigns_status_idx ON sms_user_campaigns(status);
        CREATE INDEX IF NOT EXISTS sms_user_campaigns_scheduled_idx ON sms_user_campaigns(scheduled_at);
      `);
      console.log('✅ SMS user campaigns table created');
    } catch (e: any) {
      console.log('⚠️  SMS user campaigns table error:', e.message);
    }

    // SMS reseller core tables — self-healing on every boot so the shop SMS
    // Center works even if the migration files were never applied (fresh DB).
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_accounts (
          shop_id uuid PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          balance integer NOT NULL DEFAULT 0,
          total_bought integer NOT NULL DEFAULT 0,
          total_sent integer NOT NULL DEFAULT 0,
          low_balance_notified boolean NOT NULL DEFAULT false,
          created_at timestamp DEFAULT now() NOT NULL,
          updated_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`ALTER TABLE sms_accounts ADD COLUMN IF NOT EXISTS balance_exhausted_notified boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE sms_accounts ADD COLUMN IF NOT EXISTS free_bonus_granted boolean NOT NULL DEFAULT false`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_sender_ids (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          shop_id uuid REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          sender_id varchar(11) NOT NULL,
          purpose text,
          status varchar(20) NOT NULL DEFAULT 'pending',
          provider_id text,
          submitted_by uuid,
          submitted_at timestamp,
          rejected_reason text,
          created_at timestamp DEFAULT now() NOT NULL,
          updated_at timestamp DEFAULT now() NOT NULL,
          CONSTRAINT sms_sender_ids_shop_sender_unique UNIQUE (shop_id, sender_id)
        )
      `);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS applied_by varchar(255) REFERENCES "user"(id) ON DELETE SET NULL`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS applied_email varchar(255)`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS applied_phone varchar(20)`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS rejection_notify_sent boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS rejection_notified_at timestamp`);
      // Raw message/reason returned by the provider (eHub) for ANY status, so
      // the developer can see WHY a sender is pending/rejected and the applicant
      // can be notified with the provider's exact wording.
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS provider_reason text`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS provider_status varchar(20)`);
      // The exact reason text last sent to the applicant — when the provider
      // updates its reason, the applicant is re-notified with the new wording.
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS rejection_notified_reason text`);
      // Developer review fields shown to the applicant when a sender ID is
      // rejected: review_reason is the reason the developer writes (may explain
      // or translate the provider wording) and rejection_guidance is "what to
      // do" to get approved on the next application. Kept separate from
      // rejected_reason/provider_reason so the provider status sync never
      // overwrites the developer's text.
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS review_reason text`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS rejection_guidance text`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS rejected_at timestamp`);
      // Re-application trail: a rejected applicant may apply again at any time.
      // Re-applying with the SAME name reuses this row (the shop_id+sender_id
      // unique constraint forbids a second insert); a different name creates a
      // new application. reapply_count/last_reapply_at keep the history visible
      // to the developer.
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS reapply_count integer NOT NULL DEFAULT 0`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS last_reapply_at timestamp`);
      // Approval-notification tracking: the developer can (re)send the
      // "sender ID approved — buy SMS in the SMS Center" message from the
      // Sender IDs registry; these fields record the last successful notice so
      // the UI shows "Notified <date>" and the reminder count.
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS approval_notify_sent boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS approval_notified_at timestamp`);
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS approval_notify_count integer NOT NULL DEFAULT 0`);
      // The applicant's own sample message (eHub requires 50-250 chars on
      // request) and the purpose actually submitted — both shown to the
      // developer so they can review/fix before resubmitting.
      await pool.query(`ALTER TABLE sms_sender_ids ADD COLUMN IF NOT EXISTS sample text`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sms_sender_ids_one_default_idx ON sms_sender_ids USING btree (shop_id) WHERE is_default`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_messages (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          shop_id uuid REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          recipient varchar(20) NOT NULL,
          message text NOT NULL,
          parts integer NOT NULL DEFAULT 1,
          credits integer NOT NULL DEFAULT 1,
          cost integer NOT NULL DEFAULT 0,
          status varchar(20) NOT NULL DEFAULT 'pending',
          provider_message_id text,
          sender_id varchar(11),
          campaign_id uuid,
          source varchar(20) NOT NULL DEFAULT 'manual',
          created_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_shop_id_idx ON sms_messages USING btree (shop_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_created_at_idx ON sms_messages USING btree (created_at DESC)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_broadcasts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          message text NOT NULL,
          message_hash varchar(64) NOT NULL,
          recipient_count integer NOT NULL DEFAULT 0,
          sent_count integer NOT NULL DEFAULT 0,
          status varchar(20) NOT NULL DEFAULT 'running',
          error text,
          -- NOTE: plain TEXT, no FK — "user".id is VARCHAR so a uuid FK here
          -- makes the whole CREATE fail and the table never gets created.
          created_by text,
          created_at timestamp DEFAULT now() NOT NULL,
          completed_at timestamp
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_broadcasts_message_hash_idx ON sms_broadcasts USING btree (message_hash)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_broadcasts_created_at_idx ON sms_broadcasts USING btree (created_at DESC)`);
      // Broadcast targeting: 'all' (every owner/admin) or 'approved_senders'
      // (shops with an approved own Sender ID).
      await pool.query(`ALTER TABLE sms_broadcasts ADD COLUMN IF NOT EXISTS audience varchar(30) NOT NULL DEFAULT 'all'`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_templates (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          shop_id uuid REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          name varchar(255) NOT NULL,
          message text NOT NULL,
          category varchar(50),
          created_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_groups (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          shop_id uuid REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          name varchar(255) NOT NULL,
          created_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_contacts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          shop_id uuid REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          name varchar(255),
          phone varchar(20) NOT NULL,
          email varchar(255),
          group_id uuid,
          created_at timestamp DEFAULT now() NOT NULL,
          CONSTRAINT sms_contacts_shop_phone_unique UNIQUE (shop_id, phone)
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_contacts_shop_id_idx ON sms_contacts USING btree (shop_id)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_transactions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          shop_id uuid REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          type varchar(20) NOT NULL DEFAULT 'credit',
          credits integer NOT NULL,
          amount_tzs integer NOT NULL DEFAULT 0,
          price_per_sms integer NOT NULL DEFAULT 25,
          status varchar(20) NOT NULL DEFAULT 'completed',
          reference text,
          snippe_reference text,
          created_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_transactions_shop_id_idx ON sms_transactions USING btree (shop_id)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_purchases (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          shop_id uuid REFERENCES shops(id) ON DELETE CASCADE NOT NULL,
          credits integer NOT NULL,
          amount_tzs integer NOT NULL,
          price_per_sms integer NOT NULL,
          phone_number varchar(20),
          snippe_reference text,
          status varchar(20) NOT NULL DEFAULT 'pending',
          paid_at timestamp,
          created_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`ALTER TABLE sms_purchases ADD COLUMN IF NOT EXISTS provider_cost integer NOT NULL DEFAULT 0`);
      await pool.query(`ALTER TABLE sms_purchases ADD COLUMN IF NOT EXISTS profit integer NOT NULL DEFAULT 0`);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_purchases_shop_id_idx ON sms_purchases USING btree (shop_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_purchases_snippe_reference_idx ON sms_purchases USING btree (snippe_reference)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_provider_ledger (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          type varchar(20) NOT NULL DEFAULT 'spend',
          sms_quantity integer NOT NULL DEFAULT 0,
          amount_tzs integer NOT NULL DEFAULT 0,
          cost_per_sms integer NOT NULL DEFAULT 0,
          reference text,
          note text,
          created_at timestamp DEFAULT now() NOT NULL
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_provider_ledger_created_at_idx ON sms_provider_ledger USING btree (created_at DESC)`);
      console.log('✅ SMS reseller tables ensured');
    } catch (e: any) {
      console.log('⚠️  SMS reseller tables error:', e.message);
    }

    // Broadcast history table — isolated in its own try/catch so it can never
    // break the tables above, and self-repairs a legacy created_by uuid column.
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_broadcasts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          message text NOT NULL,
          message_hash varchar(64) NOT NULL,
          recipient_count integer NOT NULL DEFAULT 0,
          sent_count integer NOT NULL DEFAULT 0,
          status varchar(20) NOT NULL DEFAULT 'running',
          error text,
          created_by text,
          created_at timestamp DEFAULT now() NOT NULL,
          completed_at timestamp
        )
      `);
      await pool.query(`ALTER TABLE sms_broadcasts ADD COLUMN IF NOT EXISTS message_hash varchar(64)`);
      // Legacy installs created created_by as uuid (FK to a varchar PK fails) —
      // convert to text so developer ids store correctly.
      try {
        await pool.query(`ALTER TABLE sms_broadcasts ALTER COLUMN created_by TYPE text USING created_by::text`);
      } catch { /* already text or table just created */ }
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_broadcasts_message_hash_idx ON sms_broadcasts USING btree (message_hash)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS sms_broadcasts_created_at_idx ON sms_broadcasts USING btree (created_at DESC)`);
      await pool.query(`ALTER TABLE sms_broadcasts ADD COLUMN IF NOT EXISTS audience varchar(30) NOT NULL DEFAULT 'all'`);
      console.log('✅ SMS broadcasts table ensured');
    } catch (e: any) {
      console.log('⚠️  SMS broadcasts table error:', e.message);
    }

  // Add unit/dimension columns to products table
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_type VARCHAR(20) DEFAULT 'PCS'`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS requires_dimensions BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_conversions JSONB DEFAULT '{}'`);
    console.log('✅ Products table updated with unit/dimension columns');
  } catch (e: any) {
    console.log('⚠️  Product unit columns error:', e.message);
  }

  // Add dimension/unit columns to sale_items table
  try {
    await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_type VARCHAR(20) DEFAULT 'PCS'`);
    await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS dimension_l DECIMAL(12,4)`);
    await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS dimension_w DECIMAL(12,4)`);
    await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS dimension_h DECIMAL(12,4)`);
    await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS dimension_label TEXT`);
    console.log('✅ Sale items table updated with dimension columns');
  } catch (e: any) {
    console.log('⚠️  Sale item dimension columns error:', e.message);
  }

  // ── Dashboard/report query indexes ────────────────────────────────────────
  // The /api/stats aggregates join these tables by shop, date and relation.
  // Created one-by-one so a missing table on older databases never breaks boot.
  try {
    const perfIndexes = [
      `CREATE INDEX IF NOT EXISTS invoice_payments_sale_idx ON invoice_payments(sale_id)`,
      `CREATE INDEX IF NOT EXISTS invoice_payments_created_idx ON invoice_payments(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS debt_payments_debtor_idx ON debt_payments(debtor_id)`,
      `CREATE INDEX IF NOT EXISTS debt_payments_created_idx ON debt_payments(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS debt_items_debtor_idx ON debt_items(debtor_id)`,
      `CREATE INDEX IF NOT EXISTS service_records_shop_created_idx ON service_records(shop_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS expenses_shop_date_idx ON expenses(shop_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS products_shop_active_idx ON products(shop_id, is_active)`,
      `CREATE INDEX IF NOT EXISTS pre_order_payments_created_idx ON pre_order_payments(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS customers_shop_phone_idx ON customers(shop_id, phone)`,
      `CREATE INDEX IF NOT EXISTS sales_shop_updated_idx ON sales(shop_id, updated_at DESC)`,
    ];
    for (const stmt of perfIndexes) {
      try { await pool.query(stmt); } catch { /* table missing on this DB — skip */ }
    }
    console.log('✅ Dashboard query indexes ensured');
  } catch (e: any) {
    console.log('⚠️  Dashboard index check:', e.message);
  }

  // Add dimension_unit to products (cm or m) for flexible dimension entry
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS dimension_unit VARCHAR(5) DEFAULT 'm'`);
    console.log('✅ Products table updated with dimension_unit column');
  } catch (e: any) {
    console.log('⚠️  Product dimension_unit column error:', e.message);
  }

  // Add full product size & price columns (for steel bars, glass sheets, pipes, etc.)
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS full_product_length DECIMAL(10, 4)`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS full_product_width DECIMAL(10, 4)`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS full_product_price DECIMAL(12, 2)`);
    console.log('✅ Products table updated with full_product columns');
  } catch (e: any) {
    console.log('⚠️  Product full_product columns error:', e.message);
  }

  // Allow NULL selling_price
  try {
    await pool.query(`ALTER TABLE products ALTER COLUMN selling_price DROP NOT NULL`);
    await pool.query(`ALTER TABLE products ALTER COLUMN selling_price SET DEFAULT NULL`);
    console.log('✅ Products table updated: selling_price can be NULL');
  } catch (e: any) {
    console.log('⚠️  Product selling_price NULL error:', e.message);
  }

  // Shop custom units table - allows each shop to define their own units.
  // ensureShopUnitsSchema also repairs older tables that are missing columns
  // (which made every units request 500 until now).
  try {
    await ensureShopUnitsSchema();
    console.log('✅ Shop units table ready (unique index ready)');
  } catch (e: any) {
    console.log('⚠️  Shop units table error:', e.message);
  }

  // Supplier order items: link each ordered line to a real product (chosen from
  // the shop/ghala catalog) and optionally an expiry date, so receiving the
  // order can add stock to the right product instead of relying on names.
  try {
    await pool.query(`ALTER TABLE supplier_order_items ADD COLUMN IF NOT EXISTS product_id uuid`);
    await pool.query(`ALTER TABLE supplier_order_items ADD COLUMN IF NOT EXISTS expiry_date date`);
    console.log('✅ Supplier order item columns ready');
  } catch (e: any) {
    console.log('⚠️  supplier_order_items columns check:', e.message);
  }

  // Add custom_unit_code to sale_items for tracking which custom unit was used
  try {
    await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS custom_unit_code VARCHAR(20)`);
    console.log('✅ Sale items updated with custom_unit_code column');
  } catch (e: any) {
    console.log('⚠️  Sale items custom_unit_code column error:', e.message);
  }

  // Add logo and invoice_footer to shops for invoice branding
  try {
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo TEXT`);
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS invoice_footer TEXT`);
    console.log('✅ Shops table updated with logo and invoice_footer columns');
  } catch (e: any) {
    console.log('⚠️  Shop logo/invoice_footer column error:', e.message);
  }

  // Add description column to shops
  try {
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS description TEXT`);
    console.log('✅ Shops table updated with description column');
  } catch (e: any) {
    console.log('⚠️  Shop description column error:', e.message);
  }

  // Add is_active column to shops
  try {
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
    console.log('✅ Shops table updated with is_active column');
  } catch (e: any) {
    console.log('⚠️  Shop is_active column error:', e.message);
  }

  // Add TIN and VRN columns to shops for tax/invoice compliance
  try {
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS tin_number VARCHAR(50)`);
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS vrn_number VARCHAR(50)`);
    console.log('✅ Shops table updated with tin_number and vrn_number columns');
  } catch (e: any) {
    console.log('⚠️  Shop TIN/VRN columns error:', e.message);
  }

  // Contact requests table for public AI chat
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_requests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255) NOT NULL,
        message TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        admin_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Contact requests table created');
  } catch (e: any) {
    console.log('⚠️  Contact requests table error:', e.message);
  }

    // Backfill: Create sales records for existing manual debt payments
  try {
    // Fix existing migration records to use a real user + correct payment method
    await pool.query(`
      UPDATE sales s
      SET seller_id = COALESCE(
        (SELECT user_id FROM user_shops WHERE shop_id = s.shop_id LIMIT 1),
        (SELECT id FROM "user" WHERE role = 'developer' LIMIT 1),
        'migration'
      ),
      payment_method = 'debt',
      notes = 'Debt payment (backfill)'
      WHERE s.seller_id = 'migration'
         OR (s.sale_type = 'debt' AND s.payment_method = 'cash' AND s.notes = 'Debt payment')
    `);
    // Create sales for unmatched debtors (has payments but no linked sale)
    // Use payment_method='debt' so old payments don't inflate todaySales
    await pool.query(`
      INSERT INTO sales (shop_id, seller_id, total_amount, amount_paid, payment_method, customer_name, customer_phone, notes, sale_type)
      SELECT d.shop_id, 
        COALESCE(
          (SELECT user_id FROM user_shops WHERE shop_id = d.shop_id LIMIT 1),
          (SELECT id FROM "user" WHERE role = 'developer' LIMIT 1),
          'migration'
        ),
        dp.total_paid, dp.total_paid, 'debt', d.customer_name, d.customer_phone, 'Debt payment (backfill)', 'debt'
      FROM debtors d
      JOIN (SELECT debtor_id, SUM(amount) as total_paid FROM debt_payments GROUP BY debtor_id) dp ON dp.debtor_id = d.id
      WHERE d.sale_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sales s2 
          WHERE s2.shop_id = d.shop_id 
            AND s2.sale_type = 'debt' 
            AND s2.notes IN ('Debt payment', 'Debt payment (backfill)')
            AND s2.customer_phone IS NOT DISTINCT FROM d.customer_phone
            AND s2.customer_name IS NOT DISTINCT FROM d.customer_name
        )
    `);
    await pool.query(`
      UPDATE debtors d
      SET sale_id = s.id
      FROM sales s
      WHERE d.sale_id IS NULL
      AND s.shop_id = d.shop_id
      AND s.sale_type = 'debt'
      AND s.notes IN ('Debt payment', 'Debt payment (backfill)')
      AND s.customer_phone IS NOT DISTINCT FROM d.customer_phone
      AND s.customer_name IS NOT DISTINCT FROM d.customer_name
      AND d.id IN (SELECT debtor_id FROM debt_payments)
    `);
    // Sync payment_status on debt-linked sales from the debtor's actual status
    // Only update payment_status without changing updated_at so past payments
    // don't get falsely counted in todaySales after a server restart
    await pool.query(`
      UPDATE sales s
      SET payment_status = d.status
      FROM debtors d
      WHERE d.sale_id = s.id
        AND s.payment_status != d.status
        AND d.status IN ('paid', 'partial', 'unpaid')
    `);
    // Backfill: Fix buying_price_at_sale and discount on existing debt sale_items
    // so profit/loss is calculated correctly from actual product costs
    await pool.query(`
      UPDATE sale_items si
      SET buying_price_at_sale = COALESCE(p.buying_price, 0)
      FROM products p
      WHERE si.product_id = p.id
        AND si.sale_id IN (SELECT s.id FROM sales s JOIN debtors d ON d.sale_id = s.id WHERE s.sale_type = 'debt')
        AND (si.buying_price_at_sale IS NULL OR si.buying_price_at_sale = 0)
    `);
    await pool.query(`
      UPDATE sale_items si
      SET discount = (
        SELECT di.discount FROM debtors d
        JOIN debt_items di ON di.debtor_id = d.id
        WHERE d.sale_id = si.sale_id
          AND di.product_id IS NOT DISTINCT FROM si.product_id
          AND di.discount > 0
        LIMIT 1
      )
      WHERE si.sale_id IN (SELECT s.id FROM sales s JOIN debtors d ON d.sale_id = s.id WHERE s.sale_type = 'debt')
        AND si.product_id IS NOT NULL
        AND (si.discount IS NULL OR si.discount = 0)
        AND EXISTS (
          SELECT 1 FROM debtors d
          JOIN debt_items di ON di.debtor_id = d.id
          WHERE d.sale_id = si.sale_id
            AND di.product_id IS NOT DISTINCT FROM si.product_id
            AND di.discount > 0
        )
    `);
    console.log('✅ Backfilled sales records for existing debt payments');

    // Backfill: Fix buying_price_at_sale for ALL sale_items where product_id is set
    await pool.query(`
      UPDATE sale_items si
      SET buying_price_at_sale = COALESCE(p.buying_price, 0)
      FROM products p
      WHERE si.product_id = p.id
        AND (si.buying_price_at_sale IS NULL OR si.buying_price_at_sale = 0)
    `);
    console.log('✅ Backfilled buying_price_at_sale for all sale_items');
  } catch (e: any) {
    console.log('⚠️  Debt backfill migration error:', e.message);
  }
}

// Add sale_type column to sales table for existing databases
// (runs outside if(dbOk) to always attempt — pool auto-reconnects)
try {
  await pool.query(`
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_type VARCHAR(20) DEFAULT 'normal'
  `);
  console.log('✅ Sales table updated with sale_type column');
} catch (e: any) {
  console.log('⚠️  Sale_type column might already exist:', e.message);
}

// Add cost_per_qty columns to products for existing databases
try {
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_per_qty DECIMAL(12,4) DEFAULT 1`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_per_qty_price DECIMAL(12,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_per_qty_buy_price DECIMAL(12,2) DEFAULT 0`);
  console.log('✅ Products table updated with cost_per_qty columns');
} catch (e: any) {
  console.log('⚠️  Cost per qty columns might already exist:', e.message);
}

  // Add partial unique index on settings(key) for global settings (shop_id IS NULL)
  try {
    // Remove any duplicate global setting rows first
    await pool.query(`
      DELETE FROM settings a USING settings b 
      WHERE a.id < b.id 
        AND a.key = b.key 
        AND a.shop_id IS NULL 
        AND b.shop_id IS NULL
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key_global 
      ON settings (key) WHERE shop_id IS NULL
    `);
    console.log('✅ Settings key unique constraint added for global settings');
  } catch (e: any) {
    console.log('⚠️  Settings unique index error:', e.message);
  }

// Enable pg_trgm for fast text search (gracefully handles missing extension)
if (dbOk && STARTUP_SCHEMA) {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON products USING gin (sku gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_barcode_trgm ON products USING gin (barcode gin_trgm_ops)`);
    console.log('✅ pg_trgm extension & text search indexes created');
  } catch (e: any) {
    console.log('⚠️  pg_trgm extension not available (non-superuser DB) — text search falls back to ILIKE');
  }
}

console.log('\n✅ Server starting...\n');

// Clean up duplicate accounts (null password accounts)
if (dbOk) {
  // ── Critical schema guarantees (run even when RUN_STARTUP_SCHEMA=false) ────
  // Some columns/indexes are still only created by the runtime schema bootstrap.
  // If an operator runs with RUN_STARTUP_SCHEMA=false (migrations at deploy
  // time only), a missing column used to take down core endpoints — e.g. a
  // missing shops.type made GET /api/shops return 400 and left every shop
  // without its active shop. These checks are idempotent and cheap.
  try {
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'shop' NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS shops_type_idx ON shops(type)`);
  } catch (e: any) {
    console.log('⚠️  shops.type ensure skipped:', e.message);
  }
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_offline_id_unique ON sales (offline_id) WHERE offline_id IS NOT NULL`);
  } catch (e: any) {
    console.log('⚠️  sales.offline_id unique index ensure skipped:', e.message);
  }
  try {
    await pool.query(`
      DO $$ BEGIN
        UPDATE settings
           SET value = jsonb_set(value, '{systemName}', '"ALFEAN ENTERPRISES"'),
               updated_at = CURRENT_TIMESTAMP
         WHERE key = 'system' AND value->>'systemName' = 'ALFEAN ENTERPRISES';
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);
  } catch (e: any) {
    console.log('⚠️  system name ensure skipped:', e.message);
  }
  // Legacy id cleanup: "user".shop_id / tenant_id are VARCHAR and a non-UUID
  // value makes uuid-typed lookups fail. Clear them so the auth middleware can
  // resolve the correct tenant/shop again.
  try {
    const UUID_RE_SQL = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    const shopFix = await pool.query(
      `UPDATE "user" SET shop_id = NULL, updated_at = NOW()
        WHERE shop_id IS NOT NULL AND shop_id <> '' AND shop_id !~* $1`,
      [UUID_RE_SQL]
    );
    const tenantFix = await pool.query(
      `UPDATE "user" SET tenant_id = NULL, updated_at = NOW()
        WHERE tenant_id IS NOT NULL AND tenant_id <> '' AND tenant_id !~* $1`,
      [UUID_RE_SQL]
    );
    if ((shopFix.rowCount || 0) > 0 || (tenantFix.rowCount || 0) > 0) {
      console.log(`✅ Legacy id cleanup: cleared ${shopFix.rowCount || 0} invalid shop_id and ${tenantFix.rowCount || 0} invalid tenant_id value(s)`);
    }
  } catch (e: any) {
    console.log('⚠️  Legacy id cleanup skipped:', e.message);
  }

  // Unique constraints the runtime code relies on for ON CONFLICT. Databases
  // built from the SQL migrations may lack them because CREATE TABLE IF NOT
  // EXISTS never alters an existing table — which broke the membership
  // self-heal ("no unique or exclusion constraint matching the ON CONFLICT
  // specification") and the SMS provider wallet monitor. Duplicate rows are
  // cleaned first so the index can always be created.
  const CONSTRAINT_REPAIRS: Array<{ name: string; sql: string; dedupe?: string }> = [
    {
      name: 'user_shops_user_shop_unique',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS user_shops_user_shop_unique ON user_shops(user_id, shop_id)`,
      dedupe: `DELETE FROM user_shops a USING user_shops b WHERE a.ctid < b.ctid AND a.user_id = b.user_id AND a.shop_id = b.shop_id`,
    },
    {
      name: 'user_permissions_user_shop_perm_unique',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS user_permissions_user_shop_perm_unique ON user_permissions(user_id, shop_id, permission)`,
      dedupe: `DELETE FROM user_permissions a USING user_permissions b WHERE a.ctid < b.ctid AND a.user_id = b.user_id AND a.shop_id = b.shop_id AND a.permission = b.permission`,
    },
    {
      name: 'sms_accounts_shop_id_unique',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS sms_accounts_shop_id_unique ON sms_accounts(shop_id)`,
      dedupe: `DELETE FROM sms_accounts a USING sms_accounts b WHERE a.ctid < b.ctid AND a.shop_id = b.shop_id`,
    },
  ];
  for (const repair of CONSTRAINT_REPAIRS) {
    try {
      await pool.query(repair.sql);
    } catch (e: any) {
      if (repair.dedupe && /duplicate key/i.test(e.message || '')) {
        try {
          await pool.query(repair.dedupe);
          await pool.query(repair.sql);
          console.log(`✅ ${repair.name}: duplicate rows removed and unique index created`);
        } catch (e2: any) {
          console.log(`⚠️  ${repair.name} ensure skipped:`, e2.message);
        }
      } else {
        console.log(`⚠️  ${repair.name} ensure skipped:`, e.message);
      }
    }
  }

  try {
    const cleanup = await pool.query(`
      DELETE FROM account 
      WHERE id IN (
        SELECT a1.id FROM account a1
        JOIN account a2 ON a1.user_id = a2.user_id AND a1.provider_id = a2.provider_id
        WHERE a1.password IS NULL AND a2.password IS NOT NULL
      )
    `);
    console.log('✅ Cleaned up duplicate accounts');
  } catch (e: any) {
    console.log('⚠️  Account cleanup error:', e.message);
  }
  
  // Remove bcrypt: prefix from passwords (Better Auth expects plain bcrypt hashes)
  try {
    await removePasswordPrefix();
  } catch (e: any) {
    console.log('⚠️  Password prefix cleanup error:', e.message);
  }
}

// Background jobs (backups + all cron jobs) run on ONE instance only. With
// multiple replicas (Coolify scaling / PM2 cluster) every instance would
// otherwise run them and cause duplicate emails and double subscription
// expirations. A Postgres advisory lock elects a single leader per cluster.
if (dbOk) {
  const isLeader = await acquireLeaderLease();
  if (isLeader) {
    try {
      await backupScheduler.initialize();
    } catch (e: any) {
      console.log('⚠️  Backup scheduler initialization error:', e.message);
    }
    if (OFFLINE_MODE) {
      console.log('[Offline] Cloud, SMS, email marketing and payment jobs disabled');
    } else {
      try {
        logSnippeConfigStatus();
        startDailySalesReportCron();
        startSmsCampaignCron();
        startUserSmsCampaignCron();
        startProviderWalletMonitor();
        startAutoSmsReminderCron();
        startQueuedSmsFlusher();
        startSenderIdStatusSyncCron();
        startSmsDeliverySync();
        startSmsPurchaseReconcileCron();
        startExpiryReminderCron();
      } catch (e: any) {
        console.log('⚠️  Subscription cron error:', e.message);
      }
    }
    console.log('[Leader] Leader lease acquired — background jobs active on this instance');
  } else {
    console.log('[Leader] Another instance holds the leader lease — background jobs skipped');
  }
}

// Create Hono app with typed variables for Better Auth
const app = new Hono<{
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
    shopIds: string[];
    userRole: string;
    userId: string;
    tenantId: string;
    authError?: boolean;
  };
}>();

// Slow-request logger — flags any request over 2s in the server logs. In the
// deployed version this reveals which endpoint is stalling (often /api/stats on
// shops with lots of data), which is invisible in local dev.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const elapsed = Date.now() - start;
  if (elapsed > 2000) {
    console.warn(`[Slow] ${c.req.method} ${c.req.path} took ${elapsed}ms`);
  }
});

// CORS middleware for Better Auth - must be before routes
app.use(
  '/api/auth/*',
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:5173','http://localhost:3000', 'http://127.0.0.1:47831'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
    allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE'],
    exposeHeaders: ['Content-Length', 'Set-Cookie'],
    maxAge: 600,
    credentials: true,
  })
);

// Global CORS for other routes
app.use('*', cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001','http://127.0.0.1:47831'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
  allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE'],
  credentials: true,
}));

// Offline desktop: cloud-only modules are intentionally unavailable. Return a
// clear, fast error instead of letting the UI wait for an internet timeout.
if (OFFLINE_MODE) {
  const offlineBlocked = [
    '/api/sms', '/api/admin/sms',
    '/api/admin/emails', '/api/admin/email-management',
    '/api/ai', '/api/ai-advisor',
    '/api/support', '/api/public/chat',
    '/api/subscriptions', '/api/admin/subscriptions',
    '/api/referrals', '/api/webhooks', '/api/webhook',
    '/api/backup-notifications',
    '/api/blog', '/api/dev-blog', '/api/landing',
  ];
  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return await next();
    if (offlineBlocked.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))) {
      return c.json({
        success: false,
        error: 'offline_mode',
        message: 'This feature requires internet and is disabled in the offline desktop app.',
      }, 503);
    }
    return await next();
  });
}

// Block WordPress vulnerability scanners & common bots early
const BLOCKED_PATHS = [
  '/wp-', '/wordpress', '/xmlrpc', '/file.php', '/wp-admin',
  '/wp-includes', '/xmrlpc', '/epinyins', '/ok.php', '/item.php',
  '/function/', '/shell', '/cmd', '/admin.php', '/autoload',
];

app.use('*', async (c, next) => {
  const path = c.req.path.toLowerCase();
  for (const prefix of BLOCKED_PATHS) {
    if (path.startsWith(prefix)) {
      return c.text('Not Found', 404);
    }
  }
  await next();
});

// Security headers middleware
app.use('*', async (c, next) => {
  // Prevent clickjacking
  c.header('X-Frame-Options', 'DENY');
  // Prevent XSS attacks
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-XSS-Protection', '1; mode=block');
  // Referrer policy
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Content Security Policy
  if (process.env.NODE_ENV === 'production') {
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; worker-src 'self' blob:; child-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'");
  }
  // No HSTS for the local HTTP desktop server.
  if (process.env.NODE_ENV === 'production' && !OFFLINE_MODE) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  await next();
});

// Response compression (gzip/brotli).
// SSE must never be compressed: gzip buffers event-stream chunks, so the
// browser's EventSource never fires "open" and live chat stays stuck on
// "Connecting..." (and messages only appear via polling).
const compressMiddleware = compress();
app.use('/api/*', async (c, next) => {
  if (c.req.path.endsWith('/stream')) return next();
  return compressMiddleware(c, next);
});

// Response time logging middleware (only logs slow requests over 1s)
app.use('/api/*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (ms > 1000) {
    console.log(`[SLOW] ${c.req.method} ${c.req.path} - ${ms}ms`);
  }
  c.header('X-Response-Time', `${ms}ms`);
});

// Logger middleware. In production this printed one line per request for every
// visitor (static assets included) — useful in dev, pure overhead in prod.
// Set DEBUG_LOGS=true to force it back on.
if (DEBUG_LOGS) app.use('*', logger());

// Session lookup is only needed for authenticated API routes. Static assets
// (JS/CSS/images), the HTML shell and every non-API path must NOT hit the DB —
// a single SPA load fires ~50+ asset requests, and each one previously ran a
// auth.api.getSession() DB query, saturating the connection pool and causing
// multi-second TTFB (some requests took over a minute on 3G).
const skipSessionPaths = [
  '/api/auth/', '/api/webhooks/', '/api/webhook', '/api/public/', '/api/backup-notifications/',
  '/api/diag', '/health', '/assets', '/favicon.', '/logo.', '/vite.', '/sitemap',
  '/robots.txt', '/apple-touch-icon.',
];
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  for (const skip of skipSessionPaths) {
    if (path.startsWith(skip)) {
      return await next();
    }
  }

    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) {
        c.set('user', null);
        c.set('session', null);
      } else {
        c.set('user', session.user);
        c.set('session', session.session);
      }
    } catch (e: any) {
      console.error('[Auth] Session lookup failed:', e?.message || e);
      c.set('authError', true);
      c.set('user', null);
      c.set('session', null);
    }

    await next();
  });

// Error handler to catch 400 errors
app.onError((err, c) => {
  console.error('[Global Error]', err);
  const isDev = process.env.NODE_ENV !== 'production';
  return c.json({ 
    success: false, 
    error: err.message,
    ...(isDev ? { stack: err.stack } : {})
  }, 400);
});

// Health check with cache stats
app.get('/health', (c) => {
  const cacheStats = cache.stats();
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    auth: 'better-auth',
    cache: {
      enabled: true,
      size: cacheStats.size,
      keys: cacheStats.keys.length
    }
  });
});

// Client-side diagnostic logging. The browser POSTs here (batched via
// sendBeacon) so a white page / crash in production is visible from the server
// log without needing remote debugging. Public endpoint on purpose — it must
// work even when the user is stuck on a white screen pre-login.
// Public crash/diagnostics sink (the client reports boot errors before login).
// It only writes to the server log, but cap what an anonymous caller can push
// so it can't be used to flood the log or memory.
app.post('/api/diag', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* ignore parse errors */ }
  const rawEntries = Array.isArray(body) ? body : [body];
  const entries = rawEntries.slice(0, 20);
  for (const e of entries) {
    try {
      const { kind, at, url, msg, stack, ...rest } = e || {};
      const safe = (v: any, max: number) => String(v ?? '').slice(0, max);
      console.log(`[DIAG] ${safe(at, 40)} kind=${safe(kind, 40)} url=${safe(url, 200)} ${msg ? 'msg=' + safe(msg, 500) : ''} ${stack ? 'stack=' + safe(stack, 300) : ''}`);
      if (Object.keys(rest).length) {
        const s = JSON.stringify(rest);
        if (s && s.length < 800) console.log(`[DIAG]   ${s}`);
      }
    } catch (err) { /* never break the client on log failure */ }
  }
  return c.json({ ok: true });
});

// Detailed system health for super admin
app.get('/api/system/health', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  console.log('[System Health] userRole:', userRole);
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  
  try {
    // Database check
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    const dbLatency = Date.now() - dbStart;
    
    // Get table counts
    let counts = { users: 0, shops: 0, products: 0, sales: 0 };
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM "user"');
      counts.users = parseInt(r.rows[0].c) || 0;
      console.log('[Health] users count:', counts.users, 'raw:', r.rows[0].c);
    } catch (e) { console.error('Count users error:', e); }
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM shops');
      counts.shops = parseInt(r.rows[0].c) || 0;
      console.log('[Health] shops count:', counts.shops, 'raw:', r.rows[0].c);
    } catch (e) { console.error('Count shops error:', e); }
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM products');
      counts.products = parseInt(r.rows[0].c) || 0;
      console.log('[Health] products count:', counts.products, 'raw:', r.rows[0].c);
    } catch (e) { console.error('Count products error:', e); }
    try {
      const r = await pool.query('SELECT COUNT(*) as c FROM sales');
      counts.sales = parseInt(r.rows[0].c) || 0;
      console.log('[Health] sales count:', counts.sales, 'raw:', r.rows[0].c);
    } catch (e) { console.error('Count sales error:', e); }
    
    // Get recent errors
    let recentErrors = 0;
    try {
      recentErrors = parseInt((await pool.query(
        "SELECT COUNT(*) as c FROM system_errors WHERE created_at >= NOW() - INTERVAL '24 hours'"
      )).rows[0].c);
    } catch (e) { console.error('Count errors error:', e); }
    
    return c.json({
      success: true,
      data: {
        status: 'healthy',
        database: {
          connected: true,
          latency: dbLatency + 'ms'
        },
        tables: counts,
        errors: {
          last24h: recentErrors
        },
        system: {
          nodeVersion: process.version,
          platform: process.platform,
          uptime: Math.floor(process.uptime()) + 's',
          memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
          }
        },
        timestamp: new Date().toISOString(),
        // Flat keys for frontend compatibility
        dbLatency: dbLatency + 'ms',
        db_latency: dbLatency + 'ms',
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        uptime: Math.floor(process.uptime()) + 's',
        users: counts.users,
        shops: counts.shops,
        products: counts.products,
        sales: counts.sales,
      }
    });
  } catch (error: any) {
    return c.json({
      success: false,
      data: {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Cache management endpoint (admin only)
app.get('/api/cache/stats', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  if (userRole !== 'admin' && userRole !== 'developer') {
    return c.json({ success: false, error: 'Unauthorized' }, 403);
  }
  
  return c.json({
    success: true,
    data: cache.stats()
  });
});

// Clear cache endpoint (admin only)
app.post('/api/cache/clear', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  if (userRole !== 'admin' && userRole !== 'developer') {
    return c.json({ success: false, error: 'Unauthorized' }, 403);
  }
  
  cache.clear();
  return c.json({ success: true, message: 'Cache cleared successfully' });
});

// Better Auth routes - handles all /api/auth/* endpoints internally
// MUST be registered BEFORE custom auth routes so Better Auth catches
// paths like forget-password, reset-password, etc. first
app.all('/api/auth/*', async (c) => {
  try {
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 
                     c.req.header('x-real-ip') || 
                     c.req.header('cf-connecting-ip') ||
                     '127.0.0.1';
    
    const cookieHeader = c.req.header('cookie') || 'none';
    debugLog(`[Auth] ${c.req.method} ${c.req.url}`);
    debugLog(`[Auth] Cookie header: ${cookieHeader.substring(0, 150)}`);
    
    const rawRequest = c.req.raw;
    const enhancedHeaders = new Headers(rawRequest.headers);
    enhancedHeaders.set('x-forwarded-for', clientIp);
    enhancedHeaders.set('x-real-ip', clientIp);
    
    // Construct full URL for Better Auth (it needs absolute URLs)
    const url = new URL(rawRequest.url);
    const fullUrl = `${url.protocol}//${url.host}${c.req.path}${url.search}`;
    
    const enhancedRequest = new Request(fullUrl, {
      method: rawRequest.method,
      headers: enhancedHeaders,
      body: rawRequest.body,
      redirect: rawRequest.redirect,
    });
    
    debugLog('[Auth] Calling auth.handler...');
    const response = await auth.handler(enhancedRequest);
    
    const setCookieHeader = response.headers.get('set-cookie') || '';
    // Node exposes each Set-Cookie value through getSetCookie(). Preserve all
    // cookies when available; splitting a combined header by commas can break
    // on Expires attributes and was especially fragile for secure cookie names.
    const getSetCookie = (response.headers as any).getSetCookie;
    const cookies = typeof getSetCookie === 'function'
      ? getSetCookie.call(response.headers)
      : setCookieHeader.split(/,(?=\s*(?:(?:__Secure-|__Host-)?better-auth)[^=]*=)/);
    
    debugLog(`[Auth] Response status: ${response.status}`);
    debugLog(`[Auth] Set-Cookie: ${setCookieHeader.substring(0, 150)}`);
    debugLog(`[Auth] Parsed cookies: ${cookies.length}`);
    
    const body = await response.arrayBuffer();
    const bodyText = new TextDecoder().decode(body);
    debugLog(`[Auth] Body: ${bodyText.substring(0, 200)}`);
    
    // Track successful sign-ins in real time
    const isSignIn = c.req.method === 'POST' && c.req.path.includes('/sign-in/email');
    if (isSignIn && response.status === 200) {
      try {
        const bodyJson = JSON.parse(bodyText);
        const userData = bodyJson.user || bodyJson.data?.user;
        if (userData?.id) {
          const userAgent = c.req.header('user-agent');
          import('./utils/activity-logger.js').then(({ logLogin }) => {
            logLogin({
              userId: userData.id,
              userEmail: userData.email,
              userName: userData.name,
              ipAddress: clientIp,
              userAgent,
              status: 'success'
            });
          }).catch(() => {});
          pool.query(`UPDATE "user" SET last_login_at = NOW() WHERE id = $1`, [userData.id]).catch(() => {});
        }
      } catch (e) {
        // JSON parse might fail, ignore
      }
    }
    
    const res = c.body(body, response.status as any);
    
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() !== 'set-cookie') {
        res.headers.set(key, value);
      }
    }
    
    cookies.forEach((cookie: string) => {
      const trimmed = cookie.trim();
      if (trimmed) {
        res.headers.append('Set-Cookie', trimmed);
      }
    });
    
    return res;
  } catch (e: any) {
    debugLog(`[Auth] Error: ${e.message}`);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Custom Auth Routes - registered AFTER Better Auth handler so specific
// paths (register, login, me) override the wildcard Better Auth handler
app.route('/api/auth', authRoutes);
app.route('/api/public', publicRoutes);

// Protected route example
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();

// Builds the /api/me payload (role normalisation, shop resolution and the
// user_shops self-heal). Used by GET /api/me and GET /api/bootstrap so both
// always return an identical user/shop shape.
async function buildMePayload(user: any, session: any) {
  const userEmail = user.email?.toLowerCase();
  const isSuperAdminEmail = userEmail === SUPER_ADMIN_EMAIL;

  let dbUser = null;
  try {
    const userResult = await db.read(
      'SELECT id, email, name, role, shop_id, first_name, last_name FROM "user" WHERE id = $1',
      [user.id]
    );
    if (userResult.rows.length > 0) {
      dbUser = userResult.rows[0];
    }
  } catch (e) {
    console.error('Error fetching user data:', e);
  }

  if (isSuperAdminEmail && dbUser?.role !== 'developer') {
    try {
      await pool.query(
        `UPDATE "user" SET role = 'developer', updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      dbUser.role = 'developer';
    } catch (e) {
      console.error('Error updating role:', e);
    }
  }

  // Force super_admin role for configured email
  let finalRole = isSuperAdminEmail ? 'developer' : (dbUser?.role || 'seller');
  // Normalize Better Auth default 'user' role to 'admin' (new sign-ups are tenant owners)
  if (finalRole === 'user') {
    finalRole = 'admin';
    // Update the database to persist the correct role
    try {
      await pool.query(
        `UPDATE "user" SET role = 'admin', updated_at = NOW() WHERE id = $1 AND role = 'user'`,
        [user.id]
      );
      if (dbUser) dbUser.role = 'admin';
    } catch (e) {
      console.error('[API /me] Error updating role to admin:', e);
    }
  }
  
  // Fetch shop if user has one
  let shop = null;
  let userShopId = dbUser?.shop_id || user.shopId;
  
  // If super admin, they don't have a specific shop - developer role
  // They access all shops through admin APIs, not as assigned shop
  if (finalRole === 'developer') {
    shop = null;
    userShopId = null;
  } else if (!userShopId && !isSuperAdminEmail) {
    // Check if authMiddleware already created a shop via user_shops
    try {
      const existingUserShop = await db.read(
        `SELECT s.* FROM shops s JOIN user_shops us ON us.shop_id = s.id WHERE us.user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (existingUserShop.rows.length > 0) {
        userShopId = existingUserShop.rows[0].id;
        shop = existingUserShop.rows[0];
        await pool.query(
          `UPDATE "user" SET shop_id = $1, updated_at = NOW() WHERE id = $2 AND shop_id IS NULL`,
          [userShopId, user.id]
        );
        console.log('[API /me] Assigned existing shop from user_shops:', userShopId);
      } else {
        console.log('[API /me] No shop found, authMiddleware will create on next request');
        shop = null;
      }
    } catch (e: any) {
      console.error('[API /me] Error in shop check:', e.message);
    }
  } else if (userShopId) {
    const shopResult = await db.read('SELECT * FROM shops WHERE id::text = $1 LIMIT 1', [userShopId]);
    shop = shopResult.rows[0] || null;
  }

  // Self-heal: a user assigned a shop (user.shop_id) but missing its
  // user_shops membership row is invisible in Shop Members and cannot resolve
  // the shop from /api/shops (store staff ended up with no store after login).
  // Create the missing membership with their role so the assignment is
  // consistent across the app. Only when the shop actually exists — an orphan
  // id would otherwise be written back into user_shops (no FK on old DBs).
  if (finalRole !== 'developer' && userShopId && shop) {
    try {
      const memberRole = ['seller', 'manager', 'store', 'owner', 'admin'].includes(finalRole) ? finalRole : 'seller';
      await pool.query(
        `INSERT INTO user_shops (user_id, shop_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, shop_id) DO NOTHING`,
        [user.id, userShopId, memberRole]
      );
    } catch (e: any) {
      console.error('[API /me] membership self-heal failed:', e.message);
    }
  }

  const mergedUser = {
    ...user,
    role: finalRole,
    shopId: finalRole === 'developer' ? null : (shop?.id || null),
    firstName: dbUser?.first_name || user.firstName || null,
    lastName: dbUser?.last_name || user.lastName || null,
  };

  if (DEBUG_LOGS) console.log('[API /me] Returning user with role:', mergedUser.role);

  // Don't return shop for super admin - they're developer role, not tied to any shop
  const shopToReturn = finalRole === 'developer' ? null : shop;

  return {
    user: mergedUser,
    session,
    shop: shopToReturn,
  };
}

app.get('/api/me', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const session = c.get('session');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return c.json(await buildMePayload(user, session));
});

// Consolidated app-shell bootstrap: one request instead of the separate /me
// and /shops round trips the client used to make on every cold start. Returns
// the exact same user/shop/shops shapes as those endpoints.
app.get('/api/bootstrap', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const session = c.get('session');

  if (!user || !session) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const userRole = c.get('userRole');
    const shopIds = (c.get('shopIds') as string[]) || [];

    // Mirror the shop:read gate that GET /shops enforces, so bootstrap can
    // never expose more than the individual endpoint would.
    const canReadShops = await hasPermission(
      c.get('userId'),
      userRole,
      shopIds[0] || '',
      'shop:read',
      user?.email?.toLowerCase(),
    );

    const [me, shopsResult] = await Promise.all([
      buildMePayload(user, session),
      canReadShops
        ? listShopsForUser({
            userRole,
            userId: c.get('userId'),
            shopIds,
            tenantId: c.get('tenantId'),
            requestedType: c.req.query('type'),
          })
        : Promise.resolve({ rows: [] }),
    ]);

    return c.json({
      success: true,
      data: {
        user: me.user,
        shop: me.shop,
        shops: shopsResult.rows,
      }
    });
  } catch (error: any) {
    console.error('[Bootstrap] error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Admin user management routes are now handled by adminRoutes module (mounted at /api/admin)
// Removed duplicate inline definitions to prevent route conflicts

// Super admin user actions (super_admin only)
app.post('/api/super-admin/users/:userId/ban', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  const adminId = c.get('userId');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const userId = c.req.param('userId');
  const { reason } = await c.req.json().catch(() => ({}));
  await pool.query(`UPDATE "user" SET banned = true, ban_reason = $1, ban_expires = NOW() + INTERVAL '10 years' WHERE id = $2`, [reason || 'Banned by admin', userId]);
  if (adminId) {
    await pool.query(`INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'ban_user', $2)`, [adminId, JSON.stringify({ userId, reason })]);
  }
  return c.json({ success: true });
});

app.post('/api/super-admin/users/:userId/unban', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  const adminId = c.get('userId');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const userId = c.req.param('userId');
  await pool.query(`UPDATE "user" SET banned = false, ban_reason = NULL, ban_expires = NULL WHERE id = $1`, [userId]);
  if (adminId) {
    await pool.query(`INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'unban_user', $2)`, [adminId, JSON.stringify({ userId })]);
  }
  return c.json({ success: true });
});

app.delete('/api/super-admin/users/:userId', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  const adminId = c.get('userId');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const userId = c.req.param('userId');
  // End sessions first so no orphaned session rows remain (the session table
  // may not carry the user FK on older databases).
  await pool.query(`DELETE FROM "session" WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM user_shops WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
  if (adminId) {
    await pool.query(`INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'delete_user', $2)`, [adminId, JSON.stringify({ userId })]);
  }
  return c.json({ success: true });
});

// Force-logout a user on every device (developer only). Still needed when a
// device was lost or replaced: the single-device rule only ends the old session
// once the user signs in on a new device, so if they cannot sign in at all the
// developer must end the stranded session first.
app.post('/api/super-admin/users/:userId/logout-all', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  const adminId = c.get('userId');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const userId = c.req.param('userId');
  const result = await pool.query(`DELETE FROM "session" WHERE user_id = $1`, [userId]);
  if (adminId) {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'logout_all_sessions', $2)`,
      [adminId, JSON.stringify({ userId, removed: result.rowCount })]
    );
  }
  console.log(`[SuperAdmin] Force-logout: removed ${result.rowCount} session(s) for user ${userId}`);
  return c.json({ success: true, removed: result.rowCount });
});

// System errors (super_admin only)
app.get('/api/super-admin/errors', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const limit = parseInt(c.req.query('limit') || '50');
  const result = await pool.query(`SELECT * FROM system_errors ORDER BY created_at DESC LIMIT $1`, [limit]);
  return c.json({ success: true, data: { errors: result.rows } });
});

app.delete('/api/super-admin/errors', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  await pool.query(`DELETE FROM system_errors`);
  return c.json({ success: true });
});

// Subscription system routes are now handled by subscriptionRoutes and subscriptionAdminRoutes modules
// Removed duplicate inline definitions to prevent route conflicts with mounted routes
// The modules are mounted at /api/subscriptions and /api/admin/subscriptions below

// Legacy API Routes (protected)
// Apply subscription guard to feature-restricted routes. These run BEFORE
// route-level authMiddleware, so subscriptionGuard resolves identity from the
// session user / bearer token itself (see middleware/subscription.middleware.ts).
app.use('/api/products/*', subscriptionGuard);
app.use('/api/sales/*', subscriptionGuard);
app.use('/api/shops/*', subscriptionGuard);
app.use('/api/expenses/*', subscriptionGuard);
app.use('/api/debtors/*', subscriptionGuard);
app.use('/api/pre-orders/*', subscriptionGuard);
app.use('/api/stock-take/*', subscriptionGuard);
app.use('/api/backups/*', subscriptionGuard);
app.use('/api/customers/*', subscriptionGuard);
app.use('/api/backup-notifications/*', subscriptionGuard);
app.use('/api/reports', subscriptionGuard);
app.use('/api/reports/*', subscriptionGuard);
app.use('/api/shop-reports', subscriptionGuard);
app.use('/api/shop-reports/*', subscriptionGuard);
app.use('/api/profits', subscriptionGuard);
app.use('/api/profits/*', subscriptionGuard);
app.use('/api/ai-advisor/*', subscriptionGuard);
app.use('/api/ai/*', subscriptionGuard);
app.use('/api/categories/*', subscriptionGuard);
app.use('/api/services/*', subscriptionGuard);
app.use('/api/units/*', subscriptionGuard);
app.use('/api/export/*', subscriptionGuard);
app.use('/api/performance/*', subscriptionGuard);
app.use('/api/sms/*', subscriptionGuard);
app.use('/api/admin/*', subscriptionGuard);
app.use('/api/shop-members/*', subscriptionGuard);
app.use('/api/settings', subscriptionGuard);
app.use('/api/settings/*', subscriptionGuard);
app.use('/api/stats', subscriptionGuard);
app.use('/api/stats/*', subscriptionGuard);

app.route('/api/products', productRoutes);
app.route('/api/sales', saleRoutes);
app.route('/api/shops', shopRoutes);
app.route('/api/shop-members', shopMembersRoutes);
app.route('/api/units', unitRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/expenses', expenseRoutes);
app.route('/api/services', serviceRoutes);
app.route('/api/debtors', debtorRoutes);
app.route('/api/pre-orders', preorderRoutes);
app.route('/api/subscriptions', subscriptionRoutes);
app.route('/api/admin/subscriptions', subscriptionAdminRoutes);
app.route('/api/super-admin', superAdminRoutes);
    app.route('/api/system', systemConfigRoutes);
app.route('/api/stock-take', stockTakeRoutes);
app.route('/api/backups', backupRoutes);
app.route('/api/backup-notifications', backupNotificationsRoutes);
app.route('/api/export', exportRoutes);
app.route('/api/customers', customerRoutes);
  app.route('/api/webhooks', webhookRoutes);
  // eHub delivery reports are configured to POST to /webhooks/ehub (no /api
  // prefix) — mount the same router on the bare path so the URL in the eHub
  // dashboard works as-is.
  app.route('/webhooks', webhookRoutes);
app.post('/api/webhook', (c) => c.body('Not Found', 404));
app.route('/api/admin/emails', emailRoutes);
app.route('/api/admin/email-management', emailManagementRoutes);
app.route('/api/feedback', feedbackRoutes);
app.route('/api/landing', landingRoutes);
app.route('/api/performance', performanceRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/admin/sms', smsRoutes);
app.route('/api/sms', smsUserRoutes);
app.route('/api/categories', categoryRoutes);
  app.route('/api/combined', combinedRoutes);
  app.route('/api/referrals', referralRoutes);
  app.route('/api/blog', blogPublicRoutes);
  app.route('/api/dev-blog', blogDevRoutes);

// =====================================================
// 5-DAY PROMO — public tracking + developer report
// =====================================================
const PROMO_APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';
const TRACKING_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const logPromoHit = (tenantId: string, channel: string, kind: string, day: string) => {
  pool.query(
    `INSERT INTO promo_events (tenant_id, channel, kind, day_no) VALUES ($1, $2, $3, $4)`,
    [tenantId, channel, kind, parseInt(day) || null]
  ).catch(() => {});
};

// Email CTA click → log + send to the subscription page
app.get('/r/e/:tenantId/:day', (c: any) => {
  logPromoHit(c.req.param('tenantId'), 'email', 'click', c.req.param('day'));
  return c.redirect(`${PROMO_APP_URL}/subscription?utm_source=promo5day&utm_medium=email&utm_campaign=promo5day&day=${c.req.param('day')}`);
});

// SMS link click → log + send to the subscription page
app.get('/r/s/:tenantId/:day', (c: any) => {
  logPromoHit(c.req.param('tenantId'), 'sms', 'click', c.req.param('day'));
  return c.redirect(`${PROMO_APP_URL}/subscription?utm_source=promo5day&utm_medium=sms&utm_campaign=promo5day&day=${c.req.param('day')}`);
});

// Email open pixel → log + 1x1 transparent gif
app.get('/t/o/:tenantId/:day', (c: any) => {
  logPromoHit(c.req.param('tenantId'), 'email', 'open', c.req.param('day'));
  c.header('Content-Type', 'image/gif');
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  return c.body(TRACKING_GIF);
});

// Developer-only engagement report for the 5-day promo
app.get('/api/dev/promo-report', authMiddleware, async (c: any) => {
  try {
    const userRole = c.get('userRole') as string;
    if (userRole !== 'developer') {
      return c.json({ success: false, error: 'Developer only' }, 403);
    }

    const daysRes = await pool.query(`
      SELECT day_no,
        COUNT(*) FILTER (WHERE channel = 'email' AND kind = 'sent')::int  AS email_sent,
        COUNT(*) FILTER (WHERE channel = 'email' AND kind = 'open')::int  AS email_opened,
        COUNT(*) FILTER (WHERE channel = 'email' AND kind = 'click')::int AS email_clicked,
        COUNT(*) FILTER (WHERE channel = 'sms'   AND kind = 'sent')::int  AS sms_sent,
        COUNT(*) FILTER (WHERE channel = 'sms'   AND kind = 'click')::int AS sms_clicked
      FROM promo_events
      WHERE day_no IS NOT NULL
      GROUP BY day_no
      ORDER BY day_no
    `);

    const stateRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE day_no BETWEEN 1 AND 5 AND completed_at IS NULL)::int AS in_campaign,
        COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed,
        COUNT(DISTINCT tenant_id)::int AS contacted_tenants
      FROM promo_campaign_state
    `);

    const audienceRes = await pool.query(`
      SELECT
        COUNT(*)::int AS total_tenants,
        COUNT(*) FILTER (WHERE has_active)::int AS active_subscribers
      FROM (
        SELECT t.id,
          EXISTS (
            SELECT 1 FROM tenant_subscriptions ts
            WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()
          ) AS has_active
        FROM tenants t
        WHERE t.email IS NOT NULL AND t.email <> ''
      ) x
    `);

    return c.json({
      success: true,
      data: {
        days: daysRes.rows,
        campaign: stateRes.rows[0],
        audience: audienceRes.rows[0],
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});
app.route('/api/suppliers', supplierRoutes);
app.route('/api/store', storeRoutes);
app.route('/api/receipts', receiptRoutes);
app.route('/api/notes', notesRoutes);

// System shutdown endpoint
app.post('/api/system/shutdown', authMiddleware, async (c) => {
  // Developer-only: this stops the whole server for every tenant.
  if (c.get('userRole') !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  try {
    const { type } = await c.req.json();
    console.log(`\n🔌 System shutdown requested: ${type}\n`);
    
    // Graceful shutdown
    setTimeout(() => {
      process.exit(0);
    }, 1000);
    
    return c.json({ success: true, message: 'Shutting down...' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Settings routes
app.get('/api/settings', authMiddleware, async (c) => {
  try {
    const cachedSettings = cache.get(CACHE_KEYS.SYSTEM_SETTINGS);
    if (cachedSettings) {
      return c.json({ success: true, data: cachedSettings });
    }

    // Prefer the global row (shop_id IS NULL) — a stale per-shop row must
    // never shadow the system settings the admin panel writes.
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'system' ORDER BY (shop_id IS NULL) DESC, updated_at DESC LIMIT 1"
    );
    if (result.rows.length === 0) {
      const defaultSettings = {
        systemName: 'ALFEAN ENTERPRISES',
        systemDescription: 'Store Management',
        currency: 'TSh',
        receiptFooter: 'Thank you for your business!',
        showLogoOnInvoice: true,
        autoPrintReceipt: false,
        showReceiptPopup: false,
        videoLinks: {}
      };
      cache.set(CACHE_KEYS.SYSTEM_SETTINGS, defaultSettings, 10 * 60 * 1000);
      return c.json({ success: true, data: defaultSettings });
    }
    const row = result.rows[0];
    const settings = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    cache.set(CACHE_KEYS.SYSTEM_SETTINGS, settings, 10 * 60 * 1000);
    return c.json({ success: true, data: settings });
  } catch (error: any) {
    console.error('[Settings] Error:', error.message);
    const defaultSettings = {
      systemName: 'ALFEAN ENTERPRISES',
      systemDescription: 'Store Management',
      currency: 'TSh',
      receiptFooter: 'Thank you for your business!',
      showLogoOnInvoice: true,
      autoPrintReceipt: false,
      showReceiptPopup: false,
      videoLinks: {}
    };
    return c.json({ success: true, data: defaultSettings });
  }
});

app.post('/api/settings', authMiddleware, async (c) => {
  // System-wide settings (branding, currency, receipt footer, POS switches)
  // are admin/owner/developer only — members must never change them.
  const settingsRole = c.get('userRole');
  if (settingsRole !== 'admin' && settingsRole !== 'owner' && settingsRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
  }
  try {
    const data = await c.req.json();

    // Merge over the stored settings so a partial update (e.g. only the two
    // POS switches) can never wipe branding, logo or video links.
    let existing: Record<string, any> = {};
    try {
      const prev = await pool.query(
        "SELECT value FROM settings WHERE key = 'system' ORDER BY (shop_id IS NULL) DESC, updated_at DESC LIMIT 1"
      );
      if (prev.rows.length > 0) {
        const v = prev.rows[0].value;
        existing = typeof v === 'string' ? JSON.parse(v) : (v || {});
      }
    } catch { /* start from an empty object */ }

    const settingsValue = { ...existing, ...data };
    // The POS switches must be real booleans — a "false" string or a missing
    // field must never flip them on, and only an explicit false turns them off.
    settingsValue.autoPrintReceipt = settingsValue.autoPrintReceipt === true || settingsValue.autoPrintReceipt === 'true';
    settingsValue.showReceiptPopup = settingsValue.showReceiptPopup === true || settingsValue.showReceiptPopup === 'true';

    await pool.query(`DELETE FROM settings WHERE key = 'system' AND shop_id IS NULL`);
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('system', $1)`,
      [JSON.stringify(settingsValue)]
    );

    cache.invalidate(CACHE_KEYS.SYSTEM_SETTINGS);
    return c.json({ success: true, data: settingsValue });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// User shops assignment
app.post('/api/user-shops', authMiddleware, async (c) => {
  try {
    const { userId, shopId } = await c.req.json();
    const callerRole = c.get('userRole') as string;
    const callerShopIds = (c.get('shopIds') as string[]) || [];
    const callerTenantId = c.get('tenantId') as string;

    if (!userId || !shopId) {
      return c.json({ success: false, error: 'userId and shopId are required' }, 400);
    }

    // Only owners/admins may assign shops, and only shops they can access.
    if (callerRole !== 'developer') {
      if (callerRole !== 'admin' && callerRole !== 'owner') {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      }
      if (!callerShopIds.includes(shopId)) {
        return c.json({ success: false, error: 'You do not have access to that shop' }, 403);
      }
    }

    const target = await db.read('SELECT id, role, tenant_id FROM "user" WHERE id = $1', [userId]);
    if (target.rows.length === 0) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }
    const targetUser = target.rows[0];

    // Prevent cross-organisation assignments: the target must belong to the
    // caller's tenant or already share a shop with the caller.
    if (callerRole !== 'developer') {
      const sameTenant = callerTenantId && targetUser.tenant_id && String(targetUser.tenant_id) === String(callerTenantId);
      if (!sameTenant) {
        const shared = await db.read(
          'SELECT 1 FROM user_shops WHERE user_id = $1 AND shop_id = ANY($2) LIMIT 1',
          [userId, callerShopIds]
        );
        if (shared.rows.length === 0) {
          return c.json({ success: false, error: 'User does not belong to your organisation' }, 403);
        }
      }
    }

    const membershipRole = targetUser.role === 'admin' || targetUser.role === 'owner' ? 'owner' : 'seller';

    await pool.query(
      `INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, shop_id) DO UPDATE SET role = $3`,
      [userId, shopId, membershipRole]
    );
    // Give the user a default shop only when they don't already have one.
    await pool.query(
      `UPDATE "user" SET shop_id = COALESCE(shop_id, $1), updated_at = NOW() WHERE id = $2`,
      [shopId, userId]
    );
    // Membership changes must apply immediately (skip the 5-min auth cache).
    invalidateUserAuthCache(userId);

    return c.json({ success: true, message: 'Shop assigned successfully' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get user permissions
app.get('/api/permissions/:userId', authMiddleware, async (c) => {
  try {
    const userId = c.req.param('userId');
    const shopId = c.req.query('shopId');
    const userRole = c.get('userRole') as string;
    
    if (userRole !== 'admin' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }
    
    // Check if table exists
    const tableCheck = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'user_permissions')`
    );
    if (!tableCheck.rows[0].exists) {
      return c.json({ success: true, data: [] });
    }
    
    let query = 'SELECT * FROM user_permissions WHERE user_id = $1';
    const params: any[] = [userId];
    
    if (shopId) {
      query += ' AND shop_id = $2';
      params.push(shopId);
    }
    
    const result = await pool.query(query, params);
    
    return c.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Permissions GET error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Grant permission to user
app.post('/api/permissions', authMiddleware, async (c) => {
  try {
    const currentUser = c.get('user') as any;
    const userRole = c.get('userRole') as string;
    
    if (userRole !== 'admin' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }
    
    const { userId, shopId, permission, granted = true } = await c.req.json();
    
    if (!userId || !shopId || !permission) {
      return c.json({ success: false, error: 'userId, shopId, and permission are required' }, 400);
    }
    
    await pool.query(
      `INSERT INTO user_permissions (user_id, shop_id, permission, granted, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, shop_id, permission) 
       DO UPDATE SET granted = $4, granted_by = $5, granted_at = CURRENT_TIMESTAMP`,
      [userId, shopId, permission, granted, currentUser.id]
    );
    
    return c.json({ success: true, message: 'Permission granted successfully' });
  } catch (error: any) {
    console.error('Permissions POST error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Revoke permission from user
app.delete('/api/permissions', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole') as string;
    
    if (userRole !== 'admin' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }
    
    const { userId, shopId, permission } = await c.req.json();
    
    if (!userId || !shopId || !permission) {
      return c.json({ success: false, error: 'userId, shopId, and permission are required' }, 400);
    }
    
    await pool.query(
      'DELETE FROM user_permissions WHERE user_id = $1 AND shop_id = $2 AND permission = $3',
      [userId, shopId, permission]
    );
    
    return c.json({ success: true, message: 'Permission revoked successfully' });
  } catch (error: any) {
    console.error('Permissions DELETE error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Bulk update permissions for a user in a shop
app.put('/api/permissions/bulk', authMiddleware, async (c) => {
  try {
    const currentUser = c.get('user') as any;
    const userRole = c.get('userRole') as string;
    
    if (userRole !== 'admin' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }
    
    const { userId, shopId, permissions } = await c.req.json();
    
    await pool.query('DELETE FROM user_permissions WHERE user_id = $1 AND shop_id = $2', [userId, shopId]);
    
    for (const perm of permissions) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, shop_id, permission, granted, granted_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, shopId, perm.permission, perm.granted, currentUser.id]
      );
    }
    
    return c.json({ success: true, message: 'Permissions updated successfully' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get all available permissions
app.get('/api/permissions-list', authMiddleware, async (c) => {
  const permissions = [
    // Sales & POS
    { name: 'sale:create', description: 'Create sales', category: 'Sales' },
    { name: 'sale:read', description: 'View sales', category: 'Sales' },
    { name: 'sale:update', description: 'Update sales', category: 'Sales' },
    { name: 'sale:delete', description: 'Delete sales', category: 'Sales' },
    { name: 'sale:profit', description: 'View profit (today profit & sales profit)', category: 'Sales' },
    { name: 'invoice:create', description: 'Create invoices', category: 'Sales' },
    { name: 'invoice:read', description: 'View invoices', category: 'Sales' },
    { name: 'invoice:update', description: 'Update invoices', category: 'Sales' },
    { name: 'invoice:delete', description: 'Delete invoices', category: 'Sales' },
    // Products
    { name: 'product:create', description: 'Create products', category: 'Products' },
    { name: 'product:read', description: 'View products', category: 'Products' },
    { name: 'product:update', description: 'Update products', category: 'Products' },
    { name: 'product:delete', description: 'Delete products', category: 'Products' },
    { name: 'product:buying', description: 'View buying prices', category: 'Products' },
    { name: 'product:value', description: 'View stock values & expected revenue', category: 'Products' },
    { name: 'inventory:manage', description: 'Manage stock levels', category: 'Products' },
    // Dashboard
    { name: 'dashboard:revenue', description: 'View today sales revenue on dashboard', category: 'Dashboard' },
    { name: 'dashboard:profit', description: 'View today profit on dashboard', category: 'Dashboard' },
    { name: 'dashboard:value', description: 'View total revenue & stock value on dashboard', category: 'Dashboard' },
    // Customers & Debts
    { name: 'customer:create', description: 'Create customers', category: 'Customers & Debts' },
    { name: 'customer:read', description: 'View customers', category: 'Customers & Debts' },
    { name: 'customer:update', description: 'Update customers', category: 'Customers & Debts' },
    { name: 'customer:delete', description: 'Delete customers', category: 'Customers & Debts' },
    { name: 'debtor:create', description: 'Create debtor records', category: 'Customers & Debts' },
    { name: 'debtor:read', description: 'View debtors', category: 'Customers & Debts' },
    { name: 'debtor:update', description: 'Update debtors', category: 'Customers & Debts' },
    { name: 'debtor:delete', description: 'Delete debtors', category: 'Customers & Debts' },
    // Expenses
    { name: 'expense:create', description: 'Create expenses', category: 'Expenses' },
    { name: 'expense:read', description: 'View expenses', category: 'Expenses' },
    { name: 'expense:update', description: 'Update expenses', category: 'Expenses' },
    { name: 'expense:delete', description: 'Delete expenses', category: 'Expenses' },
    // Services (Huduma)
    { name: 'service:create', description: 'Record services performed', category: 'Services' },
    { name: 'service:read', description: 'View services & reports', category: 'Services' },
    { name: 'service:update', description: 'Manage services & categories', category: 'Services' },
    { name: 'service:delete', description: 'Delete services', category: 'Services' },
    // Suppliers (Wasambazaji)
    { name: 'supplier:create', description: 'Create supplier orders & record payments', category: 'Suppliers' },
    { name: 'supplier:read', description: 'View suppliers, orders & reports', category: 'Suppliers' },
    { name: 'supplier:update', description: 'Manage suppliers', category: 'Suppliers' },
    { name: 'supplier:delete', description: 'Delete suppliers & orders', category: 'Suppliers' },
    // Reports, Export & Stock Take
    { name: 'report:read', description: 'View reports', category: 'Reports' },
    { name: 'report:profit', description: 'View profit in reports', category: 'Reports' },
    { name: 'report:shops', description: 'View other shop performance', category: 'Reports' },
    { name: 'export:data', description: 'Export data', category: 'Reports' },
    { name: 'stock_take:create', description: 'Start stock take', category: 'Reports' },
    { name: 'stock_take:read', description: 'View stock take', category: 'Reports' },
    { name: 'stock_take:update', description: 'Edit stock take', category: 'Reports' },
    { name: 'stock_take:complete', description: 'Complete stock take', category: 'Reports' },
    { name: 'stock_take:approve', description: 'Approve stock take', category: 'Reports' },
    // Earnings & SMS
    { name: 'earning:read', description: 'Access earnings page', category: 'Earnings' },
    { name: 'sms:read', description: 'Access SMS Center', category: 'SMS' },
    // Store / Back office (Ghala)
    { name: 'store:read', description: 'View the store (ghala) & stock', category: 'Store' },
    { name: 'store:manage', description: 'Receive, issue & manage store stock', category: 'Store' },
    { name: 'store:request', description: 'Request goods from the store (Omba Mzigo)', category: 'Store' },
    // Settings & Users
    { name: 'settings:read', description: 'View settings', category: 'Settings' },
    { name: 'settings:update', description: 'Update settings', category: 'Settings' },
    { name: 'user:manage', description: 'Manage members', category: 'Settings' },
    // Shop
    { name: 'shop:read', description: 'View shop details', category: 'Shop' },
    { name: 'shop:update', description: 'Update shop details', category: 'Shop' },
  ];
  
  return c.json({ success: true, data: permissions });
});

// Current logged-in user's effective permissions for their active shop. This is
// how the client gates menus and sensitive fields (buying price, profit, etc.)
// without exposing the admin's own /permissions management endpoints to sellers.
app.get('/api/my-permissions', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId') as string;
    const userRole = c.get('userRole') as string;
    const shopIds = c.get('shopIds') as string[] || [];
    const user = c.get('user') as any;
    const shopId = (c.req.query('shopId') && shopIds.includes(c.req.query('shopId')!))
      ? c.req.query('shopId')!
      : (shopIds[0] || '');

    const { getEffectivePermissions } = await import('./middleware/rbac.middleware.js');
    const permissions = await getEffectivePermissions(userId, userRole, shopId, user?.email);

    return c.json({ success: true, data: { role: userRole, shopId, permissions } });
  } catch (error: any) {
    console.error('my-permissions error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Dashboard stats endpoint
// Tiny FNV-1a hash used for weak ETags (no crypto import needed). Repeat
// dashboard loads on slow connections then get an empty 304 instead of the JSON.
function weakEtag(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `W/"${(h >>> 0).toString(36)}-${s.length.toString(36)}"`;
}

app.get('/api/stats', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const session = c.get('session');
  
  if (!user || !session) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const userShopIds = c.get('shopIds') as string[];
  const requestedShopId = c.req.query('shopId');
  
  let shopIds: string[];
  if (requestedShopId && userShopIds.includes(requestedShopId)) {
    shopIds = [requestedShopId];
  } else if (userShopIds.length > 0) {
    shopIds = userShopIds;
  } else {
    return c.json({
      success: true,
      data: {
        todaySales: 0,
        totalSales: 0,
        totalProducts: 0,
        totalOrders: 0
      }
    });
  }

  try {
    // Cache stats per shop so the dashboard (loaded repeatedly on every visit
    // and refresh) does not re-run these heavy aggregates each time. Every write
    // that can change the numbers (sales, products, debtors, services, store…)
    // invalidates `stats:` on the server, so the cache is only ever served while
    // nothing changed — 2 minutes keeps repeat loads instant on slow phones.
    //
    // Services (Huduma) income can optionally be merged into today's sales
    // figures. The setting is checked here (outside the cache closure) and its
    // value is part of the cache key, so toggling it yields fresh numbers. The
    // services PUT /settings handler also invalidates the stats cache.
    let addServicesToSales = false;
    try {
      const servicesSettingsRes = await pool.query(
        `SELECT value FROM settings WHERE key = 'services' AND shop_id = ANY($1)`,
        [shopIds]
      );
      for (const r of servicesSettingsRes.rows as any[]) {
        const value = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        if (value?.add_to_sales === true) { addServicesToSales = true; break; }
      }
    } catch (e: any) {
      console.log('Services settings check error:', e.message);
    }
    const cacheKey = `stats:${addServicesToSales ? 'svc1:' : ''}${[...shopIds].sort().join(',')}`;

    const data: any = await cache.getOrSet(cacheKey, async () => {
    // Compute today's date range in Africa/Dar_es_Salaam/Nairobi (EAT, UTC+3)
    const now = new Date();
    const eatOffsetMs = 3 * 60 * 60 * 1000;
    const nowEAT = new Date(now.getTime() + eatOffsetMs);
    const eatStartUTC = new Date(
      Date.UTC(nowEAT.getUTCFullYear(), nowEAT.getUTCMonth(), nowEAT.getUTCDate()) - eatOffsetMs
    );
    const eatEndUTC = new Date(eatStartUTC.getTime() + 86400000);

    // Current-month window in Tanzanian time (EAT, UTC+3): starts on the 1st at
    // 00:00 EAT and runs through the last day at 23:59:59 EAT (the exclusive end
    // is the next month's 1st at 00:00 EAT). Date.UTC rolls over months/years.
    const monthStartUTC = new Date(Date.UTC(nowEAT.getUTCFullYear(), nowEAT.getUTCMonth(), 1) - eatOffsetMs);
    const monthEndUTC = new Date(Date.UTC(nowEAT.getUTCFullYear(), nowEAT.getUTCMonth() + 1, 1) - eatOffsetMs);
    const previousMonthStartUTC = new Date(Date.UTC(nowEAT.getUTCFullYear(), nowEAT.getUTCMonth() - 1, 1) - eatOffsetMs);

    // All queries run on the READ pool. Previously they ran on the write pool,
    // so when several devices loaded the dashboard at once the slow aggregates
    // consumed every write connection and froze ALL sales/product/session writes.
    const [todayResult, totalResult, productsResult, stockValueResult] = await Promise.all([
      db.read(
        `SELECT COUNT(DISTINCT sale_id) as count, COALESCE(SUM(total), 0) as total FROM (
           -- 1. Cash/lipa/bank sales created today (immediate revenue, excluding pre-orders)
           SELECT s.id as sale_id, s.total_amount as total FROM sales s
           WHERE s.shop_id = ANY($1) 
           AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
           AND s.sale_type IS DISTINCT FROM 'pre_order'
           AND s.created_at >= $2 AND s.created_at < $3
           UNION ALL
           -- 2. Invoice payments recorded today
           SELECT s.id as sale_id, ip.amount as total FROM invoice_payments ip
           JOIN sales s ON ip.sale_id = s.id
           WHERE s.shop_id = ANY($1)
           AND ip.created_at >= $2 AND ip.created_at < $3
           UNION ALL
           -- 3. Credit/invoice sales that became fully 'paid' today (excludes debts and pre-orders — those are in part 4/5)
           SELECT s.id as sale_id, s.total_amount as total FROM sales s
           WHERE s.shop_id = ANY($1)
           AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank')
           AND s.payment_status = 'paid'
           AND s.sale_type IS DISTINCT FROM 'pre_order'
           AND s.updated_at >= $2 AND s.updated_at < $3
           AND NOT EXISTS (
             SELECT 1 FROM invoice_payments ip WHERE ip.sale_id = s.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM debtors d WHERE d.sale_id = s.id
           )
           UNION ALL
           -- 4. Pre-order payments today
           SELECT pp.pre_order_id as sale_id, pp.amount as total FROM pre_order_payments pp
           JOIN pre_orders po ON pp.pre_order_id = po.id
           WHERE po.shop_id = ANY($1)
           AND pp.created_at >= $2 AND pp.created_at < $3
           UNION ALL
           -- 5. Debt payments recorded today (partial or full — each payment counts on its own day)
           SELECT COALESCE(d.sale_id, dp.id) as sale_id, dp.amount as total FROM debt_payments dp
           JOIN debtors d ON dp.debtor_id = d.id
           WHERE d.shop_id = ANY($1)
           AND dp.created_at >= $2 AND dp.created_at < $3
           UNION ALL
           -- 6. Debt sales created today (count as orders only, revenue = 0 until payment)
           SELECT s.id as sale_id, 0 as total FROM sales s
           WHERE s.shop_id = ANY($1)
           AND s.payment_method = 'debt'
           AND s.created_at >= $2 AND s.created_at < $3
           UNION ALL
           -- 7. Pre-orders created today (count as orders only, stock already deducted at creation)
           SELECT po.id as sale_id, 0 as total FROM pre_orders po
           WHERE po.shop_id = ANY($1)
           AND po.created_at >= $2 AND po.created_at < $3
           ${addServicesToSales ? `
           UNION ALL
           -- 8. Services (Huduma) income recorded today — merged only when the
           -- shop enables "add services to sales". NULL sale_id keeps the order
           -- count unchanged.
           -- Keep this cast as ::uuid: every other branch returns a uuid
           -- sale_id, and a ::text here makes Postgres reject the whole UNION
           -- ("UNION types uuid and text cannot be matched") → /api/stats 400s
           -- and every dashboard card silently falls back to 0.
           SELECT NULL::uuid as sale_id, sr.total as total FROM service_records sr
           WHERE sr.shop_id = ANY($1) AND sr.created_at >= $2 AND sr.created_at < $3` : ''}
         ) combined`,
        [shopIds, eatStartUTC, eatEndUTC]
      ),
      db.read(
        `SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total FROM (
           SELECT s.total_amount as total FROM sales s
           WHERE s.shop_id = ANY($1)
           AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
           AND s.sale_type IS DISTINCT FROM 'pre_order'
           UNION ALL
           SELECT ip.amount as total FROM invoice_payments ip
           JOIN sales s ON ip.sale_id = s.id
           WHERE s.shop_id = ANY($1)
           UNION ALL
           SELECT dp.amount as total FROM debt_payments dp
           JOIN debtors d ON dp.debtor_id = d.id
           WHERE d.shop_id = ANY($1)
           UNION ALL
           SELECT pp.amount as total FROM pre_order_payments pp
           JOIN pre_orders po ON pp.pre_order_id = po.id
           WHERE po.shop_id = ANY($1)
         ) combined`,
         [shopIds]
      ),
      db.read(
        `SELECT COUNT(*) as count FROM products WHERE shop_id = ANY($1) AND is_active = true`,
         [shopIds]
      ),
      db.read(
        `SELECT COALESCE(SUM(current_stock * buying_price), 0) as total_value 
         FROM products WHERE shop_id = ANY($1) AND is_active = true`,
         [shopIds]
      ),
    ]);

    // The remaining aggregates are independent of each other, so they run in
    // parallel waves instead of ~12 sequential round trips. Each query keeps
    // its own fallback so a single failure degrades exactly as before.
    const safeQuery = async (label: string, run: () => Promise<any>, fallback: any): Promise<any> => {
      try { return await run(); } catch (e: any) { console.log(`${label} error:`, e.message); return fallback; }
    };

    // Wave 1 — debt totals (all-time, today, this month).
    const [debtsResult, todayDebtsResult, monthlyDebtsResult] = await Promise.all([
      safeQuery('Debts query', () => db.read(
        `SELECT 
          COUNT(*) as total_debtors,
          COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)), 0) as total_unpaid
         FROM debtors 
         WHERE shop_id = ANY($1) AND status != 'paid'`,
        [shopIds]
      ), { rows: [{ total_debtors: 0, total_unpaid: 0 }] }),
      safeQuery('Today debts query', () => db.read(
        `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
         FROM debtors
         WHERE shop_id = ANY($1) AND created_at >= $2 AND created_at < $3`,
        [shopIds, eatStartUTC, eatEndUTC]
      ), { rows: [{ count: '0', total: '0' }] }),
      safeQuery('Monthly debts query', () => db.read(
        `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
         FROM debtors
         WHERE shop_id = ANY($1) AND created_at >= $2 AND created_at < $3`,
        [shopIds, monthStartUTC, monthEndUTC]
      ), { rows: [{ count: '0', total: '0' }] }),
    ]);
    const todayDebts = parseFloat(todayDebtsResult.rows[0].total);
    const todayDebtCount = parseInt(todayDebtsResult.rows[0].count);
    const monthlyDebts = parseFloat(monthlyDebtsResult.rows[0].total);
    const monthlyDebtCount = parseInt(monthlyDebtsResult.rows[0].count);

    // Gross profit within [start, end): cash/lipa/bank sales, fully-paid
    // pre-orders, debt payments, invoice payments and (optionally) services
    // income. Shared by the "Faida ya Leo" and "Faida ya Mwezi" cards.
    const computeProfit = async (start: Date, end: Date): Promise<number> => {
      try {
      const profitResult = await db.read(
          `SELECT COALESCE(SUM(profit), 0) as total_profit FROM (
            -- Profit from cash/lipa/bank sales (immediate payment — counted at creation)
            SELECT (si.unit_price * si.quantity - COALESCE(si.discount, 0)) - (COALESCE(si.buying_price_at_sale, 0) * si.quantity) as profit
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.id
            WHERE s.shop_id = ANY($1)
            AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
            AND s.sale_type IS DISTINCT FROM 'pre_order'
            AND s.created_at >= $2 AND s.created_at < $3
            UNION ALL
           -- Profit from pre-orders (fully paid today, via linked sale)
           SELECT COALESCE(SUM(
             (si.unit_price * si.quantity - COALESCE(si.discount, 0)) - (COALESCE(si.buying_price_at_sale, 0) * si.quantity)
           ), 0) as profit
           FROM sale_items si
           JOIN sales s ON si.sale_id = s.id
           JOIN pre_orders po ON po.sale_id = s.id
           WHERE po.shop_id = ANY($1)
           AND s.sale_type = 'pre_order'
           AND s.payment_status = 'paid'
           AND s.updated_at >= $2 AND s.updated_at < $3
           UNION ALL
           -- Profit from debt payments (proportional to payment amount)
           SELECT COALESCE(SUM(
             dp.amount - (bc.total_buying * LEAST(dp.amount / NULLIF(d.total_amount, 0), 1))
           ), 0) as profit
           FROM debt_payments dp
           JOIN debtors d ON dp.debtor_id = d.id
           LEFT JOIN (
             SELECT debtor_id, COALESCE(SUM(buying_price * quantity), 0) as total_buying
             FROM debt_items GROUP BY debtor_id
           ) bc ON bc.debtor_id = d.id
           WHERE d.shop_id = ANY($1)
           AND dp.created_at >= $2 AND dp.created_at < $3
           UNION ALL
           -- Profit from invoice payments (proportional to payment amount)
           SELECT COALESCE(SUM(
             ip.amount * (COALESCE(sp.total_profit, 0) / NULLIF(s.total_amount, 0))
           ), 0) as profit
           FROM invoice_payments ip
           JOIN sales s ON ip.sale_id = s.id
           LEFT JOIN (
             SELECT sale_id, COALESCE(SUM(
               (unit_price * quantity - COALESCE(discount, 0)) - (COALESCE(buying_price_at_sale, 0) * quantity)
             ), 0) as total_profit
             FROM sale_items GROUP BY sale_id
           ) sp ON sp.sale_id = s.id
           WHERE s.shop_id = ANY($1)
           AND ip.created_at >= $2 AND ip.created_at < $3
           UNION ALL
           -- Profit for credit/invoice sales marked as paid today without individual payments
           SELECT COALESCE(SUM(
             COALESCE(sp.total_profit, 0)
           ), 0) as profit
           FROM sales s
           LEFT JOIN (
             SELECT sale_id, COALESCE(SUM(
               (unit_price * quantity - COALESCE(discount, 0)) - (COALESCE(buying_price_at_sale, 0) * quantity)
             ), 0) as total_profit
             FROM sale_items GROUP BY sale_id
           ) sp ON sp.sale_id = s.id
           WHERE s.shop_id = ANY($1)
           AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt')
           AND s.payment_status = 'paid'
           AND s.sale_type IS DISTINCT FROM 'pre_order'
           AND s.updated_at >= $2 AND s.updated_at < $3
           AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.sale_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
           ${addServicesToSales ? `
           UNION ALL
           -- Services income recorded today — no cost of goods, full amount is profit
           SELECT COALESCE(SUM(sr.total), 0) as profit FROM service_records sr
           WHERE sr.shop_id = ANY($1) AND sr.created_at >= $2 AND sr.created_at < $3` : ''}
        ) combined`,
        [shopIds, start, end]
      );
      return parseFloat(profitResult.rows[0].total_profit);
    } catch(e: any) {
      console.log('Profit query error:', e.message);
      return 0;
    }
    };

    // Wave 2 — profit (today + month) and the monthly daily chart.
    const [todayProfit, monthlyProfitResult, monthlyResult] = await Promise.all([
      computeProfit(eatStartUTC, eatEndUTC),
      safeQuery('Monthly profit query', () => db.read(
        `SELECT COALESCE(SUM(si.profit), 0) as total
           FROM sale_items si
           JOIN sales s ON si.sale_id = s.id
          WHERE s.shop_id = ANY($1)
            AND s.sale_type IS DISTINCT FROM 'pre_order'
            AND s.created_at >= $2 AND s.created_at < $3`,
        [shopIds, monthStartUTC, monthEndUTC]
      ), { rows: [{ total: '0' }] }),
      safeQuery('Monthly sales query', () => db.read(
        `SELECT
           EXTRACT(DAY FROM (s.created_at + INTERVAL '3 hours') AT TIME ZONE 'UTC')::int as day,
           COALESCE(SUM(s.total_amount), 0) as total,
           COUNT(*) as orders
         FROM sales s
         WHERE s.shop_id = ANY($1)
           AND s.created_at >= $2
           AND s.created_at < $3
           AND s.sale_type IS DISTINCT FROM 'pre_order'
         GROUP BY 1
         ORDER BY 1`,
        [shopIds, monthStartUTC, monthEndUTC]
      ), { rows: [] }),
    ]);
    const monthlyProfit = parseFloat(monthlyProfitResult.rows[0].total);

    // Monthly sales (current month, daily totals). Aggregated in SQL instead of
    // shipping every sale row of the month to the server. EAT (+3h) is applied
    // so the day grouping matches the old JS logic.
    const monthlySales: { day: number; total: number; orders: number }[] = monthlyResult.rows.map((r: any) => ({
      day: parseInt(r.day),
      total: parseFloat(r.total),
      orders: parseInt(r.orders)
    }));

    // Wave 3 — services (Huduma) earnings today + expenses today & this month.
    const todayEATStr = nowEAT.toISOString().slice(0, 10);
    const monthStartEATStr = `${nowEAT.getUTCFullYear()}-${String(nowEAT.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const [servicesToday, expensesToday, expensesMonth] = await Promise.all([
      safeQuery('Services today query', () => db.read(
        `SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
         FROM service_records
         WHERE shop_id = ANY($1) AND created_at >= $2 AND created_at < $3`,
        [shopIds, eatStartUTC, eatEndUTC]
      ), { rows: [{ count: '0', total: '0' }] }),
      safeQuery('Expenses today query', () => db.read(
        `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
         FROM expenses
         WHERE shop_id = ANY($1) AND date = $2`,
        [shopIds, todayEATStr]
      ), { rows: [{ count: '0', total: '0' }] }),
      safeQuery('Expenses month query', () => db.read(
        `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
         FROM expenses
         WHERE shop_id = ANY($1) AND date >= $2 AND date <= $3`,
        [shopIds, monthStartEATStr, todayEATStr]
      ), { rows: [{ count: '0', total: '0' }] }),
    ]);
    const todayServices = parseFloat(servicesToday.rows[0].total);
    const todayServicesCount = parseInt(servicesToday.rows[0].count);
    const todayExpenses = parseFloat(expensesToday.rows[0].total);
    const todayExpensesCount = parseInt(expensesToday.rows[0].count);
    const monthlyExpenses = parseFloat(expensesMonth.rows[0].total);
    const monthlyExpensesCount = parseInt(expensesMonth.rows[0].count);

    // Wave 4 — month-over-month comparison + expiry + unsold product cards.
    // Month-over-month definition: every sale made (any payment method),
    // excluding pre-orders — matches the reports page and the sales page.
    const [monthCompare, expiringResult, unsoldResult] = await Promise.all([
      safeQuery('Month comparison query', () => db.read(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at >= $2 THEN total_amount ELSE 0 END), 0) as cur_total,
           COUNT(CASE WHEN created_at >= $2 THEN 1 END) as cur_count,
           COALESCE(SUM(CASE WHEN created_at < $2 THEN total_amount ELSE 0 END), 0) as prev_total,
           COUNT(CASE WHEN created_at < $2 THEN 1 END) as prev_count
         FROM sales
         WHERE shop_id = ANY($1)
           AND sale_type IS DISTINCT FROM 'pre_order'
           AND created_at >= $3 AND created_at < $4`,
        [shopIds, monthStartUTC, previousMonthStartUTC, monthEndUTC]
      ), { rows: [{ cur_total: '0', cur_count: '0', prev_total: '0', prev_count: '0' }] }),
      // Products close to (or past) their expiry date while still in stock —
      // powers the dashboard expiry alert. Returns nothing until a shop
      // actually uses expiry dates.
      safeQuery('Expiring products query', () => db.read(
        `SELECT p.id, p.name, p.current_stock, p.expiry_date, s.name as shop_name,
                (p.expiry_date::date - CURRENT_DATE) as days_left,
                COUNT(*) OVER() as total_count
           FROM products p
           JOIN shops s ON s.id = p.shop_id
          WHERE p.shop_id = ANY($1) AND p.is_active = true AND p.current_stock > 0
            AND p.expiry_date IS NOT NULL
            AND p.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
          ORDER BY p.expiry_date ASC
          LIMIT 5`,
        [shopIds]
      ), { rows: [] }),
      // Products that have not sold at all this month (top 5 by tied-up
      // capital) — powers the dashboard "business hints" card.
      safeQuery('Unsold products query', () => db.read(
        `SELECT p.id, p.name,
                COALESCE(p.current_stock, 0) as stock,
                COALESCE(p.buying_price, 0) as buying_price,
                (COALESCE(p.current_stock, 0) * COALESCE(p.buying_price, 0)) as stock_value,
                COUNT(*) OVER() as total_count
         FROM products p
         WHERE p.shop_id = ANY($1) AND p.is_active = true
           AND NOT EXISTS (
             SELECT 1 FROM sale_items si
             JOIN sales s ON si.sale_id = s.id
             WHERE si.product_id = p.id AND s.created_at >= $2
           )
         ORDER BY stock_value DESC NULLS LAST
         LIMIT 5`,
        [shopIds, monthStartUTC]
      ), { rows: [] }),
    ]);

    const currentMonthSales = parseFloat(monthCompare.rows[0].cur_total);
    const currentMonthOrders = parseInt(monthCompare.rows[0].cur_count);
    const previousMonthSales = parseFloat(monthCompare.rows[0].prev_total);
    const previousMonthOrders = parseInt(monthCompare.rows[0].prev_count);

    const expiringProducts: any[] = expiringResult.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      shopName: r.shop_name,
      stock: parseFloat(r.current_stock) || 0,
      expiryDate: r.expiry_date,
      daysLeft: parseInt(r.days_left),
    }));
    const expiringCount = expiringResult.rows.length > 0 ? parseInt(expiringResult.rows[0].total_count) : 0;

    const unsoldProducts: any[] = unsoldResult.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      stock: parseFloat(r.stock) || 0,
      buyingPrice: parseFloat(r.buying_price) || 0,
      stockValue: parseFloat(r.stock_value) || 0,
    }));
    const unsoldCount = unsoldResult.rows.length > 0 ? parseInt(unsoldResult.rows[0].total_count) : 0;

    return {
      todaySales: parseFloat(todayResult.rows[0].total),
      todayOrders: parseInt(todayResult.rows[0].count),
      todayProfit,
      monthlyProfit,
      todayExpenses,
      todayExpensesCount,
      monthlyExpenses,
      monthlyExpensesCount,
      todayServices,
      todayServicesCount,
      // The dashboard shows the Huduma card only when the shop opts in
      servicesAddToSales: addServicesToSales,
      totalSales: parseFloat(totalResult.rows[0].total),
      totalOrders: parseInt(totalResult.rows[0].count),
      totalProducts: parseInt(productsResult.rows[0].count),
      stockValue: parseFloat(stockValueResult.rows[0].total_value),
      totalDebt: parseFloat(debtsResult.rows[0].total_unpaid),
      totalDebtors: parseInt(debtsResult.rows[0].total_debtors),
      todayDebts,
      todayDebtCount,
      monthlyDebts,
      monthlyDebtCount,
      monthlySales,
      currentMonthSales,
      currentMonthOrders,
      previousMonthSales,
      previousMonthOrders,
      unsoldProducts,
      unsoldCount,
      expiringProducts,
      expiringCount
    };
    }, 120);

    // Sellers only see what their shop admin allows. Revenue/profit/stock
    // value cards are hidden unless the matching permission is granted.
    if (c.get('userRole') === 'seller') {
      const userId = c.get('userId') as string;
      const userEmail = (c.get('user') as any)?.email?.toLowerCase();
      const permShopId = (shopIds || [])[0] as string;
      const [canRevenue, canProfit, canValue] = await Promise.all([
        hasPermission(userId, 'seller', permShopId, 'dashboard:revenue', userEmail),
        hasPermission(userId, 'seller', permShopId, 'dashboard:profit', userEmail),
        hasPermission(userId, 'seller', permShopId, 'dashboard:value', userEmail),
      ]);
      if (!canRevenue) {
        data.todaySales = null;
        data.todayOrders = null;
        data.currentMonthSales = null;
        data.currentMonthOrders = null;
        data.previousMonthSales = null;
        data.previousMonthOrders = null;
      }
      if (!canProfit) {
        data.todayProfit = null;
        data.monthlyProfit = null;
      }
      if (!canValue) {
        data.totalSales = null;
        data.totalOrders = null;
        data.stockValue = null;
      }
    }

    // Low-bandwidth revalidation: the browser may store the response but must
    // revalidate it every time. When nothing changed it receives an empty 304
    // instead of re-downloading the JSON — a big win on 2G/3G.
    const body = JSON.stringify({ success: true, data });
    const etag = weakEtag(body);
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    if ((c.req.header('if-none-match') || '').trim() === etag) return c.body(null, 304);
    return c.body(body, 200, { 'Content-Type': 'application/json; charset=UTF-8' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// =====================================================
// USER ACTIVITY & ENGAGEMENT ENDPOINT
// Returns recent user activities, last login, active status
// Used by dashboard to show who's using the system
// =====================================================
app.get('/api/user-activity', authMiddleware, async (c: any) => {
  const shopIds = c.get('shopIds') as string[];
  const userRole = c.get('userRole') as string;
  const days = parseInt(c.req.query('days') || '14');
  
  if (!shopIds || shopIds.length === 0) {
    return c.json({ success: true, data: { users: [], recentActivity: [], summary: { totalUsers: 0, activeToday: 0, activeThisWeek: 0, inactive: 0 } } });
  }

  try {
    const filterShopId = c.req.query('shopId');
    const targetShopIds = (filterShopId && shopIds.includes(filterShopId)) ? [filterShopId] : shopIds;
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    const sinceStr = sinceDate.toISOString();

    // Get all users for the shops
    const usersResult = await db.read(`
      SELECT 
        u.id, u.name, u.email, u.role, u.shop_id,
        u.last_login_at,
        u.created_at,
        s.name as shop_name,
        (SELECT MAX(created_at) FROM activity_logs WHERE user_id::text = u.id) as last_activity_at,
        (SELECT action FROM activity_logs WHERE user_id::text = u.id ORDER BY created_at DESC LIMIT 1) as last_action,
        (SELECT COUNT(*) FROM activity_logs WHERE user_id::text = u.id AND created_at >= $2) as activity_count_30d,
        (SELECT COUNT(*) FROM sales WHERE seller_id::text = u.id AND created_at >= $2) as sales_count_30d,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE seller_id::text = u.id AND created_at >= $2) as revenue_30d
      FROM "user" u
      LEFT JOIN shops s ON u.shop_id::text = s.id::text
      WHERE u.shop_id::text = ANY($1) AND u.role IN ('admin', 'seller', 'owner')
      ORDER BY u.last_login_at DESC NULLS LAST
    `, [targetShopIds, sinceStr]);

    // Get recent activity feed (last 50 actions across shops)
    const recentActivityResult = await db.read(`
      SELECT 
        al.id, al.user_id, al.user_name, al.user_email,
        al.action, al.entity_type, al.entity_id,
        al.details, al.shop_id, al.created_at,
        u.name as joined_user_name,
        s.name as shop_name
      FROM activity_logs al
      LEFT JOIN "user" u ON u.id::text = al.user_id::text
      LEFT JOIN shops s ON s.id::text = al.shop_id::text
      WHERE al.shop_id::text = ANY($1)
      ORDER BY al.created_at DESC
      LIMIT 50
    `, [targetShopIds]);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const users = usersResult.rows.map((row: any) => {
      const lastActivity = row.last_activity_at || row.last_login_at;
      const daysSinceActivity = lastActivity 
        ? Math.floor((now.getTime() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        id: row.id,
        name: row.name || row.email,
        email: row.email,
        role: row.role,
        shopId: row.shop_id,
        shopName: row.shop_name,
        isActive: row.is_active,
        lastLogin: row.last_login_at,
        lastActivity: lastActivity,
        lastAction: row.last_action,
        daysSinceActivity,
        activityCount30d: parseInt(row.activity_count_30d) || 0,
        salesCount30d: parseInt(row.sales_count_30d) || 0,
        revenue30d: parseFloat(row.revenue_30d) || 0,
        status: !lastActivity ? 'never' 
          : lastActivity >= todayStart ? 'active_today'
          : lastActivity >= weekAgo ? 'active_week'
          : daysSinceActivity && daysSinceActivity <= 30 ? 'active_month'
          : 'inactive',
      };
    });

    const recentActivity = recentActivityResult.rows.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.joined_user_name || row.user_name || 'Unknown',
      userEmail: row.joined_user_email || row.user_email || '',
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      shopId: row.shop_id,
      shopName: row.shop_name,
      createdAt: row.created_at,
    }));

    const summary = {
      totalUsers: users.length,
      activeToday: users.filter(u => u.status === 'active_today').length,
      activeThisWeek: users.filter(u => u.status === 'active_week' || u.status === 'active_today').length,
      activeThisMonth: users.filter(u => u.status !== 'never' && u.status !== 'inactive').length,
      inactive: users.filter(u => u.status === 'inactive' || u.status === 'never').length,
    };

    return c.json({ success: true, data: { users, recentActivity, summary } });
  } catch (error: any) {
    console.error('[UserActivity] Error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Shop-specific AI Advisor
app.post('/api/ai-advisor/shop', authMiddleware, async (c: any) => {
  try {
    const userShopIds = c.get('shopIds') as string[];
    const { shopId, question } = await c.req.json();

    if (!shopId || !userShopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }

    // Gather shop data
    const [shopRes, statsRes, lowStockRes, topProductsRes, todaySalesRes] = await Promise.all([
      pool.query('SELECT name, code, phone, email FROM shops WHERE id = $1', [shopId]),
      pool.query(`SELECT 
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = $1 AND created_at >= CURRENT_DATE) as today_sales,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = $1) as total_revenue,
        (SELECT COUNT(*) FROM products WHERE shop_id = $1) as total_products,
        (SELECT COALESCE(SUM(current_stock * buying_price), 0) FROM products WHERE shop_id = $1) as stock_value,
        (SELECT COALESCE(SUM(total_amount - amount_paid), 0) FROM sales WHERE shop_id = $1 AND payment_method = 'debt') as total_debt,
        (SELECT COUNT(*) FROM products WHERE shop_id = $1 AND current_stock <= COALESCE(low_stock_threshold, 10)) as low_stock_count
      `, [shopId]),
      pool.query('SELECT name, current_stock, low_stock_threshold FROM products WHERE shop_id = $1 AND current_stock <= COALESCE(low_stock_threshold, 10) ORDER BY current_stock ASC LIMIT 5', [shopId]),
      pool.query(`SELECT p.name, SUM(si.quantity) as qty_sold, SUM(si.total_price) as revenue
        FROM sale_items si JOIN sales s ON si.sale_id = s.id JOIN products p ON si.product_id = p.id
        WHERE s.shop_id = $1 AND s.created_at >= CURRENT_DATE
        GROUP BY p.name ORDER BY qty_sold DESC LIMIT 5`, [shopId]),
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
        FROM sales WHERE shop_id = $1 AND created_at >= CURRENT_DATE`, [shopId]),
    ]);

    const shop = shopRes.rows[0];
    const data = statsRes.rows[0];
    const lowStock = lowStockRes.rows;
    const topProducts = topProductsRes.rows;
    const todaySales = todaySalesRes.rows[0];

    const shopContext = `Shop: ${shop.name} (${shop.code})
Total Products: ${data.total_products}
Stock Value: TZS ${parseFloat(data.stock_value).toLocaleString()}
Total Revenue: TZS ${parseFloat(data.total_revenue).toLocaleString()}
Today's Sales: ${todaySales.count} orders, TZS ${parseFloat(todaySales.total).toLocaleString()}
Total Debt: TZS ${parseFloat(data.total_debt).toLocaleString()}
Low Stock Items: ${data.low_stock_count}
${lowStock.length > 0 ? 'Low Stock Products: ' + lowStock.map((p: any) => `${p.name} (${p.current_stock}/${p.low_stock_threshold})`).join(', ') : ''}
${topProducts.length > 0 ? 'Top Selling Today: ' + topProducts.map((p: any) => `${p.name} (${p.qty_sold} sold, TZS ${parseFloat(p.revenue).toLocaleString()})`).join(', ') : 'No sales today'}`;

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: true, data: { sections: [{ emoji: '💡', label: 'Setup Required', content: 'AI advisor requires DEEPSEEK_API_KEY to be configured.' }] } });
    }

    const prompt = question
      ? `The shop owner asks: "${question}"\n\nBased on this shop data, answer their question with practical advice:\n${shopContext}`
      : `Give concise actionable business advice for this shop owner based on their current data:\n${shopContext}\n\nFocus on: increasing daily income, reducing debt, managing stock, and improving sales.`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Wewe ni Msaidizi wa ALFEAN ENTERPRISES (Hardware Store System) Tanzania. Msaidie mmiliki wa duka.
Return ONLY valid JSON: {"sections":[{"emoji":"🔍","label":"Insight","content":"..."},{"emoji":"💡","label":"Advice","content":"..."},{"emoji":"📈","label":"Expected Outcome","content":"..."}]}
Be specific to the shop data provided. Use Swahili mixed with English. Keep under 150 words total.`
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 800,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      return c.json({ success: true, data: { sections: [{ emoji: '💡', label: 'Advice', content: 'AI temporarily unavailable. Try again.' }] } });
    }

    const result: any = await response.json();
    const content = result.choices?.[0]?.message?.content || '{}';
    let sections = [];
    try { sections = JSON.parse(content).sections || []; } catch { sections = [{ emoji: '💡', label: 'Advice', content }]; }

    return c.json({ success: true, data: { sections } });
  } catch (e: any) {
    console.error('[Shop AI Advisor] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Shop AI Advisor - follow-up questions with conversation history
app.post('/api/ai-advisor/shop/ask', authMiddleware, async (c: any) => {
  try {
    const userShopIds = c.get('shopIds') as string[];
    const { shopId, question, history } = await c.req.json();

    if (!shopId || !userShopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }

    if (!question || !question.trim()) {
      return c.json({ success: false, error: 'Question is required' }, 400);
    }

    // Gather minimal shop context for follow-up
    const [shopRes, statsRes] = await Promise.all([
      pool.query('SELECT name, code FROM shops WHERE id = $1', [shopId]),
      pool.query(`SELECT
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = $1 AND created_at >= CURRENT_DATE) as today_sales,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = $1) as total_revenue,
        (SELECT COUNT(*) FROM products WHERE shop_id = $1) as total_products,
        (SELECT COALESCE(SUM(current_stock * buying_price), 0) FROM products WHERE shop_id = $1) as stock_value,
        (SELECT COALESCE(SUM(total_amount - amount_paid), 0) FROM sales WHERE shop_id = $1 AND payment_method = 'debt') as total_debt,
        (SELECT COUNT(*) FROM products WHERE shop_id = $1 AND current_stock <= COALESCE(low_stock_threshold, 10)) as low_stock_count
      `, [shopId]),
    ]);

    const shop = shopRes.rows[0];
    const data = statsRes.rows[0];
    const shopContext = `Shop: ${shop.name} (${shop.code})
Products: ${data.total_products} | Stock Value: TZS ${parseFloat(data.stock_value).toLocaleString()}
Revenue: TZS ${parseFloat(data.total_revenue).toLocaleString()} | Today: TZS ${parseFloat(data.today_sales).toLocaleString()}
Debt: TZS ${parseFloat(data.total_debt).toLocaleString()} | Low Stock: ${data.low_stock_count}`;

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: true, data: { answer: 'AI advisor requires DEEPSEEK_API_KEY to be configured.' } });
    }

    const historyMessages = (history || []).slice(-6).map((m: any) => ({
      role: m.role,
      content: m.content
    }));

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          {
            role: 'system',
            content: `Wewe ni Msaidizi wa ALFEAN ENTERPRISES (Hardware Store System) Tanzania. Msaidie mmiliki wa duka kwa ushauri wa vitendo. Tumia Kiswahili sana. Rejea data halisi za duka.
Current shop context:\n${shopContext}`
          },
          ...historyMessages,
          { role: 'user', content: question }
        ],
        max_tokens: 600,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      return c.json({ success: true, data: { answer: 'AI temporarily unavailable. Please try again.' } });
    }

    const result: any = await response.json();
    const answer = result.choices?.[0]?.message?.content || 'Sorry, I could not process that.';

    return c.json({ success: true, data: { answer } });
  } catch (e: any) {
    console.error('[Shop AI Ask] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Daily shop report + AI chat with full context
app.post('/api/ai-advisor/daily-report', authMiddleware, async (c: any) => {
  try {
    const userShopIds = c.get('shopIds') as string[];
    const { shopId } = await c.req.json();

    if (!shopId || !userShopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toISOString().slice(0, 10);

    // Yesterday's snapshot changes rarely and costs 14 aggregate queries.
    // Cache it for 5 minutes so every dashboard visit is instant.
    const dailyReportCacheKey = `dailyreport:${shopId}:${yDate}`;
    const cachedDailyReport = cache.get<any>(dailyReportCacheKey);
    if (cachedDailyReport) {
      return c.json({ success: true, data: cachedDailyReport, fromCache: true });
    }

    const [shopRes, closingRes, salesRes, profitRes, lossRes, topRes, lowStockRes,
      paidRes, partialRes, unpaidRes, overdueRes, advanceRes, expensesRes, paymentsRes] = await Promise.all([
      pool.query('SELECT name, code FROM shops WHERE id = $1', [shopId]),

      // Last sale time yesterday
      pool.query(`SELECT created_at, total_amount FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day' ORDER BY created_at DESC LIMIT 1`, [shopId, yDate]),

      // Yesterday total sales & count
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day'`, [shopId, yDate]),

      // Yesterday profit from sale_items
      pool.query(`SELECT COALESCE(SUM(si.profit), 0) as profit FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE s.shop_id = $1 AND s.created_at >= $2::date AND s.created_at < $2::date + INTERVAL '1 day'`, [shopId, yDate]),

      // Products with loss (selling_price < buying_price)
      pool.query(`SELECT id, name, selling_price, buying_price, (selling_price - buying_price) as margin FROM products WHERE shop_id = $1 AND is_active = true AND selling_price < buying_price ORDER BY margin ASC LIMIT 10`, [shopId]),

      // Best selling product yesterday
      pool.query(`SELECT si.product_name, SUM(si.quantity) as qty, SUM(si.total_price) as revenue, SUM(si.profit) as gross_profit FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE s.shop_id = $1 AND s.created_at >= $2::date AND s.created_at < $2::date + INTERVAL '1 day' GROUP BY si.product_name ORDER BY qty DESC LIMIT 5`, [shopId, yDate]),

      // Low stock products
      pool.query(`SELECT id, name, current_stock, COALESCE(low_stock_threshold, 10) as min_level FROM products WHERE shop_id = $1 AND is_active = true AND current_stock <= COALESCE(low_stock_threshold, 10) ORDER BY current_stock ASC LIMIT 10`, [shopId]),

      // Fully paid yesterday (amount_paid >= total_amount)
      pool.query(`SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day' AND amount_paid >= total_amount`, [shopId, yDate]),

      // Partially paid yesterday (amount_paid > 0 AND < total_amount)
      pool.query(`SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day' AND amount_paid > 0 AND amount_paid < total_amount`, [shopId, yDate]),

      // Unpaid yesterday (amount_paid = 0)
      pool.query(`SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day' AND amount_paid = 0`, [shopId, yDate]),

      // Overdue (past due_date, not fully paid)
      pool.query(`SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day' AND due_date IS NOT NULL AND due_date < CURRENT_DATE AND amount_paid < total_amount`, [shopId, yDate]),

      // Advanced/prepaid (amount_paid > total_amount i.e. overpayment)
      pool.query(`SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day' AND amount_paid > total_amount`, [shopId, yDate]),

      // Yesterday's expenses
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM expenses WHERE shop_id = $1 AND date = $2`, [shopId, yDate]),

      // Yesterday's sales list for snapshot
      pool.query(`SELECT id, total_amount, amount_paid, payment_method, customer_name, created_at, COALESCE(payment_status, 'pending') as payment_status FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day' ORDER BY created_at DESC`, [shopId, yDate]),
    ]);

    const shop = shopRes.rows[0];
    const closing = closingRes.rows[0];
    const sales = salesRes.rows[0];
    const profit = profitRes.rows[0];
    const lossProducts = lossRes.rows;
    const topProducts = topRes.rows;
    const lowStock = lowStockRes.rows;
    const fullyPaid = parseInt(paidRes.rows[0]?.count || '0');
    const partiallyPaid = parseInt(partialRes.rows[0]?.count || '0');
    const unpaid = parseInt(unpaidRes.rows[0]?.count || '0');
    const overdue = parseInt(overdueRes.rows[0]?.count || '0');
    const advancePayments = parseInt(advanceRes.rows[0]?.count || '0');
    const expenses = expensesRes.rows[0];
    const yesterdaySales = paymentsRes.rows;

    const dailyReportData: any = {
      shopName: shop?.name || 'Unknown',
      shopCode: shop?.code || '',
      reportDate: yDate,
      closingTime: closing?.created_at || null,
      lastSaleAmount: closing?.total_amount || '0',
      totalSales: sales?.total || '0',
      totalOrders: parseInt(sales?.count || '0'),
      totalProfit: profit?.profit || '0',
      lossProducts: lossProducts.map((p: any) => ({
        id: p.id, name: p.name, sellingPrice: p.selling_price,
        buyingPrice: p.buying_price, margin: p.margin
      })),
      topProducts: topProducts.map((p: any) => ({
        name: p.product_name, quantity: p.qty, revenue: p.revenue, profit: p.gross_profit
      })),
      lowStock: lowStock.map((p: any) => ({
        id: p.id, name: p.name, stock: p.current_stock, minLevel: p.min_level
      })),
      salesBreakdown: { fullyPaid, partiallyPaid, unpaid, overdue, advancePayments },
      expenses: { count: parseInt(expenses?.count || '0'), total: expenses?.total || '0' },
      yesterdaySales: yesterdaySales.map((s: any) => ({
        id: s.id, totalAmount: s.total_amount, amountPaid: s.amount_paid,
        paymentMethod: s.payment_method, customerName: s.customer_name,
        createdAt: s.created_at, paymentStatus: s.payment_status
      }))
    };

    cache.set(dailyReportCacheKey, dailyReportData, 300);

    return c.json({
      success: true,
      data: dailyReportData
    });
  } catch (e: any) {
    console.error('[Daily Report] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// 24h shop snapshot for dashboard AI card
app.post('/api/ai-advisor/snapshot', authMiddleware, async (c: any) => {
  try {
    const userShopIds = c.get('shopIds') as string[];
    const { shopId } = await c.req.json();

    if (!shopId || !userShopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }

    const [statsRes, expensesRes, invoicesRes, adviceRes] = await Promise.all([
      pool.query(`SELECT
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = $1 AND created_at >= NOW() - INTERVAL '24 hours') as sales_24h,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND created_at >= NOW() - INTERVAL '24 hours') as orders_24h,
        (SELECT COALESCE(SUM(si.profit), 0) FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE s.shop_id = $1 AND s.created_at >= NOW() - INTERVAL '24 hours') as profit_24h,
        (SELECT COALESCE(SUM(total_amount - amount_paid), 0) FROM sales WHERE shop_id = $1 AND payment_method = 'debt') as total_debt,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND amount_paid >= total_amount) as fully_paid,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND amount_paid > 0 AND amount_paid < total_amount) as partial_paid,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND amount_paid = 0) as unpaid,
        (SELECT COUNT(*) FROM products WHERE shop_id = $1 AND is_active = true AND current_stock <= COALESCE(low_stock_threshold, 10)) as low_stock_count
      `, [shopId]),
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM expenses WHERE shop_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`, [shopId]),
      pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN amount_paid >= total_amount THEN 1 ELSE 0 END), 0) as paid_count FROM sales WHERE shop_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`, [shopId]),
      pool.query(`SELECT name, current_stock, COALESCE(low_stock_threshold, 10) as min_level FROM products WHERE shop_id = $1 AND is_active = true AND current_stock <= COALESCE(low_stock_threshold, 10) ORDER BY current_stock ASC LIMIT 3`, [shopId]),
    ]);

    const stats = statsRes.rows[0];
    const expenses = expensesRes.rows[0];
    const invoices = invoicesRes.rows[0];
    const lowStock = adviceRes.rows;

    const sales = parseFloat(stats.sales_24h);
    const profit = parseFloat(stats.profit_24h);
    const debt = parseFloat(stats.total_debt);
    const expenseTotal = parseFloat(expenses.total);

    let advice = '';
    if (sales === 0 && profit === 0) {
      advice = 'Hakuna mauzo kwa saa 24 zilizopita. Jaribu kutangaza bidhaa zako au angalia kama duka lako liko wazi.';
    } else if (lowStock.length > 0) {
      advice = `Una bidhaa ${lowStock.length} zenye stock chache. Jaza haraka ili usikose mauzo — hasa ${lowStock[0].name}.`;
    } else if (debt > sales * 0.5) {
      advice = 'Madeni yako yanazidi 50% ya mauzo ya saa 24. Fuata wadeni ili kuboresha mtiririko wa fedha.';
    } else if (profit < sales * 0.1) {
      advice = `Faida yako (${((profit / sales) * 100).toFixed(1)}%) iko chini ya 10%. Pitia bei za bidhaa zenye faida ndogo.`;
    } else {
      advice = `Hongera! ${sales > 0 ? `Mauzo ya TZS ${sales.toLocaleString()} kwa oda ${stats.orders_24h}. ` : ''}Endelea hivyo!`;
    }

    return c.json({
      success: true,
      data: {
        sales24h: stats.sales_24h,
        orders24h: parseInt(stats.orders_24h),
        profit24h: stats.profit_24h,
        totalDebt: stats.total_debt,
        expenses24h: expenses.total,
        expensesCount: parseInt(expenses.count),
        invoices: { total: parseInt(invoices.total), paid: parseInt(invoices.paid_count) },
        fullyPaid: parseInt(stats.fully_paid),
        partialPaid: parseInt(stats.partial_paid),
        unpaid: parseInt(stats.unpaid),
        lowStock: lowStock.map((p: any) => ({ name: p.name, stock: p.current_stock, min: p.min_level })),
        advice
      }
    });
  } catch (e: any) {
    console.error('[Snapshot] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// AI Chat with full shop context
async function executeAiSale(shopId: string, parsed: any, sellerId: string) {
  if (!parsed.items || parsed.items.length === 0) {
    return { success: false, error: 'No products identified' };
  }

  const productsRes = await pool.query(
    `SELECT id, name, buying_price, selling_price, current_stock, unit_type
     FROM products WHERE shop_id = $1 AND is_active = true`,
    [shopId]
  );
  const allProducts = productsRes.rows;

  const saleItems: any[] = [];
  const unmatched: string[] = [];

  for (const item of parsed.items) {
    const rawName = (item.productName || '').trim();
    if (!rawName) continue;
    const name = rawName.toLowerCase();

    let product: any = null;
    const exactRes = await pool.query(
      `SELECT id, name, buying_price, selling_price, current_stock, unit_type
       FROM products WHERE shop_id = $1 AND is_active = true AND LOWER(name) = $2 LIMIT 1`,
      [shopId, name]
    );
    if (exactRes.rows.length > 0) {
      product = exactRes.rows[0];
    } else {
      const ilikeRes = await pool.query(
        `SELECT id, name, buying_price, selling_price, current_stock, unit_type
         FROM products WHERE shop_id = $1 AND is_active = true AND name ILIKE $2 LIMIT 1`,
        [shopId, `%${name}%`]
      );
      if (ilikeRes.rows.length > 0) {
        product = ilikeRes.rows[0];
      }
    }

    if (product) {
      const sellingPrice = parseFloat(product.selling_price);
      saleItems.push({
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice > 0 ? item.unitPrice : sellingPrice,
        unitType: product.unit_type || 'PCS',
        totalPrice: (item.unitPrice > 0 ? item.unitPrice : sellingPrice) * item.quantity,
        discount: 0,
      });
    } else {
      unmatched.push(rawName);
    }
  }

  if (saleItems.length === 0) {
    return { success: false, error: 'No matching products found', unmatched };
  }

  const paymentMethod = parsed.paymentMethod || 'cash';
  const totalAmount = saleItems.reduce((sum: number, i: any) => sum + i.totalPrice, 0);
  const amountPaid = paymentMethod === 'debt' ? 0 : (parsed.amountPaid > 0 ? parsed.amountPaid : totalAmount);

  const saleData = {
    shopId,
    items: saleItems,
    paymentMethod,
    amountPaid,
    discountAmount: 0,
    customerName: parsed.customerName || undefined,
    customerPhone: undefined,
    customerEmail: undefined,
    notes: parsed.notes || undefined,
    bankName: undefined,
    source: 'chat' as const,
  };

  const result = await saleService.create(saleData, sellerId);
  return { success: true, data: { sale: result.sale, saleItems, totalAmount, amountPaid, paymentMethod, customerName: parsed.customerName, unmatched } };
}

app.post('/api/ai-advisor/chat', authMiddleware, async (c: any) => {
  try {
    const userShopIds = c.get('shopIds') as string[];
    const { shopId, question, history } = await c.req.json();

    if (!shopId || !userShopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }
    if (!question || !question.trim()) {
      return c.json({ success: false, error: 'Question is required' }, 400);
    }

    // Gather comprehensive shop data for AI context
    const today = new Date().toISOString().slice(0, 10);
    const [shopRes, statsRes, lowStockRes, topProductsRes, todaySalesRes,
      debtsRes, expensesRes, preordersRes, productsRes] = await Promise.all([
      pool.query('SELECT name, code, phone, email, created_at FROM shops WHERE id = $1', [shopId]),

      pool.query(`SELECT
        (SELECT COUNT(*) FROM products WHERE shop_id = $1 AND is_active = true) as total_products,
        (SELECT COALESCE(SUM(current_stock * buying_price), 0) FROM products WHERE shop_id = $1 AND is_active = true) as stock_value,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = $1) as lifetime_revenue,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day') as today_sales,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day') as today_orders,
        (SELECT COALESCE(SUM(si.profit), 0) FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE s.shop_id = $1 AND s.created_at >= $2::date AND s.created_at < $2::date + INTERVAL '1 day') as today_profit,
        (SELECT COALESCE(SUM(total_amount - amount_paid), 0) FROM sales WHERE shop_id = $1 AND payment_method = 'debt') as total_debt,
        (SELECT COALESCE(SUM(total_amount - amount_paid), 0) FROM sales WHERE shop_id = $1 AND payment_method = 'debt' AND amount_paid < total_amount AND due_date IS NOT NULL AND due_date < CURRENT_DATE) as overdue_debt,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND amount_paid >= total_amount) as fully_paid_sales,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND amount_paid > 0 AND amount_paid < total_amount) as partial_sales,
        (SELECT COUNT(*) FROM sales WHERE shop_id = $1 AND amount_paid = 0) as unpaid_sales,
        (SELECT COUNT(*) FROM products WHERE shop_id = $1 AND is_active = true AND current_stock <= COALESCE(low_stock_threshold, 10)) as low_stock_count
      `, [shopId, today]),

      pool.query(`SELECT name, current_stock, COALESCE(low_stock_threshold, 10) as min_level
        FROM products WHERE shop_id = $1 AND is_active = true AND current_stock <= COALESCE(low_stock_threshold, 10) ORDER BY current_stock ASC LIMIT 10`, [shopId]),

      pool.query(`SELECT p.name, SUM(si.quantity) as qty_sold, SUM(si.total_price) as revenue, SUM(si.profit) as profit
        FROM sale_items si JOIN sales s ON si.sale_id = s.id JOIN products p ON si.product_id = p.id
        WHERE s.shop_id = $1 AND s.created_at >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY p.name ORDER BY qty_sold DESC LIMIT 10`, [shopId]),

      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
        FROM sales WHERE shop_id = $1 AND created_at >= $2::date AND created_at < $2::date + INTERVAL '1 day'`, [shopId, today]),

      // Debtors summary
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount - paid_amount), 0) as remaining
        FROM debtors WHERE shop_id = $1 AND status IN ('unpaid', 'partial')`, [shopId]),

      // Today's expenses
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
        FROM expenses WHERE shop_id = $1 AND date = $2`, [shopId, today]),

      // Active pre-orders
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount - paid_amount), 0) as remaining
        FROM pre_orders WHERE shop_id = $1 AND status NOT IN ('completed', 'cancelled')`, [shopId]),

      // Products for sale matching
      pool.query(`SELECT id, name, buying_price, selling_price, current_stock, unit_type
       FROM products WHERE shop_id = $1 AND is_active = true`, [shopId]),
    ]);

    const shop = shopRes.rows[0];
    const data = statsRes.rows[0];
    const lowStock = lowStockRes.rows;
    const topProducts = topProductsRes.rows;
    const debts = debtsRes.rows[0];
    const expenses2 = expensesRes.rows[0];
    const preorders = preordersRes.rows[0];
    const allProducts = productsRes.rows;

    const productList = allProducts.map((p: any) => `  - ${p.name} (stock: ${p.current_stock}, bei: TZS ${parseFloat(p.selling_price).toLocaleString()})`).join('\n');

    const shopContext = `SHOP PROFILE
Name: ${shop?.name || 'Unknown'} | Code: ${shop?.code || ''} | Phone: ${shop?.phone || '-'} | Email: ${shop?.email || '-'}

INVENTORY
Total Products: ${data.total_products}
Stock Value: TZS ${parseFloat(data.stock_value).toLocaleString()}
Low Stock Items: ${data.low_stock_count}
${lowStock.length > 0 ? 'Low Stock Products:\n' + lowStock.map((p: any) => `  - ${p.name}: ${p.current_stock} (min ${p.min_level})`).join('\n') : '  No low stock items'}

SALES
Lifetime Revenue: TZS ${parseFloat(data.lifetime_revenue).toLocaleString()}
Today's Orders: ${data.today_orders} | Today's Sales Total: TZS ${parseFloat(data.today_sales).toLocaleString()}
Today's Profit: TZS ${parseFloat(data.today_profit).toLocaleString()}
Fully Paid Sales: ${data.fully_paid_sales}
Partially Paid: ${data.partial_sales}
Unpaid Sales: ${data.unpaid_sales}
Total Outstanding Debt: TZS ${parseFloat(data.total_debt).toLocaleString()}
Overdue Debt: TZS ${parseFloat(data.overdue_debt).toLocaleString()}

TOP SELLING PRODUCTS (Last 7 days):
${topProducts.length > 0 ? topProducts.map((p: any) => `  - ${p.name}: ${p.qty_sold} sold, TZS ${parseFloat(p.revenue).toLocaleString()} revenue, TZS ${parseFloat(p.profit).toLocaleString()} profit`).join('\n') : '  No sales data'}

DEBTORS
Active Debtors: ${debts.count} | Remaining Balance: TZS ${parseFloat(debts.remaining).toLocaleString()}

EXPENSES (Today)
Count: ${expenses2.count} | Total: TZS ${parseFloat(expenses2.total).toLocaleString()}

PRE-ORDERS
Active: ${preorders.count} | Outstanding Amount: TZS ${parseFloat(preorders.remaining).toLocaleString()}

PRODUCTS IN THIS SHOP:
${productList}`;

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: true, data: { answer: 'AI advisor requires DEEPSEEK_API_KEY to be configured.' } });
    }

    const historyMessages = (history || []).slice(-10).map((m: any) => ({
      role: m.role, content: m.content
    }));

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Wewe ni Msaidizi wa ALFEAN ENTERPRISES (Hardware Store System) Tanzania. Una uwezo wa kujibu maswali NA kutengeneza mauzo moja kwa moja.

UNAWEZA KUFANYA MAUZO: Mtumiaji anaweza kukuambia ameuza bidhaa, na wewe UTATENGENEZA mauzo hayo kwenye mfumo. Huhitaji ruhusa yoyote ya ziada — weka tu mauzo moja kwa moja.

Rudisha JSON pekee:
KAMA ni swali la kawaida (auza, stock, nk):
{
  "type": "chat",
  "answer": "jibu lako kwa Kiswahili"
}

KAMA mtumiaji anauza au ameuza bidhaa:
{
  "type": "sale",
  "items": [
    {
      "productName": "jina la bidhaa kutoka kwenye orodha",
      "quantity": namba,
      "unitPrice": 0 (tumia bei kutoka kwenye stock)
    }
  ],
  "customerName": "jina la mteja au null",
  "paymentMethod": "cash" | "debt" | "lipa_namba" | "bank",
  "amountPaid": namba (kwa cash, jumla ya bei. Kwa deni, 0),
  "notes": "maelezo au null"
}

CURRENT SHOP DATA:
${shopContext}

MWONGOZO WA MAUZO:
- DEFAULT: Ikiwa mtumiaji hakutaja njia ya malipo, tumia "cash". DEFAULT NI CASH.
- Ikiwa mteja hatajwa, weka customerName = null (mauzo ya kawaida)
- Ikiwa mteja anatajwa, andika jina lake kwenye customerName (ataundwa moja kwa moja)
- "ame lipia cash" → paymentMethod = "cash" na amountPaid = jumla
- "deni" → paymentMethod = "debt" na amountPaid = 0
- Tafuta bidhaa kwenye orodha ya PRODUCTS. Ikiwa haipo, weka productName kama ilivyotajwa.`
          },
          ...historyMessages,
          { role: 'user', content: question }
        ],
        max_tokens: 1000,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      return c.json({ success: true, data: { answer: 'AI temporarily unavailable. Please try again.' } });
    }

    const result: any = await response.json();
    const content = result.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return c.json({ success: true, data: { answer: 'Samahani, sikuelewa. Tafadhali uliza swali au sema unachotaka kuuza.' } });
    }

    // Handle sale action
    if (parsed.type === 'sale') {
      const sellerId = c.get('userId') || 'system';
      const saleResult = await executeAiSale(shopId, parsed, sellerId);

      if (!saleResult.success) {
        return c.json({
          success: true,
          data: {
            answer: `Samahani, siwezi kutengeneza mauzo hayo. ${saleResult.error}. Tafadhali angalia majina ya bidhaa au unda mauzo manually.`
          }
        });
      }

      const d = saleResult.data as any;
      const itemsStr = d.saleItems.map((i: any) => `  • ${i.productName} × ${i.quantity} = TSh ${Number(i.totalPrice).toLocaleString()}`).join('\n');
      const customerStr = d.customerName ? `\nMteja: ${d.customerName}` : '';
      const unmatchedStr = d.unmatched?.length > 0 ? `\n\nHazikutambulika: ${d.unmatched.join(', ')}` : '';

      return c.json({
        success: true,
        data: {
          answer: `✓ Mauzo yamefanyika!\n\n${itemsStr}\nJumla: TSh ${Number(d.totalAmount).toLocaleString()}\nMalipo: ${d.paymentMethod}${customerStr}${unmatchedStr}`,
          saleData: {
            saleId: d.sale?.id,
            totalAmount: d.totalAmount,
            totalItems: d.saleItems.length,
            items: d.saleItems,
            paymentMethod: d.paymentMethod,
            customerName: d.customerName,
            profit: (d.sale?.items as any[])?.reduce((sum: number, si: any) => sum + (si.profit || 0), 0) || 0,
          }
        }
      });
    }

    // Normal chat response
    return c.json({ success: true, data: { answer: parsed.answer || 'Samahani, sikuelewa. Tafadhali uliza swali au sema unachotaka kuuza.' } });
  } catch (e: any) {
    console.error('[AI Chat] Error:', e.message);
    console.error('[AI Chat] Stack:', e.stack);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// AI Sale — natural language Swahili sale via chat
app.post('/api/ai-advisor/ai-sale', authMiddleware, async (c: any) => {
  try {
    const userShopIds = c.get('shopIds') as string[];
    const { shopId, message } = await c.req.json();

    if (!shopId || !userShopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }
    if (!message || typeof message !== 'string' || message.trim().length < 3) {
      return c.json({ success: false, error: 'Message too short' }, 400);
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: false, error: 'DEEPSEEK_API_KEY not configured' }, 500);
    }

    // Build product name list for AI context
    const productsRes = await pool.query(
      `SELECT id, name, buying_price, selling_price, current_stock, unit_type
       FROM products WHERE shop_id = $1 AND is_active = true`,
      [shopId]
    );
    const allProducts = productsRes.rows;
    const productNames = allProducts.map((p: any) => p.name).join('\n');

    // Step 1: AI parses the Swahili message into structured sale data
    const parseResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Wewe ni msaidizi wa POS anayetengeneza mauzo kutoka kwa maelezo ya mfanyabiashara kwa Kiswahili.

Products in this shop:
${productNames}

Return ONLY valid JSON:
{
  "items": [
    {
      "productName": "jina la bidhaa kama ilivyotajwa",
      "quantity": namba,
      "unitPrice": namba (bei kwa kila kitengo. 0 ikiwa haikutajwa. Tumia 0 kama haukutaja bei)
    }
  ],
  "customerName": "jina la mteja au null",
  "customerPhone": "namba ya simu ya mteja (kwa mfano 0712345678) ikiwa imetajwa, au null",
  "paymentMethod": "cash" | "debt" | "lipa_namba" | "bank",
  "amountPaid": namba (kiasi kilicholipwa. Kwa cash, jumla ya bei ya bidhaa. Kwa deni/debt, weka 0),
  "notes": "maelezo ya ziada au null"
}

MIONGOZO:
- DEFAULT: Ikiwa mtumiaji hakutaja njia ya malipo, tumia "cash". DEFAULT NI CASH.
- Tafuta bidhaa kwenye orodha iliyotolewa. Ikiwa bidhaa haipo, weka productName kama ilivyotajwa.
- "mifuko X" → quantity = X
- "kwa shilingi X" → unitPrice = X
- "kila moja" → unitPrice ni kwa kila kitengo
- "amelipia cash/deni" → paymentMethod = "cash"/"debt"
- "M-Pesa/lipa namba" → paymentMethod = "lipa_namba"
- Kama ni cash na amountPaid haikutajwa, weka amountPaid = bei ya bidhaa × quantity
- Kama ni deni/debt, amountPaid = 0`
          },
          { role: 'user', content: message }
        ],
        max_tokens: 1000,
        temperature: 0.1
      })
    });

    if (!parseResponse.ok) {
      return c.json({ success: false, error: 'AI parsing failed' }, 502);
    }

    const parseResult: any = await parseResponse.json();
    const parsedContent = parseResult.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(parsedContent);
    } catch {
      return c.json({ success: false, error: 'AI returned invalid JSON' }, 502);
    }

    if (!parsed.items || parsed.items.length === 0) {
      return c.json({ success: false, error: 'AI could not identify any products in your message' }, 400);
    }

    // Step 2: Match product names to actual products in DB
    const saleItems: any[] = [];
    const unmatched: string[] = [];

    for (const item of parsed.items) {
      const rawName = (item.productName || '').trim();
      if (!rawName) continue;
      const name = rawName.toLowerCase();

      // Try exact match first, then ILIKE
      let product: any = null;

      const exactRes = await pool.query(
        `SELECT id, name, buying_price, selling_price, current_stock, unit_type
         FROM products WHERE shop_id = $1 AND is_active = true AND LOWER(name) = $2 LIMIT 1`,
        [shopId, name]
      );
      if (exactRes.rows.length > 0) {
        product = exactRes.rows[0];
      } else {
        const ilikeRes = await pool.query(
          `SELECT id, name, buying_price, selling_price, current_stock, unit_type
           FROM products WHERE shop_id = $1 AND is_active = true AND name ILIKE $2 LIMIT 1`,
          [shopId, `%${name}%`]
        );
        if (ilikeRes.rows.length > 0) {
          product = ilikeRes.rows[0];
        }
      }

      if (product) {
        const sellingPrice = parseFloat(product.selling_price);
        const unitPrice = item.unitPrice > 0 ? item.unitPrice : sellingPrice;

        saleItems.push({
          productId: product.id,
          productName: product.name,
          quantity: item.quantity,
          unitPrice,
          unitType: product.unit_type || 'PCS',
          totalPrice: unitPrice * item.quantity,
          discount: 0,
        });
      } else {
        unmatched.push(rawName);
      }
    }

    if (saleItems.length === 0) {
      return c.json({
        success: false,
        error: 'No products found matching the names mentioned',
        unmatched
      }, 404);
    }

    // Step 3: Create the sale
    const sellerId = c.get('userId') || 'system';
    const paymentMethod = parsed.paymentMethod || 'cash';
    const totalAmount = saleItems.reduce((sum: number, i: any) => sum + i.totalPrice, 0);
    const amountPaid = paymentMethod === 'debt' ? 0 : (parsed.amountPaid > 0 ? parsed.amountPaid : totalAmount);

    const saleData = {
      shopId,
      items: saleItems,
      paymentMethod,
      amountPaid,
      discountAmount: 0,
      customerName: parsed.customerName || undefined,
      customerPhone: parsed.customerPhone || undefined,
      customerEmail: undefined,
      notes: parsed.notes || `AI sale: ${message.substring(0, 200)}`,
      bankName: undefined,
      source: 'chat' as const,
    };

    const result = await saleService.create(saleData, sellerId);

    // Auto SMS to the customer (receipt) if the AI captured a phone number
    if (result.sale?.id && parsed.customerPhone) {
      handleAutoSmsOnSale({
        shopId,
        customerPhone: parsed.customerPhone,
        customerName: parsed.customerName,
        totalAmount: totalAmount,
        items: saleItems.map((i: any) => ({
          name: i.productName,
          quantity: i.quantity,
          totalPrice: i.totalPrice,
        })),
      }).catch(() => {});
    }

    // Auto SMS to the shop owner (per-sale notice) if enabled
    if (result.sale?.id) {
      handleAdminSaleSmsOnSale({
        shopId,
        totalAmount,
        customerName: parsed.customerName,
        items: saleItems.map((i: any) => ({
          name: i.productName,
          quantity: i.quantity,
          totalPrice: i.totalPrice,
        })),
      }).catch(() => {});
    }

    return c.json({
      success: true,
      data: {
        sale: result.sale,
        items: saleItems.map((i: any) => ({
          name: i.productName,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          totalPrice: i.totalPrice,
        })),
        summary: {
          totalItems: saleItems.length,
          totalAmount,
          amountPaid,
          paymentMethod,
          customerName: parsed.customerName || null,
          profit: result.sale.items?.reduce((sum: number, si: any) => sum + (si.profit || 0), 0) || 0,
        },
        unmatched,
      }
    });
  } catch (e: any) {
    console.error('[AI Sale] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Reports endpoint
app.get('/api/reports', authMiddleware, async (c: any) => {
  const shopIds = c.get('shopIds') as string[];
  const userRole = c.get('userRole') as string;
  
  console.log('[Reports] shopIds:', shopIds, 'userRole:', userRole);
  
  if (!shopIds || shopIds.length === 0) {
    console.log('[Reports] No shops - returning empty data');
    return c.json({ 
      success: true, 
      data: {
        summary: { totalOrders: 0, totalRevenue: 0, totalSellers: 0, totalShops: 0 },
        salesOverTime: [],
        topProducts: [],
        paymentMethods: [],
        comparison: null,
        shopStats: []
      }
    });
  }

  try {
    let startDate = c.req.query('startDate');
    let endDate = c.req.query('endDate');
    
    if (!startDate || !endDate) {
      const today = new Date();
      startDate = today.toISOString().split('T')[0];
      endDate = today.toISOString().split('T')[0];
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return c.json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
    }

    const dateFilter = `AND s.created_at >= $2 AND s.created_at <= $3`;
    const dateParams = [shopIds, `${startDate} 00:00:00`, `${endDate} 23:59:59`];

    // Services (Huduma) income is merged into the sales report only when the
    // shop toggles "add services to sales" on.
    let addServicesToSales = false;
    try {
      const servicesSettingsRes = await pool.query(
        `SELECT value FROM settings WHERE key = 'services' AND shop_id = ANY($1)`,
        [shopIds]
      );
      for (const r of servicesSettingsRes.rows as any[]) {
        const value = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        if (value?.add_to_sales === true) { addServicesToSales = true; break; }
      }
    } catch (e: any) {
      console.log('Services settings check error:', e.message);
    }

    // Optional category filter: restrict to sales that contain at least one item
    // belonging to the selected product categories. The ids are validated to be
    // real UUIDs before being embedded, so this fragment is injection-safe.
    const rawCatIds = ((c.req.query('categoryIds') as string) || '').split(',').map((x) => x.trim()).filter(Boolean);
    const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const validCatIds = rawCatIds.filter((id) => UUID_RE.test(id));
    const saleCatFilter = validCatIds.length
      ? `AND s.id IN (SELECT si.sale_id FROM sale_items si JOIN products p ON si.product_id = p.id WHERE p.category_id IN (${validCatIds.map((id) => `'${id}'`).join(',')}))`
      : '';
    const itemCatFilter = validCatIds.length
      ? `AND p.category_id IN (${validCatIds.map((id) => `'${id}'`).join(',')})`
      : '';

    // Reports run ~8 heavy UNION aggregate queries. Cache the computed payload
    // per shop/date/category for 30s so switching tabs, presets and revisiting
    // the page is instant instead of re-scanning every sale. Sellers are never
    // cached because their payload is permission-scrubbed per user.
    const reportCacheKey = userRole !== 'seller'
      ? `reports:${[...shopIds].sort().join(',')}:${startDate}:${endDate}:${validCatIds.join(',')}:${addServicesToSales ? 'svc' : ''}`
      : null;
    if (reportCacheKey) {
      const cachedReport = cache.get<any>(reportCacheKey);
      if (cachedReport) {
        return c.json({ success: true, data: cachedReport, fromCache: true });
      }
    }

    const salesOverTimePromise = db.read(
      `SELECT date, SUM(orders) as orders, SUM(revenue) as revenue FROM (
         SELECT DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                COUNT(*) as orders,
                COALESCE(SUM(s.total_amount), 0) as revenue
         FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter} 
         ${dateFilter}
         AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         GROUP BY DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')
         UNION ALL
         SELECT DATE(ip.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                0 as orders,
                COALESCE(SUM(ip.amount), 0) as revenue
          FROM invoice_payments ip
          JOIN sales s ON ip.sale_id = s.id
          WHERE s.shop_id = ANY($1) ${saleCatFilter}
          AND ip.created_at >= $2 AND ip.created_at <= $3
          AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank')
          AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
          GROUP BY DATE(ip.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')
          UNION ALL
          SELECT DATE(dp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                 0 as orders,
                 COALESCE(SUM(dp.amount), 0) as revenue
          FROM debt_payments dp
          JOIN debtors d ON dp.debtor_id = d.id
          WHERE d.shop_id = ANY($1)
          AND dp.created_at >= $2 AND dp.created_at <= $3
          GROUP BY DATE(dp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')
          UNION ALL
          SELECT DATE(pp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                 0 as orders,
                 COALESCE(SUM(pp.amount), 0) as revenue
          FROM pre_order_payments pp
          JOIN pre_orders po ON pp.pre_order_id = po.id
          WHERE po.shop_id = ANY($1)
          AND pp.created_at >= $2 AND pp.created_at <= $3
          GROUP BY DATE(pp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')
          UNION ALL
          SELECT DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                 COUNT(*) as orders,
                 0 as revenue
          FROM sales s
          WHERE s.shop_id = ANY($1) ${saleCatFilter}
          AND s.created_at >= $2 AND s.created_at <= $3
          AND s.payment_method = 'debt'
          GROUP BY DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')
          UNION ALL
          SELECT DATE(po.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                 COUNT(*) as orders,
                 0 as revenue
          FROM pre_orders po
          WHERE po.shop_id = ANY($1)
          AND po.created_at >= $2 AND po.created_at <= $3
          GROUP BY DATE(po.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')
          UNION ALL
          SELECT DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                 COUNT(*) as orders,
                 0 as revenue
          FROM sales s
          WHERE s.shop_id = ANY($1) ${saleCatFilter}
          AND s.created_at >= $2 AND s.created_at <= $3
          AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt')
          AND s.sale_type IS DISTINCT FROM 'pre_order'
          GROUP BY DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')
          ${addServicesToSales ? `
          UNION ALL
          SELECT DATE(sr.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as date,
                 0 as orders,
                 COALESCE(SUM(sr.total), 0) as revenue
          FROM service_records sr
          WHERE sr.shop_id = ANY($1)
          AND sr.created_at >= $2 AND sr.created_at <= $3
          GROUP BY DATE(sr.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')` : ''}
        ) combined
        GROUP BY date
        ORDER BY date`,
      dateParams
    );

    const topProductsPromise = db.read(
      `SELECT si.product_name as name,
              SUM(si.quantity) as total_quantity,
              SUM(si.total_price) as total_revenue,
              SUM(si.buying_price_at_sale * si.quantity) as total_cost,
              SUM(si.profit) as total_profit
       FROM sale_items si
       JOIN sales s ON si.sale_id = s.id
       ${validCatIds.length ? 'JOIN products p ON si.product_id = p.id' : ''}
       WHERE s.shop_id = ANY($1) ${saleCatFilter}
       ${validCatIds.length ? itemCatFilter : ''}
       ${dateFilter}
       GROUP BY si.product_name
       ORDER BY total_quantity DESC
       LIMIT 10`,
      dateParams
    );

    // Full profit analysis per product for the period: every product that sold,
    // with quantity, revenue, capital (cost) and profit, best profit first.
    // Powers the "Faida kwa Bidhaa" report section + PDF.
    const productProfitPromise = db.read(
      `SELECT si.product_id,
              MAX(si.product_name) as name,
              SUM(si.quantity) as total_quantity,
              SUM(si.total_price) as total_revenue,
              SUM(si.buying_price_at_sale * si.quantity) as total_cost,
              SUM(si.profit) as total_profit
       FROM sale_items si
       JOIN sales s ON si.sale_id = s.id
       ${validCatIds.length ? 'JOIN products p ON si.product_id = p.id' : ''}
       WHERE s.shop_id = ANY($1) ${saleCatFilter}
       ${validCatIds.length ? itemCatFilter : ''}
       ${dateFilter}
       GROUP BY si.product_id
       ORDER BY total_profit DESC NULLS LAST
       LIMIT 2000`,
      dateParams
    );

    // Products with stock but NO sale at all in the period ("dead stock") —
    // the other half of the analysis: what is tying up money without selling.
    const unsoldProductsPromise = db.read(
      `SELECT p.id, p.name, p.current_stock as stock, p.buying_price, p.selling_price,
              (p.current_stock * p.buying_price) as stock_value,
              (SELECT MAX(s2.created_at) FROM sale_items si2
                 JOIN sales s2 ON si2.sale_id = s2.id
                WHERE si2.product_id = p.id AND s2.shop_id = p.shop_id) as last_sold_at,
              COUNT(*) OVER() as total_count
       FROM products p
       WHERE p.shop_id = ANY($1) AND p.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM sale_items si
           JOIN sales s ON si.sale_id = s.id
           WHERE si.product_id = p.id AND s.shop_id = ANY($1)
             AND s.created_at >= $2 AND s.created_at <= $3
         )
       ORDER BY stock_value DESC NULLS LAST
       LIMIT 500`,
      dateParams
    );

    const paymentMethodPromise = db.read(
      `SELECT method, SUM(count) as count, SUM(total) as total FROM (
         SELECT s.payment_method as method, COUNT(*) as count, COALESCE(SUM(s.total_amount), 0) as total
         FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         ${dateFilter}
         AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         GROUP BY s.payment_method
         UNION ALL
         SELECT 'debt' as method, COUNT(*) as count, COALESCE(SUM(dp.amount), 0) as total
         FROM debt_payments dp
         JOIN debtors d ON dp.debtor_id = d.id
         WHERE d.shop_id = ANY($1)
         AND dp.created_at >= $2 AND dp.created_at <= $3
         GROUP BY method
         UNION ALL
         SELECT 'debt' as method, COUNT(*) as count, 0 as total
         FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= $2 AND s.created_at <= $3
         AND s.payment_method = 'debt'
         GROUP BY method
         UNION ALL
         SELECT 'invoice' as method, COUNT(*) as count, 0 as total
         FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= $2 AND s.created_at <= $3
         AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         GROUP BY method
         UNION ALL
         SELECT 'preorder' as method, COUNT(*) as count, 0 as total
         FROM pre_orders po
         WHERE po.shop_id = ANY($1)
         AND po.created_at >= $2 AND po.created_at <= $3
         GROUP BY method
         UNION ALL
         SELECT 'invoice' as method, 0 as count, COALESCE(SUM(ip.amount), 0) as total
         FROM invoice_payments ip
         JOIN sales s ON ip.sale_id = s.id
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND ip.created_at >= $2 AND ip.created_at <= $3
         AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank')
         AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
         UNION ALL
         SELECT 'preorder' as method, 0 as count, COALESCE(SUM(pp.amount), 0) as total
         FROM pre_order_payments pp
         JOIN pre_orders po ON pp.pre_order_id = po.id
         WHERE po.shop_id = ANY($1)
         AND pp.created_at >= $2 AND pp.created_at <= $3
         ${addServicesToSales ? `
         UNION ALL
         SELECT 'services' as method, COUNT(*) as count, COALESCE(SUM(sr.total), 0) as total
         FROM service_records sr
         WHERE sr.shop_id = ANY($1)
         AND sr.created_at >= $2 AND sr.created_at <= $3
         GROUP BY method` : ''}
       ) combined
       GROUP BY method`,
      dateParams
    );

    const thisWeekPromise = db.read(
      `SELECT COUNT(DISTINCT sale_id) as count, COALESCE(SUM(total), 0) as total FROM (
         SELECT s.id as sale_id, s.total_amount as total FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= DATE_TRUNC('week', NOW())
         AND s.created_at < DATE_TRUNC('week', NOW()) + INTERVAL '1 week'
         AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         UNION ALL
         SELECT s.id as sale_id, 0 as total FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= DATE_TRUNC('week', NOW())
         AND s.created_at < DATE_TRUNC('week', NOW()) + INTERVAL '1 week'
         AND s.payment_method = 'debt'
         UNION ALL
         SELECT s.id as sale_id, 0 as total FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= DATE_TRUNC('week', NOW())
         AND s.created_at < DATE_TRUNC('week', NOW()) + INTERVAL '1 week'
         AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         UNION ALL
         SELECT po.id as sale_id, 0 as total FROM pre_orders po
         WHERE po.shop_id = ANY($1)
         AND po.created_at >= DATE_TRUNC('week', NOW())
         AND po.created_at < DATE_TRUNC('week', NOW()) + INTERVAL '1 week'
       ) combined`,
      [shopIds]
    );

    const lastWeekPromise = db.read(
      `SELECT COUNT(DISTINCT sale_id) as count, COALESCE(SUM(total), 0) as total FROM (
         SELECT s.id as sale_id, s.total_amount as total FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
         AND s.created_at < DATE_TRUNC('week', NOW())
         AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         UNION ALL
         SELECT s.id as sale_id, 0 as total FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
         AND s.created_at < DATE_TRUNC('week', NOW())
         AND s.payment_method = 'debt'
         UNION ALL
         SELECT s.id as sale_id, 0 as total FROM sales s
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
         AND s.created_at < DATE_TRUNC('week', NOW())
         AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         UNION ALL
         SELECT po.id as sale_id, 0 as total FROM pre_orders po
         WHERE po.shop_id = ANY($1)
         AND po.created_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
         AND po.created_at < DATE_TRUNC('week', NOW())
       ) combined`,
       [shopIds]
    );

    // Pooled period figures: expenses (matumizi), debts (madeni) and net profit.
    const expensesTotalPromise = db.read(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses
       WHERE shop_id = ANY($1) AND date >= $2::date AND date <= $3::date`,
      dateParams
    );

    const debtsPeriodPromise = db.read(
      `SELECT COALESCE(SUM(total_amount), 0) as created,
              COALESCE(SUM(COALESCE(paid_amount, 0)), 0) as paid,
              COUNT(*) as count
       FROM debtors
       WHERE shop_id = ANY($1) AND created_at >= $2 AND created_at <= $3`,
      dateParams
    );

    const debtCollectedPromise = db.read(
      `SELECT COALESCE(SUM(dp.amount), 0) as total FROM debt_payments dp
       JOIN debtors d ON dp.debtor_id = d.id
       WHERE d.shop_id = ANY($1) AND dp.created_at >= $2 AND dp.created_at <= $3`,
      dateParams
    );

    const debtsOutstandingPromise = db.read(
      `SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)), 0) as total
       FROM debtors
       WHERE shop_id = ANY($1) AND COALESCE(status, 'unpaid') <> 'paid'`,
      [shopIds]
    );

    let [salesOverTimeResult, topProductsResult, productProfitResult, unsoldProductsResult, paymentMethodResult, thisWeekResult, lastWeekResult, expensesTotalResult, debtsPeriodResult, debtCollectedResult, debtsOutstandingResult] = await Promise.all([
      salesOverTimePromise,
      topProductsPromise,
      productProfitPromise,
      unsoldProductsPromise,
      paymentMethodPromise,
      thisWeekPromise,
      lastWeekPromise,
      expensesTotalPromise,
      debtsPeriodPromise,
      debtCollectedPromise,
      debtsOutstandingPromise,
    ]);

    let shopStats = [];
    if (userRole === 'admin' || userRole === 'owner' || userRole === 'developer') {
      // Every sub-query respects the selected date range so the shop table
      // always reconciles with the period summary above it.
      const shopsResult = await db.read(
      `SELECT s.id, s.name,
               (SELECT COUNT(DISTINCT sale_id) FROM (
                  SELECT s2.id as sale_id FROM sales s2 WHERE s2.shop_id = s.id AND s2.payment_method IN ('cash', 'lipa_namba', 'bank') AND s2.sale_type IS DISTINCT FROM 'pre_order' AND s2.created_at >= $2 AND s2.created_at <= $3
                  UNION ALL
                  SELECT s2.id as sale_id FROM sales s2 WHERE s2.shop_id = s.id AND s2.payment_method = 'debt' AND s2.created_at >= $2 AND s2.created_at <= $3
                  UNION ALL
                  SELECT po.id as sale_id FROM pre_orders po WHERE po.shop_id = s.id AND po.created_at >= $2 AND po.created_at <= $3
                  UNION ALL
                  SELECT s2.id as sale_id FROM sales s2 WHERE s2.shop_id = s.id AND s2.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt') AND s2.sale_type IS DISTINCT FROM 'pre_order' AND s2.created_at >= $2 AND s2.created_at <= $3
                ) combined
               ) as total_orders,
               (SELECT COALESCE(SUM(total), 0) FROM (
                  SELECT s2.total_amount as total FROM sales s2 WHERE s2.shop_id = s.id AND s2.payment_method IN ('cash', 'lipa_namba', 'bank') AND s2.sale_type IS DISTINCT FROM 'pre_order' AND s2.created_at >= $2 AND s2.created_at <= $3
                  UNION ALL
                  SELECT ip.amount as total FROM invoice_payments ip JOIN sales s2 ON ip.sale_id = s2.id WHERE s2.shop_id = s.id AND s2.payment_method NOT IN ('cash', 'lipa_namba', 'bank') AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s2.id) AND ip.created_at >= $2 AND ip.created_at <= $3
                  UNION ALL
                  SELECT dp.amount as total FROM debt_payments dp JOIN debtors d ON dp.debtor_id = d.id WHERE d.shop_id = s.id AND dp.created_at >= $2 AND dp.created_at <= $3
                  UNION ALL
                  SELECT pp.amount as total FROM pre_order_payments pp JOIN pre_orders po ON pp.pre_order_id = po.id WHERE po.shop_id = s.id AND pp.created_at >= $2 AND pp.created_at <= $3
                ) combined
               ) as total_revenue,
               (SELECT COUNT(*) FROM products WHERE shop_id = s.id AND is_active = true) as total_products,
               (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE e.shop_id = s.id AND e.date >= $2::date AND e.date <= $3::date) as total_expenses,
               (SELECT COALESCE(SUM(d2.total_amount - COALESCE(d2.paid_amount, 0)), 0) FROM debtors d2 WHERE d2.shop_id = s.id AND COALESCE(d2.status, 'unpaid') <> 'paid') as total_debts
         FROM shops s
         WHERE s.id = ANY($1)`,
        dateParams
      );
      shopStats = shopsResult.rows;
    }

    const usersResult = await db.read(
      `SELECT COUNT(*) as total FROM "user" WHERE shop_id = ANY($1)`,
      [shopIds]
    );

    // Summary: count orders from ALL sales (including debt, preorder, invoice)
    const summaryResult = await db.read(
      `SELECT 
        COUNT(DISTINCT sale_id) as total_orders,
        COUNT(DISTINCT seller_id) as total_sellers,
        COUNT(DISTINCT shop_id) as total_shops,
        COALESCE(SUM(total_quantity), 0) as total_products_sold,
        COALESCE(SUM(total_cost), 0) as total_cost
       FROM (
         SELECT s.id as sale_id, s.seller_id, s.shop_id,
                SUM(si.quantity) as total_quantity,
                SUM(si.buying_price_at_sale * si.quantity) as total_cost
          FROM sales s
          LEFT JOIN sale_items si ON s.id = si.sale_id
          WHERE s.shop_id = ANY($1) ${saleCatFilter}
          ${dateFilter}
          AND s.sale_type IS DISTINCT FROM 'pre_order'
          GROUP BY s.id, s.seller_id, s.shop_id
        ) as sales_with_items`,
      dateParams
    );

    // Revenue: value of goods sold in the period (SUM of sale totals). Same
    // definition as the dashboard month card and the sales page summary, so
    // all three pages report identical numbers for a given range. Money
    // actually collected is shown by the payments breakdown instead.
    const reportRevenueResult = await db.read(
      `SELECT COALESCE(SUM(s.total_amount), 0) as total_revenue
         FROM sales s
        WHERE s.shop_id = ANY($1) ${saleCatFilter}
          AND s.created_at >= $2 AND s.created_at <= $3
          AND s.sale_type IS DISTINCT FROM 'pre_order'`,
      dateParams
    );

    // Profit: dashboard-style (cash sale profit + proportional profit from non-cash payments)
    let reportProfitResult = await db.read(
      `SELECT COALESCE(SUM(profit), 0) as total_profit FROM (
         SELECT (si.unit_price * si.quantity - COALESCE(si.discount, 0)) - (COALESCE(si.buying_price_at_sale, 0) * si.quantity) as profit
         FROM sale_items si
         JOIN sales s ON si.sale_id = s.id
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.created_at >= $2 AND s.created_at <= $3
         AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         UNION ALL
         SELECT COALESCE(dp.amount - (costs.total_buying_cost * dp.amount / NULLIF(costs.total_debt, 0)), 0) as profit
         FROM debt_payments dp
         JOIN debtors d ON dp.debtor_id = d.id
         JOIN (
           SELECT d2.id,
                  COALESCE(SUM(si2.buying_price_at_sale * si2.quantity), 0) as total_buying_cost,
                  d2.total_amount as total_debt
           FROM debtors d2
           LEFT JOIN sale_items si2 ON d2.sale_id = si2.sale_id
           GROUP BY d2.id
         ) costs ON costs.id = d.id
         WHERE d.shop_id = ANY($1)
         AND dp.created_at >= $2 AND dp.created_at <= $3
         UNION ALL
         SELECT COALESCE(pp.amount * (sp.total_profit / NULLIF(sp.total_revenue, 0)), 0) as profit
         FROM pre_order_payments pp
         JOIN pre_orders po ON pp.pre_order_id = po.id
         JOIN (
           SELECT po2.id,
                  COALESCE(SUM((si3.unit_price * si3.quantity - COALESCE(si3.discount, 0)) - (COALESCE(si3.buying_price_at_sale, 0) * si3.quantity)), 0) as total_profit,
                  po2.total_amount as total_revenue
           FROM pre_orders po2
           LEFT JOIN sale_items si3 ON po2.id = si3.sale_id
           GROUP BY po2.id
         ) sp ON sp.id = po.id
         WHERE po.shop_id = ANY($1)
         AND pp.created_at >= $2 AND pp.created_at <= $3
         UNION ALL
         SELECT COALESCE(ip.amount * (sp.total_profit / NULLIF(sp.total_revenue, 0)), 0) as profit
         FROM invoice_payments ip
         JOIN sales s ON ip.sale_id = s.id
         JOIN (
           SELECT s3.id,
                  COALESCE(SUM((si4.unit_price * si4.quantity - COALESCE(si4.discount, 0)) - (COALESCE(si4.buying_price_at_sale, 0) * si4.quantity)), 0) as total_profit,
                  s3.total_amount as total_revenue
           FROM sales s3
           LEFT JOIN sale_items si4 ON s3.id = si4.sale_id
           WHERE s3.shop_id = ANY($1)
           GROUP BY s3.id
         ) sp ON sp.id = s.id
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND ip.created_at >= $2 AND ip.created_at <= $3
         AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
         UNION ALL
         SELECT COALESCE(sp.total_profit, 0) as profit
         FROM sales s
         JOIN (
           SELECT s5.id,
                  COALESCE(SUM((si5.unit_price * si5.quantity - COALESCE(si5.discount, 0)) - (COALESCE(si5.buying_price_at_sale, 0) * si5.quantity)), 0) as total_profit
           FROM sales s5
           LEFT JOIN sale_items si5 ON s5.id = si5.sale_id
           GROUP BY s5.id
         ) sp ON sp.id = s.id
         WHERE s.shop_id = ANY($1) ${saleCatFilter}
         AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt')
         AND s.payment_status = 'paid'
         AND s.sale_type IS DISTINCT FROM 'pre_order'
         AND s.updated_at >= $2 AND s.updated_at <= $3
         AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.sale_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
        ) combined`,
      dateParams
    );

    // Headline alignment: "Faida" is the full gross profit of every sale made
    // in the period — identical to the sales page profit total and the
    // dashboard month profit for the same range.
    reportProfitResult = await db.read(
      `SELECT COALESCE(SUM(si.profit), 0) as total_profit
         FROM sale_items si
         JOIN sales s ON si.sale_id = s.id
        WHERE s.shop_id = ANY($1) ${saleCatFilter}
          AND s.created_at >= $2 AND s.created_at <= $3
          AND s.sale_type IS DISTINCT FROM 'pre_order'`,
      dateParams
    );

    // The daily trend uses the same sales-value definition as the headline
    // cards (the legacy cash-collection UNION summed to a different figure
    // than "Mapato" on the same page).
    salesOverTimeResult = await db.read(
      `SELECT to_char((s.created_at + INTERVAL '3 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
              COALESCE(SUM(s.total_amount), 0) as revenue,
              COUNT(*)::int as orders
         FROM sales s
        WHERE s.shop_id = ANY($1) ${saleCatFilter}
          AND s.created_at >= $2 AND s.created_at <= $3
          AND s.sale_type IS DISTINCT FROM 'pre_order'
        GROUP BY 1
        ORDER BY 1`,
      dateParams
    );

    const reportData: any = {
      period: `${startDate} to ${endDate}`,
      salesOverTime: salesOverTimeResult.rows.map(r => ({
        date: r.date,
        orders: parseInt(r.orders),
        revenue: parseFloat(r.revenue)
      })),
      paymentMethods: paymentMethodResult.rows.map(r => ({
        method: r.method,
        count: parseInt(r.count),
        total: parseFloat(r.total)
      })),
      comparison: {
        thisWeek: {
          orders: parseInt(thisWeekResult.rows[0].count),
          revenue: parseFloat(thisWeekResult.rows[0].total)
        },
        lastWeek: {
          orders: parseInt(lastWeekResult.rows[0].count),
          revenue: parseFloat(lastWeekResult.rows[0].total)
        }
      },
      shopStats,
      usersCount: parseInt(usersResult.rows[0].total),
      summary: {
        totalOrders: parseInt(summaryResult.rows[0].total_orders),
        totalRevenue: parseFloat(reportRevenueResult.rows[0].total_revenue),
        totalSellers: parseInt(summaryResult.rows[0].total_sellers),
        totalShops: parseInt(summaryResult.rows[0].total_shops),
        totalProductsSold: parseInt(summaryResult.rows[0].total_products_sold) || 0,
        totalCost: parseFloat(summaryResult.rows[0].total_cost) || 0,
        totalProfit: parseFloat(reportProfitResult.rows[0].total_profit) || 0
      },
      // Pooled period report: one place for Sales, Debts, Expenses and Profit.
      pooled: (() => {
        const expensesTotal = parseFloat(expensesTotalResult.rows[0]?.total) || 0;
        const grossProfit = parseFloat(reportProfitResult.rows[0].total_profit) || 0;
        return {
          sales: {
            total: parseFloat(reportRevenueResult.rows[0].total_revenue) || 0,
            orders: parseInt(summaryResult.rows[0].total_orders) || 0,
            productsSold: parseInt(summaryResult.rows[0].total_products_sold) || 0,
          },
          debts: {
            created: parseFloat(debtsPeriodResult.rows[0]?.created) || 0,
            paid: parseFloat(debtsPeriodResult.rows[0]?.paid) || 0,
            count: parseInt(debtsPeriodResult.rows[0]?.count) || 0,
            collected: parseFloat(debtCollectedResult.rows[0]?.total) || 0,
            outstanding: parseFloat(debtsOutstandingResult.rows[0]?.total) || 0,
          },
          expenses: expensesTotal,
          capital: parseFloat(summaryResult.rows[0].total_cost) || 0,
          grossProfit,
          netProfit: grossProfit - expensesTotal,
        };
      })(),
      topProducts: topProductsResult.rows.map(r => ({
        name: r.name,
        quantity: parseInt(r.total_quantity),
        revenue: parseFloat(r.total_revenue),
        cost: parseFloat(r.total_cost) || 0,
        profit: parseFloat(r.total_profit) || 0
      })),
      // Profit analysis by product (whole period, best profit first).
      productProfit: (productProfitResult?.rows || []).map(r => {
        const revenue = parseFloat(r.total_revenue) || 0;
        const profit = parseFloat(r.total_profit) || 0;
        return {
          id: r.product_id,
          name: r.name,
          quantity: parseFloat(r.total_quantity) || 0,
          revenue,
          cost: parseFloat(r.total_cost) || 0,
          profit,
          marginPct: revenue > 0 ? (profit / revenue) * 100 : 0,
        };
      }),
      // Products with no sale in the period (capital still tied up in stock).
      unsoldProducts: (unsoldProductsResult?.rows || []).map(r => ({
        id: r.id,
        name: r.name,
        stock: parseFloat(r.stock) || 0,
        buyingPrice: parseFloat(r.buying_price) || 0,
        sellingPrice: parseFloat(r.selling_price) || 0,
        stockValue: parseFloat(r.stock_value) || 0,
        lastSoldAt: r.last_sold_at,
      })),
      unsoldCount: unsoldProductsResult?.rows.length > 0 ? parseInt(unsoldProductsResult.rows[0].total_count) : 0,
    };

    // Sellers only see what the admin allows: hide profit unless report:profit,
    // and other-shop performance unless report:shops.
    if (userRole === 'seller') {
      const userId = c.get('userId') as string;
      const userEmail = (c.get('user') as any)?.email?.toLowerCase();
      const permShopId = (shopIds || [])[0] as string;
      const [canProfit, canShops] = await Promise.all([
        hasPermission(userId, 'seller', permShopId, 'report:profit', userEmail),
        hasPermission(userId, 'seller', permShopId, 'report:shops', userEmail),
      ]);
      if (!canProfit) {
        reportData.summary.totalProfit = null;
        reportData.summary.totalCost = null;
        reportData.topProducts = reportData.topProducts.map((tp: any) => ({ ...tp, profit: null, cost: null }));
        reportData.productProfit = (reportData.productProfit || []).map((pp: any) => ({ ...pp, profit: null, cost: null, marginPct: null }));
        reportData.unsoldProducts = (reportData.unsoldProducts || []).map((up: any) => ({ ...up, buyingPrice: null, stockValue: null, sellingPrice: null }));
        if (reportData.pooled) {
          reportData.pooled.grossProfit = null;
          reportData.pooled.netProfit = null;
          reportData.pooled.capital = null;
          reportData.pooled.expenses = null;
        }
      }
      if (!canShops) {
        reportData.shopStats = [];
      }
    }

    if (reportCacheKey) cache.set(reportCacheKey, reportData, 30);

    return c.json({
      success: true,
      data: reportData
    });
  } catch (error: any) {
    console.error('Reports error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Shop Owner Reports - per-shop comprehensive data
app.get('/api/shop-reports', authMiddleware, async (c: any) => {
  const shopIds = c.get('shopIds') as string[];
  const userRole = c.get('userRole') as string;

  // Sellers can only reach this when the admin granted report:read.
  if (userRole === 'seller') {
    const userId = c.get('userId') as string;
    const userEmail = (c.get('user') as any)?.email?.toLowerCase();
    const canRead = await hasPermission(userId, 'seller', (shopIds || [])[0] as string, 'report:read', userEmail);
    if (!canRead) {
      return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
    }
  }
  
  if (!shopIds || shopIds.length === 0) {
    return c.json({ success: true, data: { shops: [], summary: {} } });
  }

  try {
    const filterShopId = c.req.query('shopId');
    const targetShopIds = (filterShopId && shopIds.includes(filterShopId)) ? [filterShopId] : shopIds;

    let startDate: string | null = c.req.query('startDate') || null;
    let endDate: string | null = c.req.query('endDate') || null;

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (startDate && !dateRegex.test(startDate)) startDate = null;
    if (endDate && !dateRegex.test(endDate)) endDate = null;

    const shopsResult = await db.read(
      `SELECT s.id, s.name, s.description FROM shops s WHERE s.id = ANY($1)`,
      [targetShopIds]
    );

    const shops = await Promise.all(shopsResult.rows.map(async (shop: any) => {
      const sid = shop.id;
      
      const today = new Date().toISOString().split('T')[0];
      const effectiveStart = startDate || '2000-01-01';
      const effectiveEnd = endDate || today;

      const [productsRes, stockRes, periodSalesRes, periodProfitRes, expensesRes, debtsRes, advancesRes] = await Promise.all([
        db.read(`SELECT COUNT(*) as count FROM products WHERE shop_id = $1 AND is_active = true`, [sid]),
        db.read(`SELECT COALESCE(SUM(current_stock * buying_price), 0) as value FROM products WHERE shop_id = $1 AND is_active = true`, [sid]),
        db.read(
          `SELECT COUNT(DISTINCT sale_id) as orders, COALESCE(SUM(total), 0) as revenue FROM (
             SELECT s.id as sale_id, s.total_amount as total FROM sales s
             WHERE s.shop_id = $1 AND s.payment_method IN ('cash', 'lipa_namba', 'bank') AND s.sale_type IS DISTINCT FROM 'pre_order'
             AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT s.id as sale_id, ip.amount as total FROM invoice_payments ip JOIN sales s ON ip.sale_id = s.id
             WHERE s.shop_id = $1
             AND DATE(ip.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(ip.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT s.id as sale_id, s.total_amount as total FROM sales s
             WHERE s.shop_id = $1 AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank') AND s.payment_status = 'paid' AND s.sale_type IS DISTINCT FROM 'pre_order'
             AND DATE(s.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(s.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.sale_id = s.id)
             AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
             UNION ALL
             SELECT pp.pre_order_id as sale_id, pp.amount as total FROM pre_order_payments pp JOIN pre_orders po ON pp.pre_order_id = po.id
             WHERE po.shop_id = $1
             AND DATE(pp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(pp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT COALESCE(d.sale_id, dp.id) as sale_id, dp.amount as total FROM debt_payments dp JOIN debtors d ON dp.debtor_id = d.id
             WHERE d.shop_id = $1
             AND DATE(dp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(dp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT s.id as sale_id, 0 as total FROM sales s
             WHERE s.shop_id = $1 AND s.payment_method = 'debt'
             AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT po.id as sale_id, 0 as total FROM pre_orders po
             WHERE po.shop_id = $1
             AND DATE(po.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(po.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT s.id as sale_id, 0 as total FROM sales s
             WHERE s.shop_id = $1 AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt') AND s.sale_type IS DISTINCT FROM 'pre_order'
             AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
           ) combined`,
          [sid, effectiveStart, effectiveEnd]
        ),
        db.read(
          `SELECT COALESCE(SUM(profit), 0) as profit FROM (
             SELECT (si.unit_price * si.quantity - COALESCE(si.discount, 0)) - (COALESCE(si.buying_price_at_sale, 0) * si.quantity) as profit
             FROM sale_items si JOIN sales s ON si.sale_id = s.id
             WHERE s.shop_id = $1 AND s.payment_method IN ('cash', 'lipa_namba', 'bank') AND s.sale_type IS DISTINCT FROM 'pre_order'
             AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT COALESCE(SUM(
               (si.unit_price * si.quantity - COALESCE(si.discount, 0)) - (COALESCE(si.buying_price_at_sale, 0) * si.quantity)
             ), 0) as profit
             FROM sale_items si JOIN sales s ON si.sale_id = s.id JOIN pre_orders po ON po.sale_id = s.id
             WHERE po.shop_id = $1
             AND s.sale_type = 'pre_order' AND s.payment_status = 'paid'
             AND DATE(s.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(s.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT COALESCE(SUM(dp.amount - (bc.total_buying * LEAST(dp.amount / NULLIF(d.total_amount, 0), 1))), 0) as profit
             FROM debt_payments dp JOIN debtors d ON dp.debtor_id = d.id
             LEFT JOIN (SELECT debtor_id, COALESCE(SUM(buying_price * quantity), 0) as total_buying FROM debt_items GROUP BY debtor_id) bc ON bc.debtor_id = d.id
             WHERE d.shop_id = $1
             AND DATE(dp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(dp.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT COALESCE(SUM(ip.amount * (sp.total_profit / NULLIF(s.total_amount, 0))), 0) as profit
             FROM invoice_payments ip JOIN sales s ON ip.sale_id = s.id
             LEFT JOIN (SELECT sale_id, COALESCE(SUM((unit_price * quantity - COALESCE(discount, 0)) - (COALESCE(buying_price_at_sale, 0) * quantity)), 0) as total_profit FROM sale_items GROUP BY sale_id) sp ON sp.sale_id = s.id
             WHERE s.shop_id = $1
             AND DATE(ip.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(ip.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             UNION ALL
             SELECT COALESCE(SUM(sp.total_profit), 0) as profit
             FROM sales s
             LEFT JOIN (SELECT sale_id, COALESCE(SUM((unit_price * quantity - COALESCE(discount, 0)) - (COALESCE(buying_price_at_sale, 0) * quantity)), 0) as total_profit FROM sale_items GROUP BY sale_id) sp ON sp.sale_id = s.id
             WHERE s.shop_id = $1 AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt') AND s.payment_status = 'paid' AND s.sale_type IS DISTINCT FROM 'pre_order'
             AND DATE(s.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= $2 AND DATE(s.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam') <= $3
             AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.sale_id = s.id)
             AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
           ) combined`,
          [sid, effectiveStart, effectiveEnd]
        ),
        db.read(
          `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM expenses WHERE shop_id = $1 AND date >= $2 AND date <= $3`,
          [sid, effectiveStart, effectiveEnd]
        ),
        db.read(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)), 0) as unpaid FROM debtors WHERE shop_id = $1 AND status != 'paid'`, [sid]),
        db.read(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)), 0) as remaining FROM pre_orders WHERE shop_id = $1 AND status = 'pending'`, [sid])
      ]);

      return {
        id: shop.id,
        name: shop.name,
        products: parseInt(productsRes.rows[0].count),
        stockValue: parseFloat(stockRes.rows[0].value),
        periodOrders: parseInt(periodSalesRes.rows[0].orders),
        periodRevenue: parseFloat(periodSalesRes.rows[0].revenue),
        periodProfit: parseFloat(periodProfitRes.rows[0].profit),
        expenses: { count: parseInt(expensesRes.rows[0].count), total: parseFloat(expensesRes.rows[0].total) },
        debts: { count: parseInt(debtsRes.rows[0].count), unpaid: parseFloat(debtsRes.rows[0].unpaid) },
        advances: { count: parseInt(advancesRes.rows[0].count), remaining: parseFloat(advancesRes.rows[0].remaining) }
      };
    }));

    const summary = shops.reduce((acc: any, s: any) => ({
      products: (acc.products || 0) + s.products,
      stockValue: (acc.stockValue || 0) + s.stockValue,
      periodOrders: (acc.periodOrders || 0) + s.periodOrders,
      periodRevenue: (acc.periodRevenue || 0) + s.periodRevenue,
      periodProfit: (acc.periodProfit || 0) + s.periodProfit,
      expensesTotal: (acc.expensesTotal || 0) + s.expenses.total,
      debtsUnpaid: (acc.debtsUnpaid || 0) + s.debts.unpaid,
      advancesRemaining: (acc.advancesRemaining || 0) + s.advances.remaining
    }), {});

    return c.json({ success: true, data: { shops, summary, dateRange: { start: startDate, end: endDate } } });
  } catch (error: any) {
    console.error('Shop reports error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Shop Activity Monitor - comprehensive shop oversight
app.get('/api/shop-activities', authMiddleware, async (c: any) => {
  const shopIds = c.get('shopIds') as string[];
  const userRole = c.get('userRole') as string;
  
  console.log('[Shop Activities] shopIds:', shopIds, 'userRole:', userRole);
  
  if (!shopIds || shopIds.length === 0) {
    return c.json({ success: true, data: { shops: [], sellers: [], activities: [], anomalies: [], summary: { totalShops: 0, totalSellers: 0, activeSellers: 0, inactiveSellers: 0, totalAnomalies: 0, highSeverityAnomalies: 0 } } });
  }

  try {
    const filterShopId = c.req.query('shopId');
    const targetShopIds = (filterShopId && shopIds.includes(filterShopId)) ? [filterShopId] : shopIds;
    const days = parseInt(c.req.query('days') || '7');
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    const sinceStr = sinceDate.toISOString().split('T')[0];

    // 1. Shop overview with key metrics
    const shopsResult = await pool.query(
      `SELECT s.id, s.name, s.is_active,
              (SELECT COUNT(*) FROM products WHERE shop_id = s.id AND is_active = true) as product_count,
              (SELECT COUNT(*) FROM products WHERE shop_id = s.id AND is_active = true AND current_stock <= 5) as low_stock_count,
               (SELECT COUNT(*) FROM sales WHERE shop_id = s.id AND DATE(created_at AT TIME ZONE 'Africa/Dar_es_Salaam') = DATE(NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')) as today_sales,
               (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = s.id AND DATE(created_at AT TIME ZONE 'Africa/Dar_es_Salaam') = DATE(NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')) as today_revenue
       FROM shops s WHERE s.id = ANY($1)`,
      [targetShopIds]
    );

    // 2. Seller activity - who's logged in, who hasn't
    const sellersResult = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.shop_id,
              u.last_login_at,
              (SELECT MAX(login_at) FROM login_history WHERE user_id::text = u.id AND status = 'success') as last_successful_login,
               (SELECT COUNT(*) FROM sales WHERE seller_id::text = u.id AND DATE(created_at AT TIME ZONE 'Africa/Dar_es_Salaam') = DATE(NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')) as today_sales_count,
              (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE seller_id::text = u.id AND created_at >= $2) as period_revenue,
              (SELECT COUNT(*) FROM sales WHERE seller_id::text = u.id AND created_at >= $2) as period_sales_count,
              (SELECT COUNT(*) FROM stock_adjustments WHERE created_by::text = u.id AND created_at >= $2) as period_adjustments,
              EXISTS(SELECT 1 FROM session WHERE user_id::text = u.id AND expires_at > NOW()) as has_active_session
       FROM "user" u WHERE u.shop_id::text = ANY($1) AND u.role IN ('admin', 'seller')
       ORDER BY u.last_login_at DESC NULLS LAST`,
      [targetShopIds, sinceDate.toISOString()]
    );

    // 3. Recent activities (sales, adjustments, stock takes)
    const recentSalesResult = await pool.query(
      `SELECT s.id, s.total_amount, s.payment_method, s.discount_amount, s.created_at,
              u.name as seller_name, u.email as seller_email,
              sh.name as shop_name,
              (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) as item_count
       FROM sales s
       LEFT JOIN "user" u ON s.seller_id::text = u.id
       LEFT JOIN shops sh ON s.shop_id = sh.id
       WHERE s.shop_id = ANY($1) AND s.created_at >= $2
       AND (s.sale_type IS DISTINCT FROM 'invoice' OR s.payment_status = 'paid')
       ORDER BY s.created_at DESC LIMIT 100`,
      [targetShopIds, sinceDate.toISOString()]
    );

    const recentAdjustmentsResult = await pool.query(
      `SELECT sa.id, sa.product_id, sa.previous_quantity, sa.new_quantity, sa.difference, 
              sa.adjustment_type, sa.notes, sa.created_at,
              p.name as product_name,
              sh.name as shop_name,
              sa.created_by as user_id
       FROM stock_adjustments sa
       LEFT JOIN products p ON sa.product_id = p.id
       LEFT JOIN shops sh ON sa.shop_id = sh.id
       WHERE sa.shop_id = ANY($1) AND sa.created_at >= $2
       ORDER BY sa.created_at DESC LIMIT 50`,
      [targetShopIds, sinceDate.toISOString()]
    );

    // 4. Low stock products
    const lowStockResult = await pool.query(
      `SELECT p.id, p.name, p.current_stock, p.buying_price, p.selling_price,
              sh.name as shop_name, sh.id as shop_id
       FROM products p
       JOIN shops sh ON p.shop_id = sh.id
       WHERE p.shop_id = ANY($1) AND p.is_active = true AND p.current_stock <= 5
       ORDER BY p.current_stock ASC LIMIT 50`,
      [targetShopIds]
    );

    // 5. Anomaly detection
    const anomalies: any[] = [];

    // 5a. After-hours sales (before 6am or after 10pm)
    const afterHoursResult = await pool.query(
      `SELECT s.id, s.total_amount, s.created_at, u.name as seller_name, sh.name as shop_name,
              EXTRACT(HOUR FROM s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') as sale_hour
       FROM sales s
       LEFT JOIN "user" u ON s.seller_id::text = u.id
       LEFT JOIN shops sh ON s.shop_id = sh.id
       WHERE s.shop_id = ANY($1) AND s.created_at >= $2
       AND (EXTRACT(HOUR FROM s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') < 6 
            OR EXTRACT(HOUR FROM s.created_at AT TIME ZONE 'Africa/Dar_es_Salaam') >= 22)`,
      [targetShopIds, sinceDate.toISOString()]
    );
    for (const row of afterHoursResult.rows) {
      anomalies.push({
        type: 'after_hours_sale',
        severity: 'warning',
        message: `Sale at ${Math.floor(Number(row.sale_hour))}:00 by ${row.seller_name || 'Unknown'}`,
        shopName: row.shop_name,
        details: `TSh ${Number(row.total_amount).toLocaleString()} at unusual hour`,
        createdAt: row.created_at
      });
    }

    // 5b. High discount sales (>20%)
    const highDiscountResult = await pool.query(
      `SELECT s.id, s.total_amount, s.discount_amount, s.created_at, u.name as seller_name, sh.name as shop_name
       FROM sales s
       LEFT JOIN "user" u ON s.seller_id::text = u.id
       LEFT JOIN shops sh ON s.shop_id = sh.id
       WHERE s.shop_id = ANY($1) AND s.created_at >= $2 AND s.discount_amount > 0
       AND s.discount_amount > (s.total_amount * 0.2)`,
      [targetShopIds, sinceDate.toISOString()]
    );
    for (const row of highDiscountResult.rows) {
      anomalies.push({
        type: 'high_discount',
        severity: 'warning',
        message: `High discount (${((Number(row.discount_amount) / (Number(row.total_amount) + Number(row.discount_amount)) * 100)).toFixed(0)}%) by ${row.seller_name || 'Unknown'}`,
        shopName: row.shop_name,
        details: `Discount: TSh ${Number(row.discount_amount).toLocaleString()}`,
        createdAt: row.created_at
      });
    }

    // 5c. Large stock adjustments (difference > 10 or >50% of stock)
    const largeAdjustResult = await pool.query(
      `SELECT sa.id, sa.difference, sa.previous_quantity, sa.new_quantity, sa.adjustment_type, sa.created_at,
              p.name as product_name, sh.name as shop_name, sa.created_by as user_id, u.name as user_name
       FROM stock_adjustments sa
       LEFT JOIN products p ON sa.product_id = p.id
       LEFT JOIN shops sh ON sa.shop_id = sh.id
       LEFT JOIN "user" u ON sa.created_by::text = u.id
       WHERE sa.shop_id = ANY($1) AND sa.created_at >= $2
       AND (ABS(sa.difference) > 10 OR (sa.previous_quantity > 0 AND ABS(sa.difference)::float / sa.previous_quantity > 0.5))`,
      [targetShopIds, sinceDate.toISOString()]
    );
    for (const row of largeAdjustResult.rows) {
      anomalies.push({
        type: 'large_adjustment',
        severity: 'high',
        message: `Large stock adjustment: ${row.product_name}`,
        shopName: row.shop_name,
        details: `${row.adjustment_type}: ${row.previous_quantity} → ${row.new_quantity} (${row.difference > 0 ? '+' : ''}${row.difference}) by ${row.user_name || 'Unknown'}`,
        createdAt: row.created_at
      });
    }

    // 5d. Sellers inactive for >3 days
    const sellers = sellersResult.rows.map((r: any) => ({
      id: r.id,
      name: r.name || 'Unknown',
      email: r.email,
      role: r.role,
      shopId: r.shop_id,
      lastLogin: r.last_successful_login || r.last_login_at,
      todaySalesCount: parseInt(r.today_sales_count),
      periodRevenue: parseFloat(r.period_revenue),
      periodSalesCount: parseInt(r.period_sales_count),
      periodAdjustments: parseInt(r.period_adjustments),
      hasActiveSession: r.has_active_session,
      daysSinceLogin: r.last_successful_login || r.last_login_at 
        ? Math.floor((Date.now() - new Date(r.last_successful_login || r.last_login_at).getTime()) / (1000 * 60 * 60 * 24))
        : null
    }));

    for (const seller of sellers) {
      if (seller.daysSinceLogin !== null && seller.daysSinceLogin > 3) {
        anomalies.push({
          type: 'inactive_seller',
          severity: seller.daysSinceLogin > 7 ? 'high' : 'warning',
          message: `${seller.name} hasn't logged in for ${seller.daysSinceLogin} days`,
          shopName: shopsResult.rows.find((s: any) => s.id === seller.shopId)?.name || 'Unknown',
          details: `Last login: ${seller.lastLogin ? new Date(seller.lastLogin).toLocaleDateString() : 'Never'}`,
          createdAt: seller.lastLogin || new Date().toISOString()
        });
      }
    }

    // Sort anomalies by severity and date
    const severityOrder: Record<string, number> = { high: 0, warning: 1, info: 2 };
    anomalies.sort((a, b) => (severityOrder[a.severity as string] || 2) - (severityOrder[b.severity as string] || 2) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({
      success: true,
      data: {
        shops: shopsResult.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          isActive: r.is_active,
          productCount: parseInt(r.product_count),
          lowStockCount: parseInt(r.low_stock_count),
          todaySales: parseInt(r.today_sales),
          todayRevenue: parseFloat(r.today_revenue)
        })),
        sellers,
        recentSales: recentSalesResult.rows.map((r: any) => ({
          id: r.id,
          totalAmount: parseFloat(r.total_amount),
          paymentMethod: r.payment_method,
          discountAmount: parseFloat(r.discount_amount || 0),
          itemCount: parseInt(r.item_count),
          sellerName: r.seller_name,
          sellerEmail: r.seller_email,
          shopName: r.shop_name,
          createdAt: r.created_at
        })),
        recentAdjustments: recentAdjustmentsResult.rows.map((r: any) => ({
          id: r.id,
          productName: r.product_name,
          previousQty: parseInt(r.previous_quantity),
          newQty: parseInt(r.new_quantity),
          difference: parseInt(r.difference),
          type: r.adjustment_type,
          notes: r.notes,
          shopName: r.shop_name,
          userId: r.user_id,
          createdAt: r.created_at
        })),
        lowStock: lowStockResult.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          currentStock: parseInt(r.current_stock),
          buyingPrice: parseFloat(r.buying_price),
          sellingPrice: parseFloat(r.selling_price),
          shopName: r.shop_name,
          shopId: r.shop_id
        })),
        anomalies,
        summary: {
          totalShops: shopsResult.rows.length,
          totalSellers: sellers.length,
          activeSellers: sellers.filter((s: any) => s.hasActiveSession).length,
          inactiveSellers: sellers.filter((s: any) => s.daysSinceLogin !== null && s.daysSinceLogin > 3).length,
          totalAnomalies: anomalies.length,
          highSeverityAnomalies: anomalies.filter((a: any) => a.severity === 'high').length
        }
      }
    });
  } catch (error: any) {
    console.error('Shop activities error:', error);
    console.error('Shop activities error stack:', error.stack);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Profits/Earnings endpoint
app.get('/api/profits', authMiddleware, async (c: any) => {
  const userShopIds = c.get('shopIds') as string[];
  const userRole = c.get('userRole') as string;
  const shopId = c.req.query('shopId');

  // The Earnings page is admin-only unless the seller was granted earning:read.
  if (userRole === 'seller') {
    const userId = c.get('userId') as string;
    const userEmail = (c.get('user') as any)?.email?.toLowerCase();
    const canRead = await hasPermission(userId, 'seller', (userShopIds || [])[0] as string, 'earning:read', userEmail);
    if (!canRead) {
      return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
    }
  }
  
  let shopIds: string[];
  if (shopId && userShopIds.includes(shopId)) {
    shopIds = [shopId];
  } else if (userShopIds.length > 0) {
    shopIds = userShopIds;
  } else {
    return c.json({ success: false, error: 'No shops assigned' }, 400);
  }

  try {
    const period = c.req.query('period') || 'month';
    const now = new Date();
    let startDate: Date;
    
    if (period === 'week') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === 'year') {
      startDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
const startDateStr = startDate.toISOString().split('T')[0];

    // Services (Huduma) income is merged into earnings only when the shop
    // toggles "add services to sales" on.
    let addServicesToSales = false;
    try {
      const servicesSettingsRes = await pool.query(
        `SELECT value FROM settings WHERE key = 'services' AND shop_id = ANY($1)`,
        [shopIds]
      );
      for (const r of servicesSettingsRes.rows as any[]) {
        const value = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        if (value?.add_to_sales === true) { addServicesToSales = true; break; }
      }
    } catch (e: any) {
      console.log('Services settings check error:', e.message);
    }

    const salesResult = await db.read(
      `SELECT COALESCE(SUM(total_revenue), 0) as total_revenue FROM (
         SELECT COALESCE(SUM(s.total_amount), 0) as total_revenue
         FROM sales s
         LEFT JOIN debtors d ON s.id = d.sale_id
         WHERE s.shop_id = ANY($1) 
         AND s.created_at >= $2
         AND (s.payment_method IN ('cash', 'lipa_namba', 'bank') OR d.status = 'paid')
         ${addServicesToSales ? `
         UNION ALL
         SELECT COALESCE(SUM(sr.total), 0) as total_revenue FROM service_records sr
         WHERE sr.shop_id = ANY($1) AND sr.created_at >= $2` : ''}
       ) combined`,
      [shopIds, startDateStr]
    );
    
    const profitResult = await db.read(
      `SELECT COALESCE(SUM(si.profit), 0) as total_profit
       FROM sale_items si
       JOIN sales s ON si.sale_id = s.id
       LEFT JOIN debtors d ON s.id = d.sale_id
       WHERE s.shop_id = ANY($1) 
       AND s.created_at >= $2
       AND (s.payment_method IN ('cash', 'lipa_namba', 'bank') OR d.status = 'paid')`,
       [shopIds, startDateStr]
    );
    
    let expensesResult;
    try {
      expensesResult = await db.read(
        `SELECT COALESCE(SUM(amount), 0) as total_expenses
         FROM expenses 
         WHERE shop_id = ANY($1) 
         AND date >= $2`,
        [shopIds, startDateStr]
      );
    } catch(e: any) {
      console.log('Expenses query error:', e.message);
      expensesResult = { rows: [{ total_expenses: 0 }] };
    }

    let expensesByCategoryResult;
    try {
      expensesByCategoryResult = await db.read(
        `SELECT category, SUM(amount) as total
         FROM expenses 
         WHERE shop_id = ANY($1) 
         AND date >= $2
         GROUP BY category
         ORDER BY total DESC`,
        [shopIds, startDateStr]
      );
    } catch(e: any) {
      console.log('Expenses by category error:', e.message);
      expensesByCategoryResult = { rows: [] };
    }

    let profitByProductResult;
    try {
      profitByProductResult = await db.read(
        `SELECT si.product_name as name,
                SUM(si.quantity) as quantity_sold,
                SUM(si.total_price) as revenue,
                SUM(si.profit) as profit
         FROM sale_items si
         JOIN sales s ON si.sale_id = s.id
         LEFT JOIN debtors d ON s.id = d.sale_id
         WHERE s.shop_id = ANY($1)
         AND s.created_at >= $2
         AND (s.payment_method IN ('cash', 'lipa_namba', 'bank') OR d.status = 'paid')
         GROUP BY si.product_name
         ORDER BY profit DESC
         LIMIT 20`,
        [shopIds, startDateStr]
      );
    } catch(e: any) {
      console.log('Profit by product error:', e.message);
      profitByProductResult = { rows: [] };
    }

    let profitByDayResult;
    try {
      profitByDayResult = await db.read(
        `SELECT DATE(s.created_at) as date,
                SUM(s.total_amount) as revenue,
                COALESCE(SUM(si.profit), 0) as profit
         FROM sales s
         LEFT JOIN sale_items si ON s.id = si.sale_id
         LEFT JOIN debtors d ON s.id = d.sale_id
         WHERE s.shop_id = ANY($1)
         AND s.created_at >= $2
         AND (s.payment_method IN ('cash', 'lipa_namba', 'bank') OR d.status = 'paid')
         GROUP BY DATE(s.created_at)
         ORDER BY date DESC`,
        [shopIds, startDateStr]
      );
    } catch(e: any) {
      console.log('Profit by day error:', e.message);
      profitByDayResult = { rows: [] };
    }

    let profitBySeller: any[] = [];
    try {
      const profitBySellerResult = await db.read(
        `SELECT s.seller_id,
                COUNT(s.id) as total_sales,
                SUM(s.total_amount) as revenue
         FROM sales s
         LEFT JOIN debtors d ON s.id = d.sale_id
         WHERE s.shop_id = ANY($1)
         AND s.created_at >= $2
         AND (s.payment_method IN ('cash', 'lipa_namba', 'bank') OR d.status = 'paid')
         GROUP BY s.seller_id
         ORDER BY revenue DESC`,
        [shopIds, startDateStr]
      );
      profitBySeller = profitBySellerResult.rows.map(r => ({
        sellerName: 'Seller ' + r.seller_id.substring(0, 8),
        totalSales: parseInt(r.total_sales),
        revenue: parseFloat(r.revenue),
        profit: 0
      }));
    } catch(e) {
      console.log('Profit by seller error:', e);
    }

    let profitByShop: any[] = [];
    if (userRole === 'admin' || userRole === 'owner' || userRole === 'developer') {
      const profitByShopResult = await db.read(
        `SELECT sh.name as shop_name,
                COUNT(s.id) as total_sales,
                SUM(s.total_amount) as revenue
         FROM sales s
         JOIN shops sh ON s.shop_id = sh.id
         LEFT JOIN debtors d ON s.id = d.sale_id
         WHERE s.shop_id = ANY($1)
         AND s.created_at >= $2
         AND (s.payment_method IN ('cash', 'lipa_namba', 'bank') OR d.status = 'paid')
         GROUP BY sh.id, sh.name
         ORDER BY revenue DESC`,
        [shopIds, startDateStr]
      );
      profitByShop = profitByShopResult.rows.map(r => ({
        shopName: r.shop_name,
        totalSales: parseInt(r.total_sales),
        revenue: parseFloat(r.revenue),
        profit: 0
      }));
    }

    let cargoResult;
    try {
      cargoResult = await db.read(
        `SELECT COALESCE(SUM(c.buying_price_per_unit * c.quantity + COALESCE(c.transport_cost, 0)), 0) as total_cost
         FROM cargo_entries c
         JOIN products p ON c.product_id = p.id
         WHERE p.shop_id = ANY($1)
         AND c.created_at >= $2`,
        [shopIds, startDateStr]
      );
    } catch(e: any) {
      console.log('Cargo query error:', e.message);
      cargoResult = { rows: [{ total_cost: 0 }] };
    }

    let debtsResult;
    try {
      debtsResult = await db.read(
        `SELECT 
          COUNT(*) as total_debtors,
          COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)), 0) as total_unpaid
         FROM debtors 
         WHERE shop_id = ANY($1) AND status != 'paid'`,
        [shopIds]
      );
    } catch(e: any) {
      console.log('Debts query error:', e.message);
      debtsResult = { rows: [{ total_debtors: 0, total_unpaid: 0 }] };
    }

    let preOrdersResult;
    try {
      preOrdersResult = await db.read(
        `SELECT 
          COUNT(*) as total_pre_orders,
          COALESCE(SUM(total_amount - paid_amount), 0) as total_remaining
         FROM pre_orders 
         WHERE shop_id = ANY($1) AND status = 'pending'`,
        [shopIds]
      );
    } catch(e: any) {
      console.log('PreOrders query error:', e.message);
      preOrdersResult = { rows: [{ total_pre_orders: 0, total_remaining: 0 }] };
    }

    const totalRevenue = parseFloat(salesResult.rows[0].total_revenue);
    const totalProfit = parseFloat(profitResult.rows[0].total_profit);
    const totalExpenses = parseFloat(expensesResult.rows[0].total_expenses);
    const totalCargoCost = parseFloat(cargoResult.rows[0].total_cost);
    const netEarnings = totalProfit - totalExpenses;

    return c.json({
      success: true,
      data: {
        period,
        revenue: totalRevenue,
        grossProfit: totalProfit,
        expenses: totalExpenses,
        cargoCost: totalCargoCost,
        netEarnings: netEarnings,
        expensesByCategory: expensesByCategoryResult.rows.map(r => ({
          category: r.category,
          amount: parseFloat(r.total)
        })),
        topProducts: profitByProductResult.rows.map(r => ({
          name: r.name,
          quantitySold: parseInt(r.quantity_sold),
          revenue: parseFloat(r.revenue),
          profit: parseFloat(r.profit)
        })),
        profitByDay: profitByDayResult.rows.map(r => ({
          date: r.date,
          revenue: parseFloat(r.revenue),
          profit: parseFloat(r.profit)
        })),
        profitBySeller: profitBySeller,
        profitByShop,
        debts: {
          totalDebtors: parseInt(debtsResult.rows[0].total_debtors),
          totalUnpaid: parseFloat(debtsResult.rows[0].total_unpaid)
        },
        preOrders: {
          totalPreOrders: parseInt(preOrdersResult.rows[0].total_pre_orders),
          totalRemaining: parseFloat(preOrdersResult.rows[0].total_remaining)
        }
      }
    });
  } catch (error: any) {
    console.error('Profits error:', error.message, error.stack);
    return c.json({ success: false, error: error.message || 'Unknown error' }, 500);
  }
});

// Serve static files from public folder (React build)
const publicDir = path.join(process.cwd(), 'public');
console.log('[Static] publicDir:', publicDir);

// Android APK + update manifest. Kept OUTSIDE public/ on purpose: the client
// build (vite emptyOutDir) wipes public/ on every deploy — that silently
// deleted the published APK and the download button started serving the SPA
// HTML instead. This folder is never touched by the web build.
const apkDir = path.join(process.cwd(), 'apk-dist');
console.log('[Static] apkDir:', apkDir);

// =====================================================
// PRECOMPRESSED STATIC ASSET SERVER
// =====================================================
// First page load is dominated by a few large JS/CSS chunks (a few MB raw).
// hono's `compress()` middleware re-gzips every one of those assets for EVERY
// visitor, so ten users opening the app simultaneously means the same few MB
// gets gzip'd ten times on the event loop — the single biggest CPU bottleneck
// under concurrent load. Instead we compress every text asset ONCE at startup
// (brotli for browsers, gzip as fallback), hold the bytes in memory, and serve
// them with no per-request compression and no synchronous disk read.
const ASSET_MIME: Record<string, string> = {
  'html': 'text/html',
  'js': 'application/javascript',
  'css': 'text/css',
  'json': 'application/json',
  'webmanifest': 'application/manifest+json',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'svg': 'image/svg+xml',
  'ico': 'image/x-icon',
  'webp': 'image/webp',
  'woff2': 'font/woff2',
  'xml': 'application/xml',
  'txt': 'text/plain',
  'map': 'application/json',
};
const COMPRESSIBLE_EXTS = new Set(['js', 'css', 'json', 'webmanifest', 'svg', 'txt', 'xml', 'map', 'html']);
// The desktop app talks to localhost, where compression saves no useful time
// and brotli/gzip level 9 noticeably delays backend startup. The desktop
// launcher disables it; the hosted web deployment keeps it enabled.
const STATIC_COMPRESSION_ENABLED = process.env.HSS_STATIC_COMPRESSION !== 'false';
const ASSET_TYPES_TO_PRECOMPRESS = new Set([
  'index.html', 'favicon.ico', 'vite.svg', 'logo.png',
  'apple-touch-icon.png', 'robots.txt', 'sitemap.xml',
]);

interface StaticEntry {
  content: Buffer;
  gzip: Buffer | null;
  br: Buffer | null;
  type: string;
}
const staticCache = new Map<string, StaticEntry>();

function addToStaticCache(relPath: string): void {
  const safePath = relPath.replace(/^\/+/, '');
  const fullPath = path.join(publicDir, safePath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
  const ext = safePath.split('.').pop()?.toLowerCase() || '';
  const content = fs.readFileSync(fullPath);
  let gzip: Buffer | null = null;
  let br: Buffer | null = null;
  if (STATIC_COMPRESSION_ENABLED && COMPRESSIBLE_EXTS.has(ext)) {
    try { gzip = gzipSync(content, { level: 9 }); } catch {}
    try { br = brotliCompressSync(content); } catch {}
  }
  staticCache.set('/' + safePath, {
    content, gzip, br,
    type: ASSET_MIME[ext] || 'application/octet-stream',
  });
}

// Build the immutable, content-hashed asset bundles once at startup.
function buildAssetCache(): void {
  try {
    const assetsDir = path.join(publicDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        addToStaticCache('assets/' + file);
      }
    }
    // Root files: index.html, icons, sitemap, and PWA files (sw.js,
    // manifest.webmanifest, workbox-*.js). Scanning the folder means future
    // PWA/runtime files are served without touching this list again.
    for (const file of fs.readdirSync(publicDir)) {
      try {
        if (fs.statSync(path.join(publicDir, file)).isFile()) addToStaticCache(file);
      } catch {}
    }
    for (const file of ASSET_TYPES_TO_PRECOMPRESS) {
      addToStaticCache(file);
    }
    console.log(`[Static] Precached ${staticCache.size} assets (${STATIC_COMPRESSION_ENABLED ? 'brotli+gzip' : 'no compression — local desktop'})`);
  } catch (e: any) {
    console.error('[Static] buildAssetCache error:', e.message);
  }
}

// Serve a cached/precompressed static file with content-negotiation.
function serveStaticAsset(c: any, relPath: string): Response | null {
  const entry = staticCache.get('/' + relPath.replace(/^\/+/, ''));
  if (!entry) return null;
  const acceptEncoding = c.req.header('Accept-Encoding') || '';
  c.header('Content-Type', entry.type);
  // Content-hashed assets are immutable; the plain files get their own header
  // from the caller. Encoding is content-negotiated, so Vary tells caches.
  c.header('Vary', 'Accept-Encoding');
  if (entry.br && /\bbr\b/i.test(acceptEncoding)) {
    c.header('Content-Encoding', 'br');
    return c.body(entry.br);
  }
  if (entry.gzip && /\bgzip\b/i.test(acceptEncoding)) {
    c.header('Content-Encoding', 'gzip');
    return c.body(entry.gzip);
  }
  return c.body(entry.content);
}

// Serve hashed bundles from the precompressed in-memory cache.
app.get('/assets/*', (c) => {
  const relPath = c.req.path.replace(/^\/assets\//, '');
  const served = serveStaticAsset(c, 'assets/' + relPath);
  if (served) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return served;
  }
  return c.body('Not Found', 404);
});

// Serve the remaining known static files (logo, favicon, sitemap…) from cache.
app.get('/favicon.ico', (c) => serveStaticAsset(c, 'favicon.ico') ?? c.body('Not Found', 404));
app.get('/vite.svg', (c) => serveStaticAsset(c, 'vite.svg') ?? c.body('Not Found', 404));
app.get('/logo.png', (c) => serveStaticAsset(c, 'logo.png') ?? c.body('Not Found', 404));
app.get('/apple-touch-icon.png', (c) => serveStaticAsset(c, 'apple-touch-icon.png') ?? c.body('Not Found', 404));
  app.get('/robots.txt', (c) => serveStaticAsset(c, 'robots.txt') ?? c.body('Not Found', 404));
app.get('/sitemap.xml', (c) => serveStaticAsset(c, 'sitemap.xml') ?? c.body('Not Found', 404));

// PWA + other root static files. sw.js and the manifest MUST be served with
// no-cache so installed apps always check for the newest build. The icon list
// must cover every file the manifest references (android-chrome-*, maskable-*)
// — otherwise the SPA fallback returns index.html for the icon URL and the
// browser reports "resource isn't a valid image".
const ROOT_STATIC_RE = /^\/(sw\.js|manifest\.webmanifest|site\.webmanifest|workbox-[\w.-]+\.js|favicon-\d+x\d+\.png|android-chrome-\d+x\d+\.png|maskable-\d+x\d+\.png|apple-touch-icon\.png|logo\.png|logo-full\.png|lipa\.png|registerSW\.js)$/;
app.get('*', async (c, next) => {
  const p = c.req.path;
  if (ROOT_STATIC_RE.test(p)) {
    const served = serveStaticAsset(c, p.slice(1));
    if (!served) return c.body('Not Found', 404);
    if (p === '/sw.js' || p === '/manifest.webmanifest' || p.startsWith('/workbox-') || p === '/registerSW.js') {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      c.header('Cache-Control', 'public, max-age=86400');
    }
    return served;
  }
  return next();
});


// ─── ANDROID APP (APK) DISTRIBUTION ─────────────────────────────────────────
// The React Native app in hss_app/ checks /app/version.json on launch. When a
// newer versionCode is published it prompts the user and downloads the APK
// from /app/hss-pos.apk. Everything lives in apk-dist/ (NOT public/, which the
// web build wipes) — same backend, no separate API or database.
app.get('/app/version.json', (c) => {
  const file = path.join(apkDir, 'version.json');
  if (!fs.existsSync(file)) return c.body('Not Found', 404);
  c.header('Content-Type', 'application/json');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  return c.body(fs.readFileSync(file));
});
// APK files get the Android package MIME type so Chrome on Android hands the
// file to the package installer instead of treating it as an unknown blob.
// `onFound` runs after serveStatic has set its own type — Hono's mime map has
// no .apk entry, so without this the APK would be sent as octet-stream.
app.use('/app/*', serveStatic({
  root: apkDir,
  rewriteRequestPath: (reqPath) => reqPath.replace(/^\/app\//, '/'),
  onFound: (filePath, c) => {
    if (filePath.toLowerCase().endsWith('.apk')) {
      c.header('Content-Type', 'application/vnd.android.package-archive');
      c.header('Content-Disposition', 'attachment; filename="hss-pos.apk"');
      c.header('Cache-Control', 'public, max-age=3600');
    }
  },
}));


// ===================================================
// NOTIFICATIONS API
// ===================================================

// GET /api/notifications - Get user notifications
app.get('/api/notifications', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const tenantId = c.get('tenantId');
  const limit = parseInt(c.req.query('limit') || '50');
  
  try {
    const result = await pool.query(`
      SELECT n.*, u.first_name || ' ' || u.last_name as created_by_name
      FROM notifications n
      LEFT JOIN "user" u ON u.id::text = n.created_by
      WHERE n.tenant_id = $1 OR n.user_id = $2
      ORDER BY n.created_at DESC
      LIMIT $3
    `, [tenantId, userId, limit]);
    
    const unreadCount = await pool.query(`
      SELECT COUNT(*) FROM notifications 
      WHERE (tenant_id = $1 OR user_id = $2) AND is_read = false
    `, [tenantId, userId]);
    
    return c.json({
      success: true,
      data: result.rows,
      unreadCount: parseInt(unreadCount.rows[0].count)
    });
  } catch (e: any) {
    console.error('[Notifications] Error:', e.message);
    return c.json({
      success: true,
      data: [],
      unreadCount: 0
    });
  }
});

// PUT /api/notifications/:id/read - Mark notification as read
app.put('/api/notifications/:id/read', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const notificationId = c.req.param('id');
  
  try {
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1`,
      [notificationId]
    );
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// PUT /api/notifications/read-all - Mark all notifications as read
app.put('/api/notifications/read-all', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const tenantId = c.get('tenantId');
  
  try {
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE tenant_id = $1 OR user_id = $2`,
      [tenantId, userId]
    );
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// POST /api/notifications - Create notification (admin only)
app.post('/api/notifications', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  const userId = c.get('userId');
  const callerTenantId = c.get('tenantId') as string | null;

  if (userRole !== 'developer' && userRole !== 'admin') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  try {
    const body = await c.req.json();
    const { tenant_id, user_id, title, message, type, action_url } = body;

    // Cross-tenant safety: a non-developer can only create notifications for
    // their OWN tenant, and only for users inside it (or tenant-wide with null).
    let targetTenantId = tenant_id || null;
    if (userRole !== 'developer') {
      targetTenantId = callerTenantId;
      if (tenant_id && callerTenantId && tenant_id !== callerTenantId) {
        return c.json({ success: false, error: 'Forbidden - wrong tenant' }, 403);
      }
    }
    if (user_id) {
      const target = await pool.query('SELECT tenant_id FROM "user" WHERE id = $1', [user_id]);
      if (target.rows.length === 0) {
        return c.json({ success: false, error: 'User not found' }, 404);
      }
      if (userRole !== 'developer' && callerTenantId && target.rows[0].tenant_id !== callerTenantId) {
        return c.json({ success: false, error: 'Forbidden - wrong tenant' }, 403);
      }
    }

    const result = await pool.query(`
      INSERT INTO notifications (tenant_id, user_id, title, message, type, action_url, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [targetTenantId, user_id || null, title, message, type || 'info', action_url || null, userId]);

    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// DELETE /api/notifications/:id - Delete notification (admin only)
app.delete('/api/notifications/:id', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  
  try {
    const notificationId = c.req.param('id');
    await pool.query(`DELETE FROM notifications WHERE id = $1`, [notificationId]);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ===================================================
// SUPPORT CHAT API
// ===================================================

// ─── Support chat helpers ───────────────────────────────────────────────────
// Context shown to the developer (name, shop, paid status) and used by the AI.
async function getSupportUserContext(userId: string) {
  try {
    const r = await pool.query(`
      SELECT u.name, u.email, u.phone, u.tenant_id,
        COALESCE(
          (SELECT COALESCE(s.business_name, s.name) FROM shops s WHERE s.id::text = u.shop_id LIMIT 1),
          (SELECT COALESCE(s2.business_name, s2.name) FROM user_shops us JOIN shops s2 ON s2.id = us.shop_id WHERE us.user_id = u.id ORDER BY us.created_at LIMIT 1)
        ) as shop_name,
        (SELECT t.name FROM tenants t WHERE t.id::text = u.tenant_id LIMIT 1) as tenant_name,
        (SELECT ts.current_period_end FROM tenant_subscriptions ts
          WHERE ts.tenant_id::text = u.tenant_id AND ts.status = 'active' AND ts.current_period_end > NOW()
          ORDER BY ts.current_period_end DESC LIMIT 1) as subscription_end,
        (SELECT t.trial_activated FROM tenants t WHERE t.id::text = u.tenant_id LIMIT 1) as trial_activated,
        (SELECT t.trial_end FROM tenants t WHERE t.id::text = u.tenant_id LIMIT 1) as trial_end
      FROM "user" u WHERE u.id = $1
    `, [userId]);
    const row: any = r.rows[0] || {};
    let accountStatus = 'Hajalipia (bure)';
    if (row.subscription_end && new Date(row.subscription_end) > new Date()) {
      accountStatus = `Amelipia hadi ${new Date(row.subscription_end).toLocaleDateString('en-GB')}`;
    } else if (row.trial_activated && row.trial_end && new Date(row.trial_end) > new Date()) {
      const days = Math.max(0, Math.ceil((new Date(row.trial_end).getTime() - Date.now()) / 86400000));
      accountStatus = `Trial (siku ${days} zimesalia)`;
    }
    return { ...row, accountStatus };
  } catch (e: any) {
    console.warn('[Support] user context failed:', e?.message);
    return { accountStatus: 'Unknown' } as any;
  }
}

// One AI reply per chat at a time. Follow-ups that arrive while the AI is
// thinking are queued (never silently dropped).
const supportAiInFlight = new Set<string>();
const supportAiQueued = new Map<string, string>();
// Throttle "AI failed" alert emails per chat so a missing API key never spams.
const supportAiFallbackAlerted = new Map<string, number>();

async function maybeAiSupportReply(chatId: string, chat: any, userMessage: string) {
  if (chat?.status === 'closed') return;
  if (supportAiInFlight.has(chatId)) {
    supportAiQueued.set(chatId, userMessage);
    return;
  }
  // Stay active as a first responder: the AI remains quiet only when a human
  // replied in the last few minutes, so it never talks over an active chat.
  try {
    const recentHuman = await pool.query(
      `SELECT 1 FROM chat_messages
       WHERE chat_id = $1 AND is_admin_message = true AND sender_id <> 'ai-assistant'
         AND created_at > NOW() - INTERVAL '3 minutes' LIMIT 1`,
      [chatId]
    );
    if (recentHuman.rows.length > 0) return;
  } catch {}
  supportAiInFlight.add(chatId);
  try {
    const historyRes = await pool.query(
      `SELECT sender_role, is_admin_message, message FROM chat_messages
       WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 8`,
      [chatId]
    );
    const history = historyRes.rows.reverse().map((m: any) => ({
      role: (m.is_admin_message ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.message,
    }));

    const ctx = await getSupportUserContext(chat.user_id);
    const aiReply = await generateSupportReply({
      userName: ctx.name,
      shopName: ctx.shop_name,
      history,
      question: userMessage,
      isSw: true,
    });

    // The model may return the human-handover sentence itself for
    // account-specific issues — treat that exactly like an AI failure so the
    // chat escalates to the developer and the user sees the standard message.
    const isHandover = !aiReply || /nimetuma taarifa kwa support team/i.test(aiReply);
    const text = isHandover ? supportFallbackMessage(true) : aiReply!;
    const msgRes = await pool.query(
      `INSERT INTO chat_messages (chat_id, sender_id, sender_role, message, is_admin_message, is_read)
       VALUES ($1, 'ai-assistant', 'admin', $2, true, false)
       RETURNING *, 'Msaidizi wa ALFEAN ENTERPRISES' as sender_name`,
      [chatId, text]
    );
    await pool.query(`UPDATE support_chats SET updated_at = NOW() WHERE id = $1`, [chatId]);
    broadcastToChat(chatId, { type: 'new_message', message: msgRes.rows[0] });

    if (isHandover) {
      // Hand over to the human developer: flag the chat so it stands out in
      // the /developer support list, and alert by email (throttled).
      try {
        await pool.query(
          `UPDATE support_chats SET ai_escalated = true, ai_escalated_at = NOW() WHERE id = $1`,
          [chatId]
        );
        broadcastToChat(chatId, { type: 'ai_escalated', chatId });
      } catch (e: any) {
        console.warn('[Support AI] escalation flag failed:', e?.message);
      }
      const last = supportAiFallbackAlerted.get(chatId) || 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        supportAiFallbackAlerted.set(chatId, Date.now());
        sendSupportMessageAlert({
          userName: ctx.name, userEmail: ctx.email, userPhone: ctx.phone,
          shopName: ctx.shop_name, tenantName: ctx.tenant_name,
          accountStatus: ctx.accountStatus, subject: chat.subject,
          message: userMessage, chatId, aiFailed: true,
        }).catch(() => {});
      }
    }
  } catch (e: any) {
    console.warn('[Support AI] reply failed:', e?.message);
  } finally {
    supportAiInFlight.delete(chatId);
    // Answer the newest follow-up that arrived while the AI was thinking.
    const queued = supportAiQueued.get(chatId);
    if (queued) {
      supportAiQueued.delete(chatId);
      maybeAiSupportReply(chatId, chat, queued).catch(() => {});
    }
  }
}

// ─── Support chat access control ─────────────────────────────────────────────
// A chat belongs to exactly ONE user. Only that user and the developer may
// read or write it. No other shop, tenant or staff member can access it.
async function getAccessibleChat(c: any, chatId: string) {
  const r = await pool.query(`SELECT * FROM support_chats WHERE id = $1`, [chatId]);
  const chat = r.rows[0];
  if (!chat) return { chat: null, allowed: false, status: 404 };
  const role = c.get('userRole');
  if (role === 'developer') return { chat, allowed: true, status: 200 };
  if (chat.user_id === c.get('userId')) return { chat, allowed: true, status: 200 };
  return { chat, allowed: false, status: 403 };
}

// Support chat is a per-member toggle (support:read). Owners/admins always
// pass; members need the permission (granted by default, hideable per member).
app.use('/api/support/*', authMiddleware, requirePermission('support:read'));

// GET /api/support/chats - Get user's chat sessions
app.get('/api/support/chats', authMiddleware, async (c) => {
  const userId = c.get('userId');
  
  try {
    const result = await pool.query(`
      SELECT sc.*, 
        (SELECT COUNT(*) FROM chat_messages WHERE chat_id = sc.id) as message_count,
        (SELECT message FROM chat_messages WHERE chat_id = sc.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM chat_messages WHERE chat_id = sc.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
        u.name as admin_name
      FROM support_chats sc
      LEFT JOIN "user" u ON u.id = sc.admin_id
      WHERE sc.user_id = $1
      ORDER BY sc.updated_at DESC
    `, [userId]);
    
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// GET /api/support/chats/:id/messages - Get chat messages (owner or developer only)
app.get('/api/support/chats/:id/messages', authMiddleware, async (c) => {
  const chatId = c.req.param('id');
  
  try {
    const access = await getAccessibleChat(c, chatId);
    if (!access.allowed) {
      return c.json({ success: false, error: access.status === 404 ? 'Chat not found' : 'Forbidden' }, access.status as any);
    }
    const result = await pool.query(`
      SELECT cm.*, u.name as sender_name
      FROM chat_messages cm
      LEFT JOIN "user" u ON u.id = cm.sender_id
      WHERE cm.chat_id = $1
      ORDER BY cm.created_at ASC
    `, [chatId]);
    
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// SSE endpoint for real-time chat messages
const chatSubscribers: Map<string, Set<ReadableStreamDefaultController>> = new Map();

app.get('/api/support/chats/:id/stream', authMiddleware, async (c) => {
  const chatId = c.req.param('id');
  const userId = c.get('userId');

  const access = await getAccessibleChat(c, chatId);
  if (!access.allowed) {
    return c.json({ success: false, error: access.status === 404 ? 'Chat not found' : 'Forbidden' }, access.status as any);
  }
  
  // Set SSE headers
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  
  const stream = new ReadableStream({
    start(controller) {
      // Add this client to subscribers
      if (!chatSubscribers.has(chatId)) {
        chatSubscribers.set(chatId, new Set());
      }
      chatSubscribers.get(chatId)!.add(controller);
      
      // Send initial connection message
      controller.enqueue(`data: ${JSON.stringify({ type: 'connected', chatId })}\n\n`);
      
      // Send heartbeat every 30 seconds
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(`: heartbeat\n\n`);
        } catch {
          clearInterval(heartbeat);
        }
      }, 30000);
      
      // Cleanup on close
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        const subs = chatSubscribers.get(chatId);
        if (subs) {
          subs.delete(controller);
          if (subs.size === 0) chatSubscribers.delete(chatId);
        }
      });
    }
  });
  
  return new Response(stream);
});

// Function to broadcast message to all subscribers
function broadcastToChat(chatId: string, data: any) {
  const subscribers = chatSubscribers.get(chatId);
  if (subscribers) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    subscribers.forEach(controller => {
      try {
        controller.enqueue(message);
      } catch {
        // Client disconnected, will be cleaned up
      }
    });
  }
}

// Typing indicators storage
const typingUsers: Map<string, Set<string>> = new Map();

// POST /api/support/chats/:id/typing - Send typing indicator
app.post('/api/support/chats/:id/typing', authMiddleware, async (c) => {
  const chatId = c.req.param('id');
  const userId = c.get('userId');
  const userRole = c.get('userRole');
  const isAdmin = userRole === 'developer' || userRole === 'admin';
  
  try {
    const access = await getAccessibleChat(c, chatId);
    if (!access.allowed) {
      return c.json({ success: false, error: access.status === 404 ? 'Chat not found' : 'Forbidden' }, access.status as any);
    }
    if (!typingUsers.has(chatId)) {
      typingUsers.set(chatId, new Set());
    }
    
    const typingSet = typingUsers.get(chatId)!;
    
    // Add or remove user from typing set
    const key = `${isAdmin ? 'admin' : 'user'}:${userId}`;
    if (typingSet.has(key)) {
      typingSet.delete(key);
    } else {
      typingSet.add(key);
      // Auto-remove after 5 seconds
      setTimeout(() => {
        typingSet.delete(key);
      }, 5000);
    }
    
    // Broadcast typing status
    broadcastToChat(chatId, {
      type: 'typing',
      userId,
      isAdmin,
      isTyping: typingSet.has(key)
    });
    
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// POST /api/support/chats/:id/read - Mark messages as read
app.post('/api/support/chats/:id/read', authMiddleware, async (c) => {
  const chatId = c.req.param('id');
  const userId = c.get('userId');
  const userRole = c.get('userRole');
  const isAdmin = userRole === 'developer' || userRole === 'admin';
  
  try {
    const access = await getAccessibleChat(c, chatId);
    if (!access.allowed) {
      return c.json({ success: false, error: access.status === 404 ? 'Chat not found' : 'Forbidden' }, access.status as any);
    }
    // Update all messages from the other party as read
    await pool.query(`
      UPDATE chat_messages 
      SET is_read = true 
      WHERE chat_id = $1 AND sender_id != $2 AND (is_read = false OR is_read IS NULL)
    `, [chatId, userId]);
    
    // Broadcast read receipt
    broadcastToChat(chatId, {
      type: 'read_receipt',
      userId,
      isAdmin
    });
    
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// POST /api/support/chats - Create new chat session
app.post('/api/support/chats', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const tenantId = c.get('tenantId');
  
  try {
    const body = await c.req.json();
    const { subject, message } = body;
    
    // Create chat session
    const chatResult = await pool.query(`
      INSERT INTO support_chats (tenant_id, user_id, subject)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [tenantId, userId, subject || 'Support Request']);
    
    const chatId = chatResult.rows[0].id;
    
    // Add first message
    const msgResult = await pool.query(`
      INSERT INTO chat_messages (chat_id, sender_id, sender_role, message, is_admin_message)
      VALUES ($1, $2, 'user', $3, false)
      RETURNING *, (SELECT name FROM "user" WHERE id = $2) as sender_name
    `, [chatId, userId, message]);
    
    // No tenant-wide notification: chats are private to the user who opened
    // them. The developer is alerted by email and sees chats in the dashboard.
    
    // Broadcast new chat to admin subscribers
    broadcastToChat('admin', {
      type: 'new_chat',
      chat: chatResult.rows[0],
      message: msgResult.rows[0]
    });

    // Alert the developer by email + let the AI assistant answer immediately.
    getSupportUserContext(userId)
      .then((ctx) => sendSupportMessageAlert({
        userName: ctx.name, userEmail: ctx.email, userPhone: ctx.phone,
        shopName: ctx.shop_name, tenantName: ctx.tenant_name,
        accountStatus: ctx.accountStatus, subject: subject || 'Support Request',
        message, chatId, isFirstMessage: true,
      }))
      .catch(() => {});
    maybeAiSupportReply(chatId, chatResult.rows[0], message).catch(() => {});

    return c.json({ success: true, data: chatResult.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// POST /api/support/chats/:id/messages - Send chat message
app.post('/api/support/chats/:id/messages', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const userRole = c.get('userRole');
  const chatId = c.req.param('id');
  
  try {
    const body = await c.req.json();
    const { message } = body;
    
    if (!message || message.trim().length === 0) {
      return c.json({ success: false, error: 'Message cannot be empty' }, 400);
    }
    
    const isAdmin = userRole === 'developer' || userRole === 'admin';
    
    // Check chat exists AND belongs to this user (or developer)
    const access = await getAccessibleChat(c, chatId);
    if (!access.allowed) {
      return c.json({ success: false, error: access.status === 404 ? 'Chat not found' : 'Forbidden' }, access.status as any);
    }
    
    const chat = access.chat;
    
    // If admin is joining for the first time, update chat and notify user
    if (isAdmin && !chat.admin_id) {
      await pool.query(`
        UPDATE support_chats SET admin_id = $1, status = 'active', updated_at = NOW() WHERE id = $2
      `, [userId, chatId]);
      
      // Notify user that admin joined
      await pool.query(`
        INSERT INTO notifications (tenant_id, user_id, title, message, type)
        VALUES ($1, $2, $3, $4, 'support')
      `, [chat.tenant_id, chat.user_id, 'Admin joined chat', 'An administrator has joined your support chat', 'support']);
      
      // Broadcast admin join event
      broadcastToChat(chatId, {
        type: 'admin_joined',
        adminId: userId,
        message: 'An administrator has joined the chat'
      });
    }
    
    // Update chat timestamp
    await pool.query(`UPDATE support_chats SET updated_at = NOW() WHERE id = $1`, [chatId]);
    
    // Add message
    const msgResult = await pool.query(`
      INSERT INTO chat_messages (chat_id, sender_id, sender_role, message, is_admin_message, is_read)
      VALUES ($1, $2, $3, $4, $5, false)
      RETURNING *, (SELECT name FROM "user" WHERE id = $2) as sender_name
    `, [chatId, userId, isAdmin ? 'admin' : 'user', message, isAdmin]);
    
    // Broadcast message in real-time
    broadcastToChat(chatId, {
      type: 'new_message',
      message: msgResult.rows[0]
    });
    
    // If admin sent message, mark user's messages as read
    if (isAdmin) {
      await pool.query(`
        UPDATE chat_messages 
        SET is_read = true 
        WHERE chat_id = $1 AND sender_id != $2 AND is_read = false
      `, [chatId, userId]);
      // A human has taken over — clear the AI "needs help" flag.
      await pool.query(`UPDATE support_chats SET ai_escalated = false WHERE id = $1`, [chatId]);
    }
    
    // Notify other party
    if (isAdmin) {
      await pool.query(`
        INSERT INTO notifications (tenant_id, user_id, title, message, type)
        VALUES ($1, $2, $3, $4, 'support')
      `, [chat.tenant_id, chat.user_id, 'New message in support chat', message.slice(0, 100), 'support']);
    } else {
      // NOTE: no tenant-wide in-app notification here. A chat is private to the
      // user who opened it; other shops/staff must never see it. The developer
      // is alerted by email + the developer dashboard chat list.
      getSupportUserContext(userId)
        .then((ctx) => sendSupportMessageAlert({
          userName: ctx.name, userEmail: ctx.email, userPhone: ctx.phone,
          shopName: ctx.shop_name, tenantName: ctx.tenant_name,
          accountStatus: ctx.accountStatus, subject: chat.subject,
          message, chatId, isFirstMessage: false,
        }))
        .catch(() => {});
      maybeAiSupportReply(chatId, chat, message).catch(() => {});
    }
    
    return c.json({ success: true, data: msgResult.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// PUT /api/support/chats/:id/close - Close chat (developer only)
app.put('/api/support/chats/:id/close', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  
  try {
    const chatId = c.req.param('id');
    await pool.query(`
      UPDATE support_chats SET status = 'closed', updated_at = NOW() WHERE id = $1
    `, [chatId]);
    
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// DELETE /api/support/chats/:id - Delete a chat (owner or developer only).
// Messages are removed automatically (chat_messages FK ON DELETE CASCADE).
app.delete('/api/support/chats/:id', authMiddleware, async (c) => {
  const chatId = c.req.param('id');
  try {
    const access = await getAccessibleChat(c, chatId);
    if (!access.allowed) {
      return c.json({ success: false, error: access.status === 404 ? 'Chat not found' : 'Forbidden' }, access.status as any);
    }
    await pool.query(`DELETE FROM support_chats WHERE id = $1`, [chatId]);
    typingUsers.delete(chatId);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// GET /api/admin/support/chats - Developer-only view of all chats
app.get('/api/admin/support/chats', authMiddleware, async (c) => {
  const userRole = c.get('userRole');
  if (userRole !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  
  try {
    const statusFilter = c.req.query('status') || 'all';
    const whereClause = statusFilter !== 'all' ? `WHERE sc.status = $1` : '';
    const params = statusFilter !== 'all' ? [statusFilter] : [];
    
    const result = await pool.query(`
      SELECT sc.*, 
        t.name as tenant_name,
        u.name as user_name,
        u.email as user_email,
        u.phone as user_phone,
        a.name as admin_name,
        COALESCE(
          (SELECT COALESCE(s.business_name, s.name) FROM shops s WHERE s.id::text = u.shop_id LIMIT 1),
          (SELECT COALESCE(s2.business_name, s2.name) FROM user_shops us JOIN shops s2 ON s2.id = us.shop_id WHERE us.user_id = u.id ORDER BY us.created_at LIMIT 1)
        ) as shop_name,
        (SELECT ts.current_period_end FROM tenant_subscriptions ts
          WHERE ts.tenant_id::text = u.tenant_id AND ts.status = 'active' AND ts.current_period_end > NOW()
          ORDER BY ts.current_period_end DESC LIMIT 1) as subscription_end,
        (SELECT tt.trial_activated FROM tenants tt WHERE tt.id::text = u.tenant_id LIMIT 1) as trial_activated,
        (SELECT tt.trial_end FROM tenants tt WHERE tt.id::text = u.tenant_id LIMIT 1) as trial_end,
        (SELECT COUNT(*) FROM chat_messages WHERE chat_id = sc.id) as message_count,
        (SELECT message FROM chat_messages WHERE chat_id = sc.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM chat_messages WHERE chat_id = sc.id ORDER BY created_at DESC LIMIT 1) as last_message_at
      FROM support_chats sc
      LEFT JOIN tenants t ON t.id = sc.tenant_id
      LEFT JOIN "user" u ON u.id = sc.user_id
      LEFT JOIN "user" a ON a.id = sc.admin_id
      ${whereClause}
      ORDER BY sc.updated_at DESC
    `, params);
    
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Serve other static files
app.use('*', async (c, next) => {
  const reqPath = c.req.path;
  
  // Skip API routes
  if (reqPath.startsWith('/api')) {
    return next();
  }
  
  // Skip assets (handled above)
  if (reqPath.startsWith('/assets')) {
    return next();
  }

  // Missing /app/* files (notably the APK) must 404 — never fall back to the
  // SPA shell. Serving index.html for /app/hss-pos.apk made Android download
  // an HTML file instead of the installer.
  if (reqPath.startsWith('/app/')) {
    return c.body('Not Found', 404);
  }

  // Serve root as index.html (from the precompressed in-memory cache)
  if (reqPath === '/') {
    const served = serveStaticAsset(c, 'index.html');
    if (served) {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return served;
    }
  }
  
  // Serve /sitemap → sitemap.xml
  if (reqPath === '/sitemap') {
    const served = serveStaticAsset(c, 'sitemap.xml');
    if (served) {
      c.header('Content-Type', 'application/xml');
      return served;
    }
  }

  // SPA fallback - serve index.html for React Router (from memory cache)
  const servedIndex = serveStaticAsset(c, 'index.html');
  if (servedIndex) {
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    return servedIndex;
  }
  
  return c.json({ error: 'Not found' }, 404);
});

  // 404 handler for API routes
app.notFound((c) => {
  if (c.req.path.startsWith('/api')) {
    return c.json({
      success: false,
      error: 'Not found',
    }, 404);
  }
  
  // For non-API routes, serve index.html (SPA support, from memory cache)
  try {
    const served = serveStaticAsset(c, 'index.html');
    if (served) {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return served;
    }
  } catch (e) {
    console.error('Error serving index.html:', e);
  }
  
  return c.json({
    success: false,
    error: 'Not found',
  }, 404);
});

// Error handler
app.onError(errorHandler);

// Build the precompressed static-asset cache once before accepting traffic so
// the first visitor never pays a cold-compression penalty.
buildAssetCache();

// Start server
serve({
  fetch: app.fetch,
  port: SERVER_CONFIG.port,
}, (info) => {
  console.log(`🚀 ALFEAN ENTERPRISES Server running on http://localhost:${info.port}`);
  console.log(`📚 Better Auth endpoints: http://localhost:${info.port}/api/auth/*`);
  console.log(`📚 Health Check: http://localhost:${info.port}/health`);
});

export default app;


