import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { sendSupportReply } from '../../services/email.service.js';
import { cache } from '../../utils/cache.js';
import {
  getNotifiers,
  createNotifier,
  updateNotifier,
  deleteNotifier,
  testNotifier,
  getBackupStatus,
  getBackupStatusHistory,
  getNotifierLogs,
  getWebhookConfig,
  setWebhookSecret,
  receiveBackupStatus,
} from '../../services/backup-notifier.service.js';
import { getProviderWalletStatus, getResellerSettings } from '../../services/sms-reseller.service.js';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();
router.use('/*', authMiddleware);

const requireSuperAdmin = async (c: any, next: any) => {
  const role = c.get('userRole');
  if (role !== 'developer') return c.json({ success: false, error: 'Forbidden' }, 403);
  await next();
};
router.use('/*', requireSuperAdmin);

// System Health
router.get('/health', async (c) => {
  try {
    // Database latency test
    const start = Date.now();
    await pool.query('SELECT 1');
    const latency = Date.now() - start;

    // Memory usage (from Node.js process)
    const memoryUsage = {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    };

    // System uptime (simplified)
    const uptime = process.uptime ? `${Math.floor(process.uptime())}s` : '0s';

    // Table counts
    const tableCounts: Record<string, number> = {};
    const tables: [string, string][] = [['user', 'users'], ['shops', 'shops'], ['products', 'products'], ['sales', 'sales']];
    for (const [dbTable, key] of tables) {
      try {
        const result = await pool.query(`SELECT COUNT(*) FROM "${dbTable}"`);
        tableCounts[key] = parseInt(result.rows[0].count);
      } catch (e) {
        tableCounts[key] = 0;
      }
    }

    // Error count (last 24h) - using system_errors table instead of admin_audit_log
    const errorResult = await pool.query(
      "SELECT COUNT(*) FROM system_errors WHERE created_at >= NOW() - INTERVAL '24 hours'"
    );
    const errorCount = parseInt(errorResult.rows[0].count);

    return c.json({
      success: true,
      data: {
        status: 'healthy',
        database: {
          latency: `${latency}ms`
        },
        system: {
          memory: memoryUsage,
          uptime: uptime
        },
        tables: tableCounts,
        errors: {
          last24h: errorCount
        },
        // Flat keys for frontend compatibility
        dbLatency: `${latency}ms`,
        db_latency: `${latency}ms`,
        memory: `${memoryUsage.used}MB`,
        uptime: uptime,
        users: tableCounts.users || 0,
        shops: tableCounts.shops || 0,
        products: tableCounts.products || 0,
        sales: tableCounts.sales || 0,
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// CEO Dashboard Stats
router.get('/ceo-stats', async (c) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    // EXCLUSIVE end of last month = 1st of the current month. (Using day 0 of
    // the current month cut off the whole final day of last month.)
    const lastMonthEnd = monthStart;

    const tenantsTotal = await pool.query('SELECT COUNT(*) FROM tenants');
    const tenantsActive = await pool.query("SELECT COUNT(*) FROM tenant_subscriptions WHERE status = 'active'");
    const tenantsNew = await pool.query('SELECT COUNT(*) FROM tenants WHERE created_at >= $1', [monthStart]);
    const revenueThis = await pool.query("SELECT COALESCE(SUM(amount_tzs), 0) AS sum FROM subscription_payments WHERE paid_at >= $1 AND status = 'completed'", [monthStart]);
    const revenueLast = await pool.query("SELECT COALESCE(SUM(amount_tzs), 0) AS sum FROM subscription_payments WHERE paid_at >= $1 AND paid_at < $2 AND status = 'completed'", [lastMonthStart, lastMonthEnd]);
    // ── Sales outlier threshold ───────────────────────────────────────────────
    // Sales above this amount are excluded from the "clean" (realistic) totals
    // so one mistyped/abnormal sale can never distort the dashboard. Raw totals
    // stay visible next to the clean ones. Adjustable via ?outlier_threshold=
    // or the saved dashboard setting (default TZS 50,000,000).
    let outlierThreshold = Number(c.req.query('outlier_threshold')) || 0;
    if (!outlierThreshold) {
      try {
        const s = await pool.query(`SELECT value FROM settings WHERE key = 'dashboard' AND shop_id IS NULL LIMIT 1`);
        const v = s.rows[0]?.value;
        const parsed = typeof v === 'string' ? JSON.parse(v) : v;
        outlierThreshold = Number(parsed?.sales_outlier_threshold) || 0;
      } catch { /* fall back to default below */ }
    }
    if (!outlierThreshold || outlierThreshold < 0) outlierThreshold = 50_000_000;

    const salesToday = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total,
              COALESCE(SUM(total_amount) FILTER (WHERE total_amount <= $1), 0) as clean_total,
              COUNT(*) FILTER (WHERE total_amount > $1) as outlier_cnt
       FROM sales WHERE created_at >= CURRENT_DATE`, [outlierThreshold]);
    const sales24h = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total,
              COALESCE(SUM(total_amount) FILTER (WHERE total_amount <= $1), 0) as clean_total,
              COUNT(*) FILTER (WHERE total_amount > $1) as outlier_cnt
       FROM sales WHERE created_at >= NOW() - INTERVAL '24 hours'`, [outlierThreshold]);
    const salesMonth = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total,
              COALESCE(SUM(total_amount) FILTER (WHERE total_amount <= $1), 0) as clean_total,
              COUNT(*) FILTER (WHERE total_amount > $1) as outlier_cnt,
              COALESCE(SUM(total_amount) FILTER (WHERE total_amount > $1), 0) as outlier_sum
       FROM sales WHERE created_at >= $2`, [outlierThreshold, monthStart]);
    const usersTotal = await pool.query('SELECT COUNT(*) FROM "user"');
    const shopsTotal = await pool.query('SELECT COUNT(*) FROM shops');
    const productsTotal = await pool.query('SELECT COUNT(*) FROM products');
    const topTenants = await pool.query(`
      SELECT t.name, t.email,
        COALESCE((SELECT SUM(sp.amount_tzs) FROM subscription_payments sp WHERE sp.tenant_id = t.id AND sp.status = 'completed'), 0) as revenue,
        (SELECT COUNT(*) FROM sales sa JOIN shops s ON s.id = sa.shop_id WHERE s.tenant_id = t.id) as total_sales
      FROM tenants t ORDER BY revenue DESC LIMIT 10`);
    const growthTrends = await pool.query("SELECT DATE(created_at) as date, COUNT(*) as new_tenants FROM tenants WHERE created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date DESC");

    const revenueLastSum = parseFloat(revenueLast.rows[0].sum);
    const revenueThisSum = parseFloat(revenueThis.rows[0].sum);
    let mrrGrowthCalc = 'N/A';
    if (revenueLastSum > 0) {
      const diff = revenueThisSum - revenueLastSum;
      mrrGrowthCalc = ((diff / revenueLastSum) * 100).toFixed(1) + '%';
    }

    // Subscription stats
    const activeSubs = await pool.query("SELECT COUNT(*) FROM tenant_subscriptions WHERE status = 'active'");
    const expiringSoon = await pool.query("SELECT COUNT(*) FROM tenant_subscriptions WHERE status = 'active' AND current_period_end <= NOW() + INTERVAL '7 days' AND current_period_end > NOW()");
    const expiredSubs = await pool.query("SELECT COUNT(*) FROM tenant_subscriptions WHERE status = 'active' AND current_period_end < NOW()");
    const totalRevenue = await pool.query("SELECT COALESCE(SUM(amount_tzs), 0) AS sum FROM subscription_payments WHERE status = 'completed'");

    // ── SMS reseller + all-shops usage analytics ─────────────────────────────
    // SMS money raised this month (and last month) + profit, eHub wallet float,
    // all-shops sales totals, and shop/SMS activity to compare month over month.
    const smsRevenueMonth = await pool.query(
      `SELECT COALESCE(SUM(amount_tzs), 0) AS revenue, COALESCE(SUM(credits), 0) AS credits,
              COALESCE(SUM(credits) FILTER (WHERE COALESCE(amount_tzs, 0) > 0), 0) AS credits_paid,
              COALESCE(SUM(credits) FILTER (WHERE COALESCE(amount_tzs, 0) = 0), 0) AS credits_free
       FROM sms_transactions WHERE type = 'credit' AND status = 'completed' AND created_at >= $1`, [monthStart]);
    const smsRevenueLastMonth = await pool.query(
      `SELECT COALESCE(SUM(amount_tzs), 0) AS revenue, COALESCE(SUM(credits), 0) AS credits,
              COALESCE(SUM(credits) FILTER (WHERE COALESCE(amount_tzs, 0) > 0), 0) AS credits_paid,
              COALESCE(SUM(credits) FILTER (WHERE COALESCE(amount_tzs, 0) = 0), 0) AS credits_free
       FROM sms_transactions WHERE type = 'credit' AND status = 'completed' AND created_at >= $1 AND created_at < $2`, [lastMonthStart, lastMonthEnd]);
    const smsCostMonth = await pool.query(
      `SELECT COALESCE(SUM(amount_tzs), 0) AS cost, COALESCE(SUM(sms_quantity), 0) AS qty
       FROM sms_provider_ledger WHERE type = 'spend' AND created_at >= $1`, [monthStart]);
    const smsCostLastMonth = await pool.query(
      `SELECT COALESCE(SUM(amount_tzs), 0) AS cost, COALESCE(SUM(sms_quantity), 0) AS qty
       FROM sms_provider_ledger WHERE type = 'spend' AND created_at >= $1 AND created_at < $2`, [lastMonthStart, lastMonthEnd]);
    const providerWallet = await getProviderWalletStatus().catch(() => null);

    const salesAllTime = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS cnt,
              COALESCE(SUM(total_amount) FILTER (WHERE total_amount <= $1), 0) AS clean_total,
              COUNT(*) FILTER (WHERE total_amount > $1) AS outlier_cnt,
              COALESCE(SUM(total_amount) FILTER (WHERE total_amount > $1), 0) AS outlier_sum
       FROM sales`, [outlierThreshold]);
    const salesLastMonth = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS cnt,
              COALESCE(SUM(total_amount) FILTER (WHERE total_amount <= $1), 0) AS clean_total,
              COUNT(*) FILTER (WHERE total_amount > $1) AS outlier_cnt
       FROM sales WHERE created_at >= $2 AND created_at < $3`, [outlierThreshold, lastMonthStart, lastMonthEnd]);
    // Biggest sales this month: lets the developer instantly spot a mistyped
    // amount (one bad entry can distort the all-shops totals).
    const salesTopMonth = await pool.query(
      `SELECT s.id, s.total_amount, s.created_at, s.customer_name, s.payment_method, sh.name AS shop_name
       FROM sales s JOIN shops sh ON sh.id = s.shop_id
       WHERE s.created_at >= $1
       ORDER BY s.total_amount DESC
       LIMIT 5`, [monthStart]);
    const activeShopsMonth = await pool.query(`SELECT COUNT(DISTINCT shop_id) AS cnt FROM sales WHERE created_at >= $1`, [monthStart]);
    const activeShopsLastMonth = await pool.query(`SELECT COUNT(DISTINCT shop_id) AS cnt FROM sales WHERE created_at >= $1 AND created_at < $2`, [lastMonthStart, lastMonthEnd]);
    const newShopsMonth = await pool.query(`SELECT COUNT(*) AS cnt FROM shops WHERE created_at >= $1`, [monthStart]);
    const smsSentMonth = await pool.query(`SELECT COUNT(*) AS cnt FROM sms_messages WHERE status <> 'failed' AND created_at >= $1`, [monthStart]);
    const smsSentLastMonth = await pool.query(`SELECT COUNT(*) AS cnt FROM sms_messages WHERE status <> 'failed' AND created_at >= $1 AND created_at < $2`, [lastMonthStart, lastMonthEnd]);
    // Last 6 months of shop activity + SMS usage for the trend graph. `sales`
    // is the CLEAN monthly total (outlier sales excluded) while `sales_raw`
    // keeps the untrimmed sum for the tooltip.
    const monthlyActivity = await pool.query(`
      SELECT to_char(m.month, 'YYYY-MM') AS month,
             COALESCE(s.clean_total, 0) AS sales, COALESCE(s.total, 0) AS sales_raw,
             COALESCE(s.cnt, 0) AS orders, COALESCE(sm.cnt, 0) AS sms
      FROM generate_series(date_trunc('month', NOW()) - INTERVAL '5 months', date_trunc('month', NOW()), INTERVAL '1 month') AS m(month)
      LEFT JOIN (
        SELECT date_trunc('month', created_at) AS month,
               SUM(total_amount) AS total,
               SUM(total_amount) FILTER (WHERE total_amount <= $1) AS clean_total,
               COUNT(*) AS cnt
        FROM sales GROUP BY 1
      ) s ON s.month = m.month
      LEFT JOIN (
        SELECT date_trunc('month', created_at) AS month, COUNT(*) AS cnt
        FROM sms_messages WHERE status <> 'failed' GROUP BY 1
      ) sm ON sm.month = m.month
      ORDER BY 1`, [outlierThreshold]);

    const smsMonthRevenue = parseFloat(smsRevenueMonth.rows[0].revenue);
    const smsMonthCost = parseFloat(smsCostMonth.rows[0].cost);
    const smsLastMonthRevenue = parseFloat(smsRevenueLastMonth.rows[0].revenue);
    const smsLastMonthCost = parseFloat(smsCostLastMonth.rows[0].cost);

    // Pricing + margin, and where the money actually is (credits still unused
    // in shop balances = stock, NOT a loss).
    const resellerSettings = await getResellerSettings();
    const pricePerSms = Number(resellerSettings.price_per_sms) || 0;
    const costPerSms = Number(resellerSettings.provider_cost) || 0;
    const marginPerSms = pricePerSms - costPerSms;
    const smsSentMonthCount = parseInt(smsSentMonth.rows[0].cnt);
    const smsSentLastMonthCount = parseInt(smsSentLastMonth.rows[0].cnt);
    const stockRes = await pool.query(`SELECT COALESCE(SUM(balance), 0)::int AS credits FROM sms_accounts`);
    const stockCredits = parseInt(stockRes.rows[0].credits) || 0;

    return c.json({
      success: true,
      data: {
        overview: {
          totalTenants: parseInt(tenantsTotal.rows[0].count),
          activeTenants: parseInt(tenantsActive.rows[0].count),
          newThisMonth: parseInt(tenantsNew.rows[0].count),
          churnedThisMonth: 0,
          churnRate: '0%',
          mrr: revenueThisSum || 0,
          mrrGrowth: mrrGrowthCalc,
        },
        sales: {
          today: {
            count: parseInt(salesToday.rows[0].cnt),
            revenue: parseFloat(salesToday.rows[0].total),
            cleanRevenue: parseFloat(salesToday.rows[0].clean_total),
            outlierCount: parseInt(salesToday.rows[0].outlier_cnt),
          },
          last24h: {
            count: parseInt(sales24h.rows[0].cnt),
            revenue: parseFloat(sales24h.rows[0].total),
            cleanRevenue: parseFloat(sales24h.rows[0].clean_total),
            outlierCount: parseInt(sales24h.rows[0].outlier_cnt),
          },
          thisMonth: {
            count: parseInt(salesMonth.rows[0].cnt),
            revenue: parseFloat(salesMonth.rows[0].total),
            cleanRevenue: parseFloat(salesMonth.rows[0].clean_total),
            outlierCount: parseInt(salesMonth.rows[0].outlier_cnt),
          },
        },
        totals: {
          users: parseInt(usersTotal.rows[0].count),
          shops: parseInt(shopsTotal.rows[0].count),
          products: parseInt(productsTotal.rows[0].count),
        },
        topTenants: topTenants.rows.map((r: any) => ({ name: r.name, email: r.email, revenue: parseFloat(r.revenue), sales: parseInt(r.total_sales) })),
        growthTrends: growthTrends.rows.map((r: any) => ({ date: r.date, newTenants: parseInt(r.new_tenants) })),
        monthlyRevenue: [],
        stats: {
          totalRevenue: parseFloat(totalRevenue.rows[0].sum),
          total_revenue: parseFloat(totalRevenue.rows[0].sum),
          monthlyRevenue: revenueThisSum,
          monthly_revenue: revenueThisSum,
          totalTenants: parseInt(tenantsTotal.rows[0].count),
          total_tenants: parseInt(tenantsTotal.rows[0].count),
          totalUsers: parseInt(usersTotal.rows[0].count),
          total_users: parseInt(usersTotal.rows[0].count),
          totalShops: parseInt(shopsTotal.rows[0].count),
          total_shops: parseInt(shopsTotal.rows[0].count),
          activeSubscriptions: parseInt(activeSubs.rows[0].count),
          active_subscriptions: parseInt(activeSubs.rows[0].count),
          salesLast24h: parseInt(sales24h.rows[0].cnt),
          sales_last_24h: parseInt(sales24h.rows[0].cnt),
          sales24hRevenue: parseFloat(sales24h.rows[0].total),
          expiringSoon: parseInt(expiringSoon.rows[0].count),
          expiring_soon: parseInt(expiringSoon.rows[0].count),
          expiredSubs: parseInt(expiredSubs.rows[0].count),
          expired_subs: parseInt(expiredSubs.rows[0].count),
        },
        // SMS reseller: money raised + profit this month (vs last month) and
        // the eHub wallet float so the developer can top up before users buy.
        sms: {
          wallet: providerWallet ? {
            sms: providerWallet.sms_balance,
            tzs: providerWallet.tzs_balance,
            low: providerWallet.low,
            critical: providerWallet.critical,
            threshold_tzs: providerWallet.threshold_tzs,
            cost_per_sms: providerWallet.cost_per_sms,
            reachable: providerWallet.reachable,
          } : null,
          month: {
            revenue: smsMonthRevenue,
            cost: smsMonthCost,
            profit: smsMonthRevenue - smsMonthCost,
            credits: parseInt(smsRevenueMonth.rows[0].credits),
            paidCredits: parseInt(smsRevenueMonth.rows[0].credits_paid),
            freeCredits: parseInt(smsRevenueMonth.rows[0].credits_free),
            sent: smsSentMonthCount,
            marginOnSent: smsSentMonthCount * marginPerSms,
          },
          lastMonth: {
            revenue: smsLastMonthRevenue,
            cost: smsLastMonthCost,
            profit: smsLastMonthRevenue - smsLastMonthCost,
            credits: parseInt(smsRevenueLastMonth.rows[0].credits),
            paidCredits: parseInt(smsRevenueLastMonth.rows[0].credits_paid),
            freeCredits: parseInt(smsRevenueLastMonth.rows[0].credits_free),
            sent: smsSentLastMonthCount,
            marginOnSent: smsSentLastMonthCount * marginPerSms,
          },
          // Pricing + where the money is: unused credits are stock, not loss.
          pricing: { price: pricePerSms, cost: costPerSms, margin: marginPerSms },
          stock: {
            credits: stockCredits,
            cost: stockCredits * costPerSms,
            value: stockCredits * pricePerSms,
          },
        },
        // All-shops sales. `clean*` excludes sales above the outlier threshold
        // (default TZS 50M) so the dashboard shows a realistic business volume;
        // the raw totals remain available for transparency.
        salesTotals: {
          outlierThreshold,
          allTime: {
            total: parseFloat(salesAllTime.rows[0].total),
            count: parseInt(salesAllTime.rows[0].cnt),
            cleanTotal: parseFloat(salesAllTime.rows[0].clean_total),
            outlierCount: parseInt(salesAllTime.rows[0].outlier_cnt),
            outlierSum: parseFloat(salesAllTime.rows[0].outlier_sum),
          },
          month: {
            total: parseFloat(salesMonth.rows[0].total),
            count: parseInt(salesMonth.rows[0].cnt),
            cleanTotal: parseFloat(salesMonth.rows[0].clean_total),
            outlierCount: parseInt(salesMonth.rows[0].outlier_cnt),
            outlierSum: parseFloat(salesMonth.rows[0].outlier_sum),
          },
          lastMonth: {
            total: parseFloat(salesLastMonth.rows[0].total),
            count: parseInt(salesLastMonth.rows[0].cnt),
            cleanTotal: parseFloat(salesLastMonth.rows[0].clean_total),
            outlierCount: parseInt(salesLastMonth.rows[0].outlier_cnt),
          },
          topThisMonth: salesTopMonth.rows.map((r: any) => ({
            id: r.id,
            amount: parseFloat(r.total_amount) || 0,
            created_at: r.created_at,
            customer_name: r.customer_name,
            payment_method: r.payment_method,
            shop_name: r.shop_name,
          })),
        },
        // Shop activity + SMS usage to see how the system is used, compared
        // with last month → tells the developer where to push adoption.
        usage: {
          activeShopsMonth: parseInt(activeShopsMonth.rows[0].cnt),
          activeShopsLastMonth: parseInt(activeShopsLastMonth.rows[0].cnt),
          newShopsMonth: parseInt(newShopsMonth.rows[0].cnt),
          smsSentMonth: parseInt(smsSentMonth.rows[0].cnt),
          smsSentLastMonth: parseInt(smsSentLastMonth.rows[0].cnt),
          monthly: monthlyActivity.rows.map((r: any) => ({
            month: r.month,
            sales: Number(r.sales) || 0,
            salesRaw: Number(r.sales_raw) || 0,
            orders: Number(r.orders) || 0,
            sms: Number(r.sms) || 0,
          })),
        },
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: save the dashboard's sales outlier threshold (TZS). Sales above
// it are excluded from the "clean" (realistic) totals; raw totals stay visible.
router.put('/sales-outlier-threshold', async (c: any) => {
  try {
    const { threshold } = await c.req.json().catch(() => ({}));
    const value = Math.max(0, Math.round(Number(threshold) || 0)) || 50_000_000;
    let current: any = {};
    try {
      const s = await pool.query(`SELECT value FROM settings WHERE key = 'dashboard' AND shop_id IS NULL LIMIT 1`);
      const v = s.rows[0]?.value;
      current = (typeof v === 'string' ? JSON.parse(v) : v) || {};
    } catch { current = {}; }
    const merged = { ...(current || {}), sales_outlier_threshold: value };
    await pool.query(`DELETE FROM settings WHERE key = 'dashboard' AND shop_id IS NULL`);
    await pool.query(`INSERT INTO settings (key, value) VALUES ('dashboard', $1)`, [JSON.stringify(merged)]);
    return c.json({ success: true, data: { sales_outlier_threshold: value }, message: `Outlier threshold saved: TZS ${value.toLocaleString()}` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// AI Marketing Advisor
router.get('/ai-advisor', async (c) => {
  try {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [tenantsTotal, activeSubs, expiringSoon, expiredSubs, revenueTotal, revenueMonthly,
      usersTotal, shopsTotal, productsTotal, salesToday, salesMonth, signups24h,
      recentSignups, campaignsSent, trialUsers] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM tenants'),
      pool.query("SELECT COUNT(*) FROM tenant_subscriptions WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) FROM tenant_subscriptions WHERE status = 'active' AND current_period_end <= NOW() + INTERVAL '7 days' AND current_period_end > NOW()"),
      pool.query("SELECT COUNT(*) FROM tenant_subscriptions WHERE status = 'active' AND current_period_end < NOW()"),
      pool.query("SELECT COALESCE(SUM(amount_tzs), 0) AS sum FROM subscription_payments WHERE status = 'completed'"),
      pool.query("SELECT COALESCE(SUM(amount_tzs), 0) AS sum FROM subscription_payments WHERE paid_at >= $1 AND status = 'completed'", [monthStart]),
      pool.query('SELECT COUNT(*) FROM "user"'),
      pool.query('SELECT COUNT(*) FROM shops'),
      pool.query('SELECT COUNT(*) FROM products'),
      pool.query("SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total FROM sales WHERE created_at >= CURRENT_DATE"),
      pool.query("SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total FROM sales WHERE created_at >= $1", [monthStart]),
      pool.query(`SELECT COUNT(*) FROM "user" WHERE created_at >= NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*) FROM "user" WHERE created_at >= NOW() - INTERVAL '24 hours'`),
      pool.query("SELECT COALESCE(SUM(sent_count), 0) AS sum FROM email_campaigns WHERE created_at >= $1", [monthStart]),
      pool.query("SELECT COUNT(*) FROM tenants WHERE trial_activated = true AND trial_end > NOW()"),
    ]);

    const totalTenants = parseInt(tenantsTotal.rows[0].count);
    const activeSubsCount = parseInt(activeSubs.rows[0].count);
    const expiringSoonCount = parseInt(expiringSoon.rows[0].count);
    const expiredSubsCount = parseInt(expiredSubs.rows[0].count);
    const totalRevenue = parseFloat(revenueTotal.rows[0].sum);
    const monthlyRevenue = parseFloat(revenueMonthly.rows[0].sum);
    const totalUsers = parseInt(usersTotal.rows[0].count);
    const totalShops = parseInt(shopsTotal.rows[0].count);
    const totalProducts = parseInt(productsTotal.rows[0].count);
    const salesTodayCount = parseInt(salesToday.rows[0].cnt);
    const salesTodayRevenue = parseFloat(salesToday.rows[0].total);
    const salesMonthCount = parseInt(salesMonth.rows[0].cnt);
    const salesMonthRevenue = parseFloat(salesMonth.rows[0].total);
    const newSignups24h = parseInt(signups24h.rows[0].count);
    const emailCampaignsSent = parseInt(campaignsSent.rows[0].sum);
    const activeTrials = parseInt(trialUsers.rows[0].count);
    const conversionRate = totalTenants > 0 ? Math.round((activeSubsCount / totalTenants) * 100) : 0;

    const systemData = {
      totalTenants,
      activeSubscriptions: activeSubsCount,
      expiringSoon: expiringSoonCount,
      expiredSubs: expiredSubsCount,
      totalRevenue,
      monthlyRevenue,
      totalUsers,
      totalShops,
      totalProducts,
      salesToday: { count: salesTodayCount, revenue: salesTodayRevenue },
      salesThisMonth: { count: salesMonthCount, revenue: salesMonthRevenue },
      newSignupsLast24h: newSignups24h,
      emailCampaignsSentThisMonth: emailCampaignsSent,
      activeTrials,
      subscriptionConversionRate: conversionRate + '%',
    };

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({
        success: true,
        data: { sections: [{ emoji: '💡', label: 'Setup Required', content: 'DeepSeek API key not configured. Set DEEPSEEK_API_KEY environment variable to enable AI marketing advisor.' }], stats: systemData }
      });
    }

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are an expert business and marketing advisor for ALFEAN ENTERPRISES, a POS and business management system for hardware stores in Tanzania.

Your role: Analyze the system data provided and give concise, actionable marketing advice to help the business owner maximize:
1. Customer acquisition (more signups and trials)
2. Subscription conversions (trial → paid)
3. Revenue growth
4. User engagement and awareness

Your advice must be:
- Practical for the Tanzanian market (M-Pesa, simu, word-of-mouth, social media)
- Specific to the numbers provided (reference actual data)
- Under 200 words total
- Split into 3 clear sections

CRITICAL: Return ONLY valid JSON with this exact structure — no markdown, no code blocks, no extra text:
{"sections":[{"emoji":"🔍","label":"Key Insight","content":"..."},{"emoji":"💡","label":"Recommendation","content":"..."},{"emoji":"📈","label":"Expected Impact","content":"..."}]}

Use simple English with some Swahili where natural (e.g., "Wateja", "Lipa kwa Mwezi", "Habari").
Be direct and actionable — no fluff.`
          },
          {
            role: 'user',
            content: `Here is the current system data for ALFEAN ENTERPRISES:

TENANTS & SUBSCRIPTIONS:
- Total tenants registered: ${systemData.totalTenants}
- Active subscriptions (paid): ${systemData.activeSubscriptions}
- Active free trials: ${systemData.activeTrials}
- Expiring within 7 days: ${systemData.expiringSoon}
- Expired subscriptions: ${systemData.expiredSubs}
- Subscription conversion rate: ${systemData.subscriptionConversionRate}

REVENUE:
- Total all-time revenue: TZS ${systemData.totalRevenue.toLocaleString()}
- Monthly revenue: TZS ${systemData.monthlyRevenue.toLocaleString()}

USERS & ACTIVITY:
- Total users: ${systemData.totalUsers}
- Total shops: ${systemData.totalShops}
- Total products: ${systemData.totalProducts}
- New signups (last 24h): ${systemData.newSignupsLast24h}
- Sales today: ${systemData.salesToday.count} transactions, TZS ${systemData.salesToday.revenue.toLocaleString()}
- Sales this month: ${systemData.salesThisMonth.count} transactions, TZS ${systemData.salesThisMonth.revenue.toLocaleString()}

EMAIL MARKETING:
- Email campaigns sent this month: ${systemData.emailCampaignsSentThisMonth}

PRICING (TZS):
- Basic: 15,000/month | 3-Month: 40,500 | 6-Month: 72,000 | Annual: 120,000

Give me actionable marketing advice to grow the business.`
          }
        ],
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Advisor] DeepSeek API error:', response.status, errorText);
      return c.json({ success: true, data: { sections: [{ emoji: '💡', label: 'Advice', content: 'AI advisor temporarily unavailable. Please try again later.' }], stats: systemData } });
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    let sections = [];
    try {
      const parsed = JSON.parse(content);
      sections = parsed.sections || [];
    } catch {
      // Fallback: wrap raw text as single section
      sections = [{ emoji: '💡', label: 'Advice', content }];
    }

    return c.json({ success: true, data: { sections, stats: systemData } });
  } catch (e: any) {
    console.error('[AI Advisor] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// AI Advisor follow-up question
router.post('/ai-advisor/ask', async (c) => {
  try {
    const { question } = await c.req.json();
    if (!question) return c.json({ success: false, error: 'Question is required' }, 400);

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return c.json({ success: true, data: { answer: 'DeepSeek API key not configured.' } });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          {
            role: 'system',
            content: `You are an expert business advisor for ALFEAN ENTERPRISES, a POS system for hardware stores in Tanzania. Answer concisely with practical, actionable advice. Use simple English with some Swahili where natural. Keep responses under 150 words.`
          },
          { role: 'user', content: question }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Advisor Ask] Error:', response.status, errorText);
      return c.json({ success: true, data: { answer: 'AI temporarily unavailable. Try again.' } });
    }

    const data: any = await response.json();
    const answer = data.choices?.[0]?.message?.content || 'No response.';
    return c.json({ success: true, data: { answer } });
  } catch (e: any) {
    console.error('[AI Advisor Ask] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── DEPENDENCIES & UPDATE CHECK ─────────────────────────────────────────────
// Lists every npm package used by the backend and the client, shows the
// installed version and the latest version on the npm registry so the
// developer is reminded to update. Results are cached for 6 hours
// (?refresh=1 forces a fresh check).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type DependencyInfo = {
  name: string;
  project: 'backend' | 'client';
  type: 'dependency' | 'devDependency';
  declared: string;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  updateType: 'major' | 'minor' | 'patch' | null;
};

let depsCache: { at: number; payload: any } | null = null;
let depsAnalysisCache: { at: number; payload: any } | null = null;
const DEPS_CACHE_MS = 6 * 60 * 60 * 1000;

function cleanVersion(v: any): string {
  return String(v || '').replace(/^[\^~>=<v\s]+/, '').split(' ')[0].trim();
}

function versionParts(v: string): number[] {
  return cleanVersion(v).split('.').map(n => parseInt(n, 10) || 0);
}

function updateKind(current: string, latest: string): 'major' | 'minor' | 'patch' | null {
  const c = versionParts(current);
  const l = versionParts(latest);
  if (!l[0]) return null;
  if (l[0] !== c[0]) return 'major';
  if (l[1] !== c[1]) return 'minor';
  if (l[2] !== c[2]) return 'patch';
  return null;
}

async function fetchLatestVersion(name: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.version || null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function readProjectDependencies(
  project: 'backend' | 'client',
  manifestPath: string,
  lockPath: string | null,
  nodeModulesDir: string | null,
): DependencyInfo[] {
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  let lockVersions: Record<string, string> = {};
  if (lockPath) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      for (const [key, value] of Object.entries(lock.packages || {})) {
        if (key.startsWith('node_modules/') && (value as any)?.version) {
          lockVersions[key.replace('node_modules/', '')] = (value as any).version;
        }
      }
    } catch {}
  }

  const out: DependencyInfo[] = [];
  const groups: [DependencyInfo['type'], Record<string, string>][] = [
    ['dependency', pkg.dependencies || {}],
    ['devDependency', pkg.devDependencies || {}],
  ];

  for (const [type, deps] of groups) {
    for (const [name, declared] of Object.entries(deps)) {
      let current: string | null = null;
      if (nodeModulesDir) {
        try {
          const installed = JSON.parse(fs.readFileSync(path.join(nodeModulesDir, name, 'package.json'), 'utf-8'));
          current = installed.version || null;
        } catch {}
      }
      if (!current && lockVersions[name]) current = lockVersions[name];
      out.push({
        name,
        project,
        type,
        declared,
        current: current || cleanVersion(declared),
        latest: null,
        updateAvailable: false,
        updateType: null,
      });
    }
  }
  return out;
}

async function gatherDependencies(force: boolean) {
    if (!force && depsCache && Date.now() - depsCache.at < DEPS_CACHE_MS) {
      return depsCache.payload;
    }

    // Backend root works in dev (src/modules/admin) and production (dist/modules/admin).
    const backendRoot = path.resolve(__dirname, '../../..');
    const all: DependencyInfo[] = [];
    const sources: string[] = [];

    try {
      all.push(...readProjectDependencies(
        'backend',
        path.join(backendRoot, 'package.json'),
        path.join(backendRoot, 'package-lock.json'),
        path.join(backendRoot, 'node_modules'),
      ));
      sources.push('backend');
    } catch (e: any) {
      console.warn('[Dependencies] backend read failed:', e.message);
    }

    // Client manifest: dev repo path, or the copy baked into the Docker image.
    const clientCandidates = [
      { manifest: path.resolve(backendRoot, '..', 'client', 'package.json'), lock: path.resolve(backendRoot, '..', 'client', 'package-lock.json'), nodeModules: path.resolve(backendRoot, '..', 'client', 'node_modules') },
      { manifest: path.resolve(process.cwd(), 'client-package.json'), lock: path.resolve(process.cwd(), 'client-package-lock.json'), nodeModules: null as string | null },
      { manifest: path.resolve(backendRoot, '..', 'client-package.json'), lock: path.resolve(backendRoot, '..', 'client-package-lock.json'), nodeModules: null as string | null },
    ];
    for (const candidate of clientCandidates) {
      try {
        if (!fs.existsSync(candidate.manifest)) continue;
        all.push(...readProjectDependencies(
          'client',
          candidate.manifest,
          fs.existsSync(candidate.lock) ? candidate.lock : null,
          candidate.nodeModules && fs.existsSync(candidate.nodeModules) ? candidate.nodeModules : null,
        ));
        sources.push('client');
        break;
      } catch (e: any) {
        console.warn('[Dependencies] client read failed:', e.message);
      }
    }

    const latestResults = await mapWithConcurrency(all, 8, async (dep) => ({
      name: dep.name,
      latest: await fetchLatestVersion(dep.name),
    }));
    const latestMap = new Map(latestResults.map(r => [r.name, r.latest]));

    let registryAvailable = false;
    for (const dep of all) {
      const latest = latestMap.get(dep.name) || null;
      dep.latest = latest;
      if (latest) registryAvailable = true;
      if (latest && dep.current) {
        const kind = updateKind(dep.current, latest);
        if (kind) {
          dep.updateAvailable = true;
          dep.updateType = kind;
        }
      }
    }

    all.sort((a, b) =>
      Number(b.updateAvailable) - Number(a.updateAvailable) ||
      (a.updateType === 'major' ? -1 : b.updateType === 'major' ? 1 : 0) ||
      a.project.localeCompare(b.project) ||
      a.name.localeCompare(b.name)
    );

    const payload = {
      checkedAt: new Date().toISOString(),
      registryAvailable,
      sources,
      dependencies: all,
      summary: {
        total: all.length,
        updates: all.filter(d => d.updateAvailable).length,
        major: all.filter(d => d.updateType === 'major').length,
        backend: all.filter(d => d.project === 'backend').length,
        client: all.filter(d => d.project === 'client').length,
      },
    };

    depsCache = { at: Date.now(), payload };
    depsAnalysisCache = null;
    return payload;
}

router.get('/dependencies', async (c) => {
  try {
    const force = c.req.query('refresh') === '1';
    const payload = await gatherDependencies(force);
    return c.json({ success: true, data: payload });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// AI upgrade plan: prioritises the outdated packages, flags breaking changes
// and produces ready-to-copy npm install commands per project.
function fallbackAnalysis(outdated: DependencyInfo[]) {
  const commandsFor = (project: 'backend' | 'client') =>
    outdated.filter(d => d.project === project).map(d => `npm install ${d.name}@${d.latest}`);
  const priorities = outdated.map(d => ({
    package: d.name,
    project: d.project,
    urgency: d.updateType === 'major' ? 'high' : d.updateType === 'minor' ? 'medium' : 'low',
    risk: d.updateType === 'major' ? 'breaking' : d.updateType === 'minor' ? 'review' : 'safe',
    reason: d.updateType === 'major'
      ? `Major jump ${d.current} → ${d.latest}; may require code changes.`
      : d.updateType === 'minor'
        ? `New features, usually backward compatible (${d.current} → ${d.latest}).`
        : `Patch/bug fixes (${d.current} → ${d.latest}).`,
    command: `npm install ${d.name}@${d.latest}`,
  }));
  return {
    overview: outdated.length === 0
      ? 'All packages are up to date. Nothing to install.'
      : `${outdated.length} package(s) have newer versions. Patch and minor updates are usually safe; review major versions before installing.`,
    priorities,
    commands: { backend: commandsFor('backend'), client: commandsFor('client') },
    notes: 'Run each command inside backend/ or client/, then rebuild and restart the app. AI analysis was unavailable, so this is the automatic plan.',
    generatedBy: 'fallback',
  };
}

router.post('/dependencies/analyze', async (c) => {
  try {
    if (depsAnalysisCache && Date.now() - depsAnalysisCache.at < DEPS_CACHE_MS) {
      return c.json({ success: true, data: depsAnalysisCache.payload });
    }

    const payload = await gatherDependencies(false);
    const outdated: DependencyInfo[] = payload.dependencies.filter((d: DependencyInfo) => d.updateAvailable);
    const apiKey = process.env.DEEPSEEK_API_KEY;
    let analysis: any = null;

    if (apiKey && outdated.length > 0) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);
        const list = outdated
          .map(d => `${d.name} (${d.project}, ${d.type}): ${d.current} -> ${d.latest} [${d.updateType}]`)
          .join('\n');

        const res = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'You are a senior Node.js/React maintainer. Return ONLY valid JSON.' },
              {
                role: 'user',
                content: `The ALFEAN ENTERPRISES system uses a Hono + Drizzle + PostgreSQL backend and a React 18 + Vite + Tailwind client. These packages are outdated:\n\n${list}\n\nProduce a concise upgrade plan for the developer.\nReturn ONLY JSON with this exact shape:\n{"overview":"2-3 sentences in simple English","priorities":[{"package":"name","project":"backend|client","urgency":"high|medium|low","risk":"safe|review|breaking","reason":"one short sentence","command":"npm install name@latest"}],"commands":{"backend":["npm install name@version"],"client":["npm install name@version"]},"notes":"short notes about major versions needing code changes, testing, and build order"}\nRules: include EVERY outdated package exactly once in priorities; commands must use the exact latest version; keep reasons under 15 words; no markdown.`,
              },
            ],
            max_tokens: 2500,
            temperature: 0.3,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          const data: any = await res.json();
          const content = data.choices?.[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed?.priorities) && parsed?.commands) {
              analysis = { ...parsed, generatedBy: 'ai' };
            }
          }
        }
      } catch (e: any) {
        console.warn('[Dependencies] AI analysis failed:', e.message);
      }
    }

    if (!analysis) analysis = fallbackAnalysis(outdated);
    const result = { ...analysis, checkedAt: payload.checkedAt, outdatedCount: outdated.length };
    depsAnalysisCache = { at: Date.now(), payload: result };
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Settings
router.get('/settings', async (c) => {
  const data = await cache.getOrSet(
    'system:settings',
    async () => {
      const result = await pool.query(`SELECT key, value FROM system_settings ORDER BY key`);
      const settings: Record<string, any> = {};
      for (const row of result.rows) {
        try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
      }
      return settings;
    },
    600 // 10 minutes
  );
  return c.json({ success: true, data });
});

router.put('/settings', async (c) => {
  const updates = await c.req.json();
  const userId = c.get('userId');
  for (const [key, value] of Object.entries(updates)) {
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`, [key, JSON.stringify(value)]);
  }
  cache.invalidate('system:settings');
  if (userId) {
    await pool.query(`INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'update_settings', $2)`, [userId, JSON.stringify({ keys: Object.keys(updates) })]);
  }
  return c.json({ success: true });
});

// Feature Flags
router.get('/features', async (c) => {
  const result = await cache.getOrSet(
    'system:features',
    () => pool.query(`SELECT * FROM feature_flags ORDER BY feature_key`),
    300 // 5 minutes
  );
  return c.json({ success: true, data: result.rows });
});

router.put('/features/:key', async (c) => {
  const key = c.req.param('key');
  const userId = c.get('userId');
  const { enabled, rollout_percent } = await c.req.json();
  const result = await pool.query(`INSERT INTO feature_flags (feature_key, enabled, rollout_percent) VALUES ($1, $2, $3) ON CONFLICT (feature_key) DO UPDATE SET enabled = $2, rollout_percent = $3, updated_at = NOW() RETURNING *`, [key, enabled, rollout_percent ?? 0]);
  cache.invalidate('system:features');
  if (userId) {
    await pool.query(`INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'update_feature_flag', $2)`, [userId, JSON.stringify({ key, enabled, rollout_percent })]);
  }
  return c.json({ success: true, data: result.rows[0] });
});

// Audit Logs
router.get('/audit-logs', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = (page - 1) * limit;
  const result = await pool.query(`SELECT aal.*, u.email as admin_email, t.name as tenant_name FROM admin_audit_log aal LEFT JOIN "user" u ON u.id = aal.admin_id LEFT JOIN tenants t ON t.id = aal.target_tenant_id ORDER BY aal.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  return c.json({ success: true, data: result.rows, pagination: { page, limit, total: result.rows.length } });
});

// Login History
router.get('/login-history', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = (page - 1) * limit;
  const result = await pool.query(`
    SELECT 
      lh.id,
      lh.user_id,
      lh.user_email,
      lh.user_name,
      lh.login_at,
      lh.logout_at,
      lh.ip_address,
      lh.user_agent,
      lh.status,
      lh.failure_reason,
      u.name as joined_name,
      u.email as joined_email,
      u.phone as user_phone,
      u.role
    FROM login_history lh 
    LEFT JOIN "user" u ON u.id = lh.user_id 
    ORDER BY lh.login_at DESC 
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  
  const mappedRows = result.rows.map((row: any) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || row.joined_name || null,
    userEmail: row.user_email || row.joined_email || null,
    userPhone: row.user_phone || '',
    loginAt: row.login_at,
    logoutAt: row.logout_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    status: row.status,
    failureReason: row.failure_reason,
    role: row.role,
  }));
  
  return c.json({ success: true, data: mappedRows, pagination: { page, limit, total: result.rows.length } });
});

// Active/Online Users - users with valid sessions
router.get('/active-users', async (c) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.name,
        u.phone,
        u.role,
        u.last_login_at,
        s.id as session_id,
        s.expires_at,
        s.ip_address,
        s.user_agent,
        s.updated_at as last_active,
        t.name as shop_name,
        (SELECT action FROM activity_logs WHERE user_id::text = u.id ORDER BY created_at DESC LIMIT 1) as last_action,
        (SELECT entity_type FROM activity_logs WHERE user_id::text = u.id ORDER BY created_at DESC LIMIT 1) as last_entity,
        (SELECT created_at FROM activity_logs WHERE user_id::text = u.id ORDER BY created_at DESC LIMIT 1) as last_action_at
      FROM "user" u
      INNER JOIN session s ON s.user_id = u.id
      LEFT JOIN shops t ON t.id::text = u.shop_id
      WHERE s.expires_at > NOW() AND s.updated_at > NOW() - INTERVAL '1 hour'
      ORDER BY s.updated_at DESC
    `);
    
    const activeUsers = result.rows.map((row: any) => ({
      userId: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone || '',
      role: row.role,
      lastLoginAt: row.last_login_at,
      shopName: row.shop_name,
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      lastActive: row.last_active,
      lastAction: row.last_action,
      lastEntity: row.last_entity,
      lastActionAt: row.last_action_at,
    }));
    
    // Deduplicate by userId (users can have multiple sessions), keep the latest session
    const uniqueUsers = new Map();
    activeUsers.forEach(u => {
      const existing = uniqueUsers.get(u.userId);
      if (!existing || new Date(u.lastActive) > new Date(existing.lastActive)) {
        uniqueUsers.set(u.userId, { ...u, sessionCount: existing ? existing.sessionCount + 1 : 1 });
      } else {
        existing.sessionCount++;
      }
    });
    
    return c.json({ 
      success: true, 
      data: {
        count: uniqueUsers.size,
        users: Array.from(uniqueUsers.values())
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Security Alerts
router.get('/security-alerts', async (c) => {
  const result = await pool.query(`SELECT lh.*, u.email, u.name FROM login_history lh LEFT JOIN "user" u ON u.id = lh.user_id WHERE lh.status = 'failed' ORDER BY lh.login_at DESC LIMIT 50`);
  return c.json({ success: true, data: result.rows });
});

// Support Tickets (using support_chats table)
router.get('/tickets', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = (page - 1) * limit;
  const result = await pool.query(`SELECT t.*, u.email, u.name as user_name, s.name as shop_name FROM support_chats t LEFT JOIN "user" u ON u.id = t.user_id LEFT JOIN shops s ON s.id = t.tenant_id ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  return c.json({ success: true, data: result.rows, pagination: { page, limit, total: result.rows.length } });
});

router.put('/tickets/:id', async (c) => {
  const id = c.req.param('id');
  const { status, priority, assigned_to, admin_reply } = await c.req.json();
  const adminId = (c as any).get('userId');

  const ticketResult = await pool.query(`
    SELECT t.*, u.email as user_email, u.name as user_name
    FROM support_chats t
    LEFT JOIN "user" u ON u.id = t.user_id
    WHERE t.id = $1
  `, [id]);

  if (ticketResult.rows.length === 0) {
    return c.json({ success: false, error: 'Ticket not found' }, 404);
  }

  const ticket = ticketResult.rows[0];
  await pool.query(`
    UPDATE support_chats
    SET status = COALESCE($1, status),
        admin_id = COALESCE($3, admin_id),
        updated_at = NOW()
    WHERE id = $4
  `, [status, priority, assigned_to, id]);

  if (admin_reply) {
    await pool.query(`
      INSERT INTO chat_messages (chat_id, sender_id, sender_role, message, is_admin_message)
      VALUES ($1, $2, 'admin', $3, true)
    `, [id, adminId, admin_reply]);
    if (ticket.user_email) {
      await sendSupportReply({
        to: ticket.user_email,
        tenantName: ticket.user_name || 'Customer',
        ticketSubject: ticket.subject || 'Support Request',
        ticketId: String(id),
        reply: admin_reply,
        status: status || ticket.status || 'open',
      });
    }
  }

  return c.json({ success: true, data: ticket });
});

// Offers / Coupons
router.get('/offers', async (c) => {
  const result = await pool.query(`SELECT * FROM subscription_offers WHERE is_active = true ORDER BY created_at DESC`);
  return c.json({ success: true, data: result.rows });
});

// All coupons including inactive/expired (developer list view)
router.get('/offers/all', async (c) => {
  const result = await pool.query(`SELECT * FROM subscription_offers ORDER BY created_at DESC LIMIT 100`);
  return c.json({ success: true, data: result.rows });
});

router.post('/offers', async (c) => {
  const { title, description, offer_type, discount_percent, bonus_days, max_uses, expires_at, tenant_ids, code, valid_days } =
    await c.req.json().catch(() => ({} as any));

  // Coupon code: required, shareable, unique (case-insensitive)
  const cleanCode = code ? String(code).trim().toUpperCase().replace(/\s+/g, '') : '';
  if (!cleanCode && discount_percent > 0) {
    return c.json({ success: false, error: 'Coupon code is required (e.g. JB10)' }, 400);
  }
  if (cleanCode) {
    const existing = await pool.query(`SELECT id FROM subscription_offers WHERE UPPER(code) = $1`, [cleanCode]);
    if (existing.rows.length > 0) {
      return c.json({ success: false, error: `Coupon "${cleanCode}" already exists` }, 400);
    }
  }

  // Expiry: explicit date wins, otherwise start_date + valid_days
  let expiresAt = expires_at || null;
  if (!expiresAt && valid_days) {
    const d = new Date();
    d.setDate(d.getDate() + Number(valid_days));
    expiresAt = d.toISOString();
  }

  const result = await pool.query(
    `INSERT INTO subscription_offers (title, description, offer_type, discount_percent, bonus_days, max_uses, expires_at, tenant_ids, is_active, code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9) RETURNING *`,
    [title, description, offer_type, discount_percent ?? 0, bonus_days ?? 0, max_uses ?? null, expiresAt, tenant_ids ?? null, cleanCode || null]
  );
  return c.json({ success: true, data: result.rows[0] }, 201);
});

// Deactivate a coupon (kept for history; can no longer be redeemed)
router.delete('/offers/:id', async (c) => {
  const id = c.req.param('id');
  const result = await pool.query(
    `UPDATE subscription_offers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, code`,
    [id]
  );
  if (result.rows.length === 0) return c.json({ success: false, error: 'Coupon not found' }, 404);
  return c.json({ success: true, data: result.rows[0] });
});

// ===================================================
// TENANT SUBSCRIPTION MANAGEMENT
// ===================================================

// Get all tenants with subscription status
router.get('/tenants', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const search = c.req.query('search') || '';
  const statusFilter = c.req.query('status') || 'all';
  const offset = (page - 1) * limit;
  
  let whereClause = '';
  const params: any[] = [];
  
  if (search) {
    params.push(`%${search}%`);
    whereClause = `WHERE t.name ILIKE $1 OR t.email ILIKE $1`;
  }
  
  // Add status filter
  if (statusFilter !== 'all') {
    const statusWhere = statusFilter === 'active' ? "ts.status = 'active'" :
                        statusFilter === 'expired' ? "ts.status = 'expired'" :
                        statusFilter === 'pending' ? "ts.status = 'pending'" :
                        statusFilter === 'cancelled' ? "ts.status = 'cancelled'" :
                        "ts.status IS NULL";
    whereClause = whereClause ? `${whereClause} AND ${statusWhere}` : `WHERE ${statusWhere}`;
  }
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM tenants t 
     LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id 
     LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
     ${whereClause}`,
    params
  );
  
  params.push(limit, offset);
  const result = await pool.query(`
    SELECT t.id, t.name, t.email, t.plan_type, t.subscription_enabled, t.subscription_required, t.is_active, t.created_at,
      ts.id as subscription_id, ts.status, ts.current_period_start, ts.current_period_end, ts.plan_id,
      sp.name as plan_name, sp.price_tzs, sp.duration_days
    FROM tenants t
    LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
    LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  
  // Map to clean format
  const mappedRows = result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    planType: row.plan_type,
    subscriptionEnabled: row.subscription_enabled,
    subscriptionRequired: row.subscription_required,
    isActive: row.is_active,
    createdAt: row.created_at,
    subscriptionId: row.subscription_id,
    status: row.status || 'none',
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    planId: row.plan_id,
    planName: row.plan_name,
    priceTzs: row.price_tzs,
    durationDays: row.duration_days,
  }));
  
  return c.json({
    success: true,
    data: mappedRows,
    pagination: { page, limit, total: parseInt(countResult.rows[0].count) }
  });
});

// Toggle subscription enabled for a tenant
router.post('/tenants/:id/toggle-subscription', async (c) => {
  const tenantId = c.req.param('id');
  const { enabled, required } = await c.req.json();
  const adminId = (c as any).get('userId');
  
  // Get current state
  const currentRes = await pool.query(`SELECT subscription_enabled, subscription_required FROM tenants WHERE id = $1`, [tenantId]);
  if (currentRes.rows.length === 0) {
    return c.json({ success: false, error: 'Tenant not found' }, 404);
  }
  
  const current = currentRes.rows[0];
  const newEnabled = enabled !== undefined ? enabled : current.subscription_enabled;
  const newRequired = required !== undefined ? required : current.subscription_required;
  
  // Update tenant
  await pool.query(`
    UPDATE tenants 
    SET subscription_enabled = $1, subscription_required = $2, updated_at = NOW() 
    WHERE id = $3
  `, [newEnabled, newRequired, tenantId]);
  
  // Log action
  await pool.query(`
    INSERT INTO admin_audit_log (admin_id, action, target_tenant_id, notes)
    VALUES ($1, 'toggle_subscription', $2, $3)
  `, [adminId, tenantId, JSON.stringify({ enabled: newEnabled, required: newRequired })]);
  
  return c.json({ 
    success: true, 
    data: { 
      tenantId, 
      subscription_enabled: newEnabled, 
      subscription_required: newRequired 
    } 
  });
});

// Get specific tenant details with subscription info
router.get('/tenants/:id', async (c) => {
  const tenantId = c.req.param('id');
  
  const tenantRes = await pool.query(`
    SELECT t.*, 
      ts.id as subscription_id, ts.status as sub_status, ts.current_period_start, ts.current_period_end,
      sp.name as plan_name, sp.price_tzs, sp.duration_days
    FROM tenants t
    LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
    LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
    WHERE t.id = $1
  `, [tenantId]);
  
  if (tenantRes.rows.length === 0) {
    return c.json({ success: false, error: 'Tenant not found' }, 404);
  }
  
  return c.json({ success: true, data: tenantRes.rows[0] });
});

// Activity
router.get('/activity', async (c) => {
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50'), 1), 500);
  const offset = (page - 1) * limit;
  const search = (c.req.query('search') || '').trim();
  const actionFilter = (c.req.query('action') || '').trim();

  const where: string[] = [];
  const params: any[] = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(
      al.user_name ILIKE $${params.length}
      OR al.user_email ILIKE $${params.length}
      OR al.action ILIKE $${params.length}
      OR al.entity_type ILIKE $${params.length}
      OR u.name ILIKE $${params.length}
      OR u.email ILIKE $${params.length}
      OR u.phone ILIKE $${params.length}
      OR COALESCE(al.details::text, '') ILIKE $${params.length}
    )`);
  }
  if (actionFilter) {
    params.push(actionFilter);
    where.push(`al.action = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalResult = await pool.query(`SELECT COUNT(*) as total FROM activity_logs al LEFT JOIN "user" u ON u.id = al.user_id ${whereSql}`, params);
  const total = parseInt(totalResult.rows[0].total);

  const result = await pool.query(`
    SELECT 
      al.id,
      al.user_id,
      al.user_name,
      al.user_email,
      al.action,
      al.entity_type,
      al.entity_id,
      al.details,
      al.ip_address,
      al.user_agent,
      al.shop_id,
      al.created_at,
      u.name as joined_user_name,
      u.email as joined_user_email,
      u.phone as user_phone,
      s.name as shop_name
    FROM activity_logs al 
    LEFT JOIN "user" u ON u.id = al.user_id 
    LEFT JOIN shops s ON s.id = al.shop_id 
    ${whereSql}
    ORDER BY al.created_at DESC 
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  const mappedRows = result.rows.map((row: any) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.joined_user_name || row.user_name || 'Unknown',
    userEmail: row.joined_user_email || row.user_email || '',
    userPhone: row.user_phone || '',
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    shopId: row.shop_id,
    shopName: row.shop_name,
    createdAt: row.created_at,
  }));

return c.json({ success: true, data: mappedRows, pagination: { page, limit, total } });
});

// Distinct activity actions (for the developer portal filter dropdown)
router.get('/activity/actions', async (c) => {
  try {
    const r = await pool.query(`SELECT DISTINCT action FROM activity_logs ORDER BY action ASC`);
    return c.json({ success: true, data: r.rows.map((row: any) => row.action) });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// API Status — aggregated error counts per endpoint module
router.get('/api-status', async (c) => {
  try {
    // Get error counts grouped by endpoint prefix for last 24h
    const errorStats = await pool.query(`
      SELECT 
        CASE 
          WHEN request_path LIKE '/api/auth%' THEN 'auth'
          WHEN request_path LIKE '/api/products%' THEN 'products'
          WHEN request_path LIKE '/api/sales%' THEN 'sales'
          WHEN request_path LIKE '/api/shops%' THEN 'shops'
          WHEN request_path LIKE '/api/expenses%' THEN 'expenses'
          WHEN request_path LIKE '/api/debtors%' THEN 'debtors'
          WHEN request_path LIKE '/api/preorders%' OR request_path LIKE '/api/pre-orders%' THEN 'preorders'
          WHEN request_path LIKE '/api/backups%' THEN 'backups'
          WHEN request_path LIKE '/api/email%' THEN 'email'
          WHEN request_path LIKE '/api/export%' THEN 'export'
          WHEN request_path LIKE '/api/stock-take%' THEN 'stock-take'
          WHEN request_path LIKE '/api/subscriptions%' THEN 'subscriptions'
          WHEN request_path LIKE '/api/admin%' THEN 'admin'
          WHEN request_path LIKE '/api/super-admin%' THEN 'super-admin'
          WHEN request_path LIKE '/api/system%' THEN 'system'
          WHEN request_path LIKE '/api/public%' THEN 'public'
          WHEN request_path LIKE '/api/support%' THEN 'support'
          WHEN request_path LIKE '/api/units%' THEN 'units'
          WHEN request_path LIKE '/api/webhooks%' THEN 'webhooks'
          WHEN request_path LIKE '/api/me%' THEN 'auth'
          ELSE 'other'
        END as module,
        error_type,
        COUNT(*) as count,
        MAX(created_at) as last_error_at,
        (SELECT message FROM system_errors se2 
         WHERE se2.request_path LIKE 
           CASE 
             WHEN request_path LIKE '/api/auth%' THEN '/api/auth%'
             WHEN request_path LIKE '/api/products%' THEN '/api/products%'
             WHEN request_path LIKE '/api/sales%' THEN '/api/sales%'
             WHEN request_path LIKE '/api/shops%' THEN '/api/shops%'
             WHEN request_path LIKE '/api/expenses%' THEN '/api/expenses%'
             WHEN request_path LIKE '/api/debtors%' THEN '/api/debtors%'
             WHEN request_path LIKE '/api/preorders%' OR request_path LIKE '/api/pre-orders%' THEN '/api/pre%'
             WHEN request_path LIKE '/api/backups%' THEN '/api/backups%'
             WHEN request_path LIKE '/api/email%' THEN '/api/email%'
             WHEN request_path LIKE '/api/export%' THEN '/api/export%'
             WHEN request_path LIKE '/api/stock-take%' THEN '/api/stock-take%'
             WHEN request_path LIKE '/api/subscriptions%' THEN '/api/subscriptions%'
             WHEN request_path LIKE '/api/admin%' THEN '/api/admin%'
             WHEN request_path LIKE '/api/super-admin%' THEN '/api/super-admin%'
             WHEN request_path LIKE '/api/system%' THEN '/api/system%'
             WHEN request_path LIKE '/api/public%' THEN '/api/public%'
             WHEN request_path LIKE '/api/support%' THEN '/api/support%'
             WHEN request_path LIKE '/api/units%' THEN '/api/units%'
             WHEN request_path LIKE '/api/webhooks%' THEN '/api/webhooks%'
             WHEN request_path LIKE '/api/me%' THEN '/api/auth%'
             ELSE '/api/%'
           END
         ORDER BY created_at DESC LIMIT 1
        ) as last_error_message
      FROM system_errors
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY module, error_type
      ORDER BY module, count DESC
    `);

    // Build module status map
    const modules = new Map<string, { status: string; errors: number; lastError: string; lastErrorAt: string; errorTypes: any[] }>();
    const allModules = ['auth', 'products', 'sales', 'shops', 'expenses', 'debtors', 'preorders', 'backups', 'email', 'export', 'stock-take', 'subscriptions', 'admin', 'super-admin', 'system', 'public', 'support', 'units', 'webhooks', 'other'];

    for (const mod of allModules) {
      modules.set(mod, { status: 'healthy', errors: 0, lastError: '', lastErrorAt: '', errorTypes: [] });
    }

    for (const row of errorStats.rows) {
      const mod = modules.get(row.module) || modules.get('other')!;
      mod.errors += parseInt(row.count);
      mod.errorTypes.push({ type: row.error_type, count: parseInt(row.count) });
      if (row.last_error_message) mod.lastError = row.last_error_message;
      if (row.last_error_at && (!mod.lastErrorAt || new Date(row.last_error_at) > new Date(mod.lastErrorAt))) {
        mod.lastErrorAt = row.last_error_at;
      }
    }

    // Determine status per module
    for (const [key, mod] of modules) {
      if (mod.errors === 0) {
        mod.status = 'healthy';
      } else if (mod.errors <= 3) {
        mod.status = 'degraded';
      } else {
        mod.status = 'down';
      }
    }

    // Total error count last 24h
    const totalResult = await pool.query(`SELECT COUNT(*) as total FROM system_errors WHERE created_at >= NOW() - INTERVAL '24 hours'`);
    const totalErrors = parseInt(totalResult.rows[0].total);

    return c.json({
      success: true,
      data: {
        totalErrors,
        modules: Object.fromEntries(modules),
        healthyCount: Array.from(modules.values()).filter(m => m.status === 'healthy').length,
        degradedCount: Array.from(modules.values()).filter(m => m.status === 'degraded').length,
        downCount: Array.from(modules.values()).filter(m => m.status === 'down').length,
      }
    });
  } catch (e: any) {
    console.error('[API Status] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Recent signups (last 24 hours) with welcome email status
router.get('/recent-signups', async (c) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.name,
        u.role,
        u.created_at,
        u.welcome_email_sent,
        u.welcome_email_sent_at,
        t.name as tenant_name
      FROM "user" u
      LEFT JOIN tenants t ON t.id::text = u.tenant_id
      WHERE u.created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY u.created_at DESC
    `);
    
    return c.json({
      success: true,
      data: result.rows.map((r: any) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        tenantName: r.tenant_name,
        createdAt: r.created_at,
        welcomeEmailSent: r.welcome_email_sent,
        welcomeEmailSentAt: r.welcome_email_sent_at,
      })),
      total: result.rows.length,
    });
  } catch (e: any) {
    console.error('[Recent Signups] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── NON-PAYING USERS (for simu outreach) ─────────────────────────────────────
router.get('/non-paying-users', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;
    const search = c.req.query('search') || '';
    const filterStatus = c.req.query('filter') || 'all'; // 'never_paid', 'trial_expired', 'subscription_expired', 'all'
    const now = new Date();

    let whereClauses: string[] = [];
    const params: any[] = [now];
    let idx = 2;

    // Start with tenants that have no active subscription AND are not super admin shops
    whereClauses.push(`NOT EXISTS (
      SELECT 1 FROM tenant_subscriptions ts
      WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > $1
    )`);

    // Additional filter
    if (filterStatus === 'never_paid') {
      whereClauses.push(`t.trial_activated = false`);
    } else if (filterStatus === 'trial_expired') {
      whereClauses.push(`t.trial_activated = true AND t.trial_end <= $1`);
    } else if (filterStatus === 'subscription_expired') {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM tenant_subscriptions ts
        WHERE ts.tenant_id = t.id AND ts.status = 'expired'
      )`);
    }

    if (search) {
      params.push(`%${search}%`);
      whereClauses.push(`(t.name ILIKE $${idx} OR t.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.name ILIKE $${idx})`);
      idx++;
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const countResult = await pool.query(`
      SELECT COUNT(DISTINCT t.id) FROM tenants t
      LEFT JOIN "user" u ON u.tenant_id = t.id::text
      ${whereSQL}
    `, params);
    const total = parseInt(countResult.rows[0].count);

    params.push(limit, offset);
    const limitIdx = idx;
    const offsetIdx = idx + 1;

    const result = await pool.query(`
      SELECT
        t.id AS tenant_id, t.name AS tenant_name, t.email AS tenant_email, COALESCE(t.phone, u.phone) AS tenant_phone,
        t.created_at AS tenant_created_at,
        t.trial_activated, t.trial_start, t.trial_end,
        u.id AS user_id, u.name AS user_name, u.email AS user_email, u.phone AS user_phone, u.role AS user_role,
        CASE
          WHEN t.trial_activated = true AND t.trial_end > $1 THEN 'trial_active'
          WHEN t.trial_activated = true AND t.trial_end <= $1 THEN 'trial_expired'
          ELSE 'never_paid'
        END AS payment_status,
        CASE
          WHEN EXISTS (SELECT 1 FROM tenant_subscriptions ts2 WHERE ts2.tenant_id = t.id AND ts2.status = 'expired') THEN true
          ELSE false
        END AS had_subscription,
        (SELECT ts3.status FROM tenant_subscriptions ts3 WHERE ts3.tenant_id = t.id ORDER BY ts3.created_at DESC LIMIT 1) AS last_subscription_status,
        (SELECT COUNT(*) FROM shops WHERE tenant_id = t.id) AS shop_count
      FROM tenants t
      LEFT JOIN "user" u ON u.tenant_id = t.id::text AND (u.role = 'admin' OR u.role = 'owner')
      ${whereSQL}
      ORDER BY t.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params);

    // Deduplicate by tenant_id (prefer admin role user)
    const tenantMap = new Map<string, any>();
    for (const row of result.rows) {
      const tid = row.tenant_id;
      if (!tenantMap.has(tid)) {
        tenantMap.set(tid, {
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          tenantEmail: row.tenant_email,
          tenantPhone: row.tenant_phone,
          tenantCreatedAt: row.tenant_created_at,
          trialActivated: row.trial_activated,
          trialStart: row.trial_start,
          trialEnd: row.trial_end,
          paymentStatus: row.payment_status,
          hadSubscription: row.had_subscription,
          lastSubscriptionStatus: row.last_subscription_status,
          shopCount: parseInt(row.shop_count),
          user: row.user_id ? {
            id: row.user_id,
            name: row.user_name,
            email: row.user_email,
            phone: row.user_phone,
            role: row.user_role,
          } : null,
        });
      } else if (row.user_role === 'admin' || row.user_role === 'owner') {
        // Prefer admin/owner user over other roles
        const existing = tenantMap.get(tid);
        existing.user = {
          id: row.user_id,
          name: row.user_name,
          email: row.user_email,
          phone: row.user_phone,
          role: row.user_role,
        };
      }
    }

    return c.json({
      success: true,
      data: Array.from(tenantMap.values()),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e: any) {
    console.error('[Non-Paying Users] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Revenue
router.get('/revenue', async (c) => {
  const range = c.req.query('range') || '30';
  const daysRange = parseInt(c.req.query('range') || '30');
  const revenue = await pool.query(`SELECT DATE_TRUNC('day', paid_at) as date, SUM(amount_tzs) as revenue, COUNT(*) as transactions FROM subscription_payments WHERE status = 'completed' AND paid_at >= CURRENT_DATE - (INTERVAL '1 day' * $1) GROUP BY DATE_TRUNC('day', paid_at) ORDER BY date DESC`, [daysRange]);
  const mrr = await pool.query("SELECT COALESCE(SUM(price_tzs), 0) as mrr FROM subscription_plans sp WHERE sp.id IN (SELECT plan_id FROM tenant_subscriptions WHERE status = 'active')");
  return c.json({ success: true, data: { daily: revenue.rows.map((r: any) => ({ date: r.date, revenue: parseFloat(r.revenue), transactions: parseInt(r.transactions) })), byPlan: [], mrr: parseFloat(mrr.rows[0].mrr) } });
});

// Admins
router.get('/admins', async (c) => {
  const result = await pool.query(`SELECT u.id, u.email, u.name, u.role, u.created_at, u.banned, (SELECT COUNT(*) FROM admin_audit_log WHERE admin_id = u.id) as action_count, (SELECT MAX(created_at) FROM admin_audit_log WHERE admin_id = u.id) as last_action FROM "user" u WHERE u.role IN ('developer') ORDER BY u.created_at DESC`);
  return c.json({ success: true, data: result.rows });
});

router.post('/admins', async (c) => {
  const { email, role } = await c.req.json();
  if (role !== 'developer' && role !== 'staff') return c.json({ success: false, error: 'Invalid role' }, 400);
  if (!email || !String(email).trim()) return c.json({ success: false, error: 'Email is required' }, 400);
  const userRes = await pool.query(`SELECT id FROM "user" WHERE LOWER(email) = LOWER($1)`, [email]);
  const adminId = userRes.rows[0]?.id || null;
  if (!adminId) {
    return c.json({ success: false, error: 'No account exists with that email. Ask them to register first.' }, 404);
  }
  await pool.query(`UPDATE "user" SET role = $1 WHERE id = $2`, [role, adminId]);
  await pool.query(`INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'grant_admin_role', $2)`, [adminId, JSON.stringify({ email, role })]);
  return c.json({ success: true });
});

router.delete('/admins/:email', async (c) => {
  const email = c.req.param('email').toLowerCase();
  const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase();
  if (email === SUPER_ADMIN_EMAIL) {
    return c.json({ success: false, error: 'Cannot remove the configured super admin' }, 400);
  }
  const result = await pool.query(`UPDATE "user" SET role = 'user' WHERE LOWER(email) = $1 AND role IN ('developer', 'staff') RETURNING id, email`, [email]);
  if (result.rowCount === 0) {
    return c.json({ success: false, error: 'Admin not found' }, 404);
  }
  // Revoke any live sessions so the removed admin loses access immediately.
  await pool.query(`DELETE FROM "session" WHERE user_id = $1`, [result.rows[0].id]);
  await pool.query(`INSERT INTO admin_audit_log (admin_id, action, notes) VALUES ($1, 'remove_admin_role', $2)`, [result.rows[0].id, JSON.stringify({ email })]);
  return c.json({ success: true, data: result.rows[0] });
});

// Contact requests from public AI chat
router.get('/contact-requests', async (c) => {
  const status = c.req.query('status') || '';
  let query = 'SELECT * FROM contact_requests ORDER BY created_at DESC';
  const params: any[] = [];
  if (status) {
    query = 'SELECT * FROM contact_requests WHERE status = $1 ORDER BY created_at DESC';
    params.push(status);
  }
  const result = await pool.query(query, params);
  return c.json({ success: true, data: result.rows });
});

router.put('/contact-requests/:id', async (c) => {
  const id = c.req.param('id');
  const { status, admin_notes } = await c.req.json();
  const result = await pool.query(
    `UPDATE contact_requests SET status = COALESCE($1, status), admin_notes = COALESCE($2, admin_notes), updated_at = NOW() WHERE id = $3 RETURNING *`,
    [status || null, admin_notes || null, id]
  );
  if (result.rowCount === 0) {
    return c.json({ success: false, error: 'Contact request not found' }, 404);
  }
  return c.json({ success: true, data: result.rows[0] });
});

// ===== Backup Notifier =====
router.get('/notifiers', async (c) => {
  const notifiers = await getNotifiers();
  return c.json({ success: true, data: notifiers });
});

router.post('/notifiers', async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.webhookUrl) {
    return c.json({ success: false, error: 'name and webhookUrl are required' }, 400);
  }
  const notifier = await createNotifier(body);
  return c.json({ success: true, data: notifier });
});

router.put('/notifiers/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const notifier = await updateNotifier(id, body);
  if (!notifier) return c.json({ success: false, error: 'Notifier not found' }, 404);
  return c.json({ success: true, data: notifier });
});

router.delete('/notifiers/:id', async (c) => {
  const id = c.req.param('id');
  const deleted = await deleteNotifier(id);
  if (!deleted) return c.json({ success: false, error: 'Notifier not found' }, 404);
  return c.json({ success: true });
});

router.post('/notifiers/:id/test', async (c) => {
  const id = c.req.param('id');
  const result = await testNotifier(id);
  if (!result) return c.json({ success: false, error: 'Notifier not found' }, 404);
  return c.json({ success: result.ok, data: result });
});

// Latest backup status + recent history
router.get('/backup-status', async (c) => {
  const [status, history, logs] = await Promise.all([
    getBackupStatus(),
    getBackupStatusHistory(20),
    getNotifierLogs(20),
  ]);
  return c.json({ success: true, data: { status, history, logs } });
});

// Backup notifier config (webhook URL + secret presence)
router.get('/notifier-config', async (c) => {
  const config = await getWebhookConfig();
  return c.json({ success: true, data: config });
});

router.put('/notifier-config', async (c) => {
  const { secret } = await c.req.json();
  if (!secret || typeof secret !== 'string' || secret.trim().length < 8) {
    return c.json({ success: false, error: 'Secret must be at least 8 characters' }, 400);
  }
  await setWebhookSecret(secret.trim());
  return c.json({ success: true });
});

// Manually trigger a backup status push (simulates Databasus) to test the flow
router.post('/backup-status/test', async (c) => {
  const { heading, message, status } = await c.req.json();
  const result = await receiveBackupStatus({
    heading: heading || 'ALFEAN ENTERPRISES Manual Test',
    message: message || 'Test backup notification from developer portal.',
    status: status || 'unknown',
  });
  return c.json({ success: true, data: result });
});

export default router;
