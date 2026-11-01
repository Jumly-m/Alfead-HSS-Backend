import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getAccountBalance } from '../../services/snippe.service.js';
import { cache } from '../../utils/cache.js';
import { activateSubscriptionByReference } from '../../services/subscription-activation.service.js';
import {
  getTrialCleanupSettings,
  saveTrialCleanupSettings,
  getTrialCleanupCounts,
  listDeletionCandidates,
  sendWarningsForTenants,
  deleteEligibleTenants,
  runTrialCleanup,
} from '../../services/trial-cleanup.service.js';
import { FEATURE_KEYS, getTrialSettings, saveTrialSettings, ensurePlanLimitSetup } from '../../services/plan-limits.service.js';

const adminRoutes = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
  }
}>();

const requireSuperAdmin = async (c: any, next: any) => {
  const role = c.get('userRole');
  if (role !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  await next();
};

adminRoutes.use('/*', authMiddleware, requireSuperAdmin);

// GET /api/admin/subscription/settings - Get global subscription settings
adminRoutes.get('/settings', async (c) => {
  try {
    const result = await pool.query(`SELECT key, value FROM system_settings WHERE key = 'subscription'`);
    if (result.rows.length === 0) {
      return c.json({ success: true, data: { enabled: false, grace_period_days: 3, trial_days: 7 } });
    }
    return c.json({ success: true, data: result.rows[0].value });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// PUT /api/admin/subscription/settings - Update global subscription settings
adminRoutes.put('/settings', async (c) => {
  try {
    const body = await c.req.json();
    const { enabled, grace_period_days, trial_days } = body;
    const settings = {
      enabled: enabled ?? false,
      grace_period_days: grace_period_days ?? 3,
      trial_days: trial_days ?? 7,
      updated_at: new Date().toISOString(),
      updated_by: c.get('userId'),
    };
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('subscription', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(settings)]
    );
    return c.json({ success: true, data: settings });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.get('/tenants', async (c) => {
  try {
    const status = c.req.query('status');

    const baseQuery = `
      SELECT t.id, t.name, t.email, t.created_at, t.trial_activated, t.trial_start, t.trial_end,
             t.phone as tenant_phone, up.phone as owner_phone,
             ts.id as subscription_id, ts.status, ts.current_period_start, ts.current_period_end,
             sp.name as plan_name, sp.price_tzs, sp.duration_days
      FROM tenants t
      LEFT JOIN LATERAL (
        SELECT u.phone FROM "user" u
        WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner')
          AND u.phone IS NOT NULL AND u.phone <> ''
        ORDER BY u.created_at ASC LIMIT 1
      ) up ON true
      ${status && status !== 'all' ? `INNER JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
      LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
      WHERE ts.status = $1
      ORDER BY ts.created_at DESC` : `
      LEFT JOIN LATERAL (
        SELECT id, status, current_period_start, current_period_end, plan_id
        FROM tenant_subscriptions
        WHERE tenant_id = t.id
        ORDER BY created_at DESC
        LIMIT 1
      ) ts ON true
      LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
      ORDER BY t.created_at DESC`}
      LIMIT 200
    `;

    const result = status && status !== 'all'
      ? await pool.query(baseQuery, [status])
      : await pool.query(baseQuery);

    const tenants = result.rows;

    // ── Monthly payment history per tenant ───────────────────────────────────
    // Every tenant row gets: paymentsByMonth {'YYYY-MM': amount} for the last 6
    // months, total paid since day one, payment count and last payment date —
    // so the developer can see at a glance who paid each month and who owes a
    // follow-up this month.
    if (tenants.length > 0) {
      const tenantIds = tenants.map((t: any) => t.id);
      const [byMonthRes, totalsRes] = await Promise.all([
        pool.query(`
          SELECT sp.tenant_id,
                 to_char(date_trunc('month', sp.paid_at), 'YYYY-MM') AS month,
                 COALESCE(SUM(sp.amount_tzs), 0)::int AS amount
          FROM subscription_payments sp
          WHERE sp.tenant_id = ANY($1::uuid[])
            AND sp.status = 'completed'
            AND sp.paid_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
          GROUP BY 1, 2
        `, [tenantIds]),
        pool.query(`
          SELECT tenant_id,
                 COALESCE(SUM(amount_tzs), 0)::int AS total_paid,
                 COUNT(*)::int AS payments_count,
                 MAX(paid_at) AS last_paid_at,
                 MIN(paid_at) AS first_paid_at
          FROM subscription_payments
          WHERE tenant_id = ANY($1::uuid[]) AND status = 'completed'
          GROUP BY tenant_id
        `, [tenantIds]),
      ]);

      const byMonthMap: Record<string, Record<string, number>> = {};
      for (const row of byMonthRes.rows as any[]) {
        if (!byMonthMap[row.tenant_id]) byMonthMap[row.tenant_id] = {};
        byMonthMap[row.tenant_id][row.month] = Number(row.amount) || 0;
      }
      const totalsMap: Record<string, any> = {};
      for (const row of totalsRes.rows as any[]) {
        totalsMap[row.tenant_id] = row;
      }
      for (const tenant of tenants) {
        const totals = totalsMap[(tenant as any).id] || {};
        (tenant as any).paymentsByMonth = byMonthMap[(tenant as any).id] || {};
        (tenant as any).totalPaid = Number(totals.total_paid) || 0;
        (tenant as any).paymentsCount = Number(totals.payments_count) || 0;
        (tenant as any).lastPaidAt = totals.last_paid_at || null;
        (tenant as any).firstPaidAt = totals.first_paid_at || null;
      }
    }

    // Fetch shops with product and sale counts for all returned tenants
    if (tenants.length > 0) {
      const tenantIds = tenants.map((t: any) => t.id);
      const shopsResult = await pool.query(`
        SELECT 
          s.id, s.name, s.tenant_id, s.is_active, s.created_at,
          (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) as product_count,
          (SELECT COUNT(*) FROM sales sa WHERE sa.shop_id = s.id) as sale_count
        FROM shops s
        WHERE s.tenant_id = ANY($1::uuid[])
        ORDER BY s.name
      `, [tenantIds]);

      // Group shops by tenant_id
      const shopsByTenant: Record<string, any[]> = {};
      for (const shop of shopsResult.rows) {
        const tid = shop.tenant_id;
        if (!shopsByTenant[tid]) shopsByTenant[tid] = [];
        shopsByTenant[tid].push({
          id: shop.id,
          name: shop.name,
          isActive: shop.is_active,
          createdAt: shop.created_at,
          products: parseInt(shop.product_count),
          sales: parseInt(shop.sale_count),
        });
      }

      for (const tenant of tenants) {
        (tenant as any).shops = shopsByTenant[tenant.id] || [];
      }
    }

    return c.json({ success: true, data: tenants });
  } catch (e: any) {
    return c.json({ success: false, error: e.message, data: [] }, 500);
  }
});

adminRoutes.get('/payments', async (c) => {
  try {
    const result = await pool.query(`
      SELECT sp.id, sp.snippe_reference, sp.amount_tzs, sp.status,
             sp.payment_channel, sp.payment_type, sp.customer_phone, sp.paid_at, sp.created_at,
             t.name as tenant_name, t.email as tenant_email,
             spl.name as plan_name
      FROM subscription_payments sp
      LEFT JOIN tenants t ON t.id = sp.tenant_id
      LEFT JOIN tenant_subscriptions ts ON ts.id = sp.subscription_id
      LEFT JOIN subscription_plans spl ON spl.id = ts.plan_id
      ORDER BY sp.created_at DESC
      LIMIT 200
    `);
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message, data: [] }, 500);
  }
});

adminRoutes.get('/balance', async (c) => {
  try {
    const balance = await getAccountBalance();
    return c.json({ success: true, data: balance });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.post('/subscriptions/:id/force-activate', async (c: any) => {
  const adminId = c.get('userId');
  const subId = c.param('id');
  const body = await c.req.json().catch(() => ({}));
  const days = Number(body.days) || 30;
  const notes = body.notes ?? '';
  const reference = body.reference ?? undefined;

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setDate(periodEnd.getDate() + Number(days));

  try {
    // If a Snippe reference is provided, use the full activation flow
    if (reference) {
      const result = await activateSubscriptionByReference({ reference, verifyWithSnippe: false });

      if (!result.activated) {
        return c.json({ success: false, error: result.reason || 'Activation failed' }, 400);
      }

      return c.json({ success: true, data: result.data });
    }

    // Simple manual activation without reference (just set status to active)
    const subResult = await pool.query(`
      UPDATE tenant_subscriptions
      SET status = 'active',
          current_period_start = $1,
          current_period_end = $2,
          updated_at = $1
      WHERE id = $3
      RETURNING id, tenant_id
    `, [now, periodEnd, subId]);

    if (subResult.rows.length === 0) {
      return c.json({ success: false, error: 'Subscription not found' }, 404);
    }

    const sub = subResult.rows[0];
    // End trial when subscription is activated
    await pool.query(`
      UPDATE tenants SET trial_end = $1, updated_at = NOW()
      WHERE id = $2 AND trial_activated = true AND (trial_end IS NULL OR trial_end > NOW())
    `, [now, sub.tenant_id]);

    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, target_tenant_id, target_subscription_id, notes)
      VALUES ($1, 'force_activate', $2, $3, $4)
    `, [adminId, sub.tenant_id, subId, notes || `Force-activated for ${days} days`]);

    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.post('/subscriptions/:id/cancel', async (c: any) => {
  const adminId = c.get('userId');
  const subId = c.req.param('id');
  const { notes = '' } = await c.req.json().catch(() => ({ notes: '' }));

  try {
    const subResult = await pool.query(`
      UPDATE tenant_subscriptions
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
      RETURNING id, tenant_id
    `, [subId]);

    if (subResult.rows.length === 0) {
      return c.json({ success: false, error: 'Subscription not found' }, 404);
    }

    const sub = subResult.rows[0];
    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, target_tenant_id, target_subscription_id, notes)
      VALUES ($1, 'cancel_subscription', $2, $3, $4)
    `, [adminId, sub.tenant_id, subId, notes || 'Cancelled by admin']);

    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Developer tool: re-date a subscription's paid period. A customer may pay on
// 28/09 (when their trial ends) but want the covered month to be 01/10 → 30/10
// — not the period running from the payment date. Only the period dates (and
// status, see below) change; plan, payment and audit history stay untouched.
adminRoutes.patch('/subscriptions/:id/period', async (c: any) => {
  const adminId = c.get('userId');
  const subId = c.param('id');
  const body = await c.req.json().catch(() => ({}));
  const notes = body.notes ?? '';

  // Date-only inputs are interpreted in East African Time (UTC+3, no DST), so
  // "2026-10-30" always means the whole of 30/10 in Tanzania no matter which
  // timezone the server runs in. The end date covers its full day (23:59:59)
  // so the customer is never cut off midday on their last paid day.
  const parseEAT = (v: any, endOfDay: boolean): Date | null => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
    const d = new Date(`${v.trim()}T${endOfDay ? '23:59:59' : '00:00:00'}+03:00`);
    return isNaN(d.getTime()) ? null : d;
  };

  const start = parseEAT(body.start, false);
  if (!start) {
    return c.json({ success: false, error: 'Start date is required (format YYYY-MM-DD).' }, 400);
  }

  try {
    const cur = await pool.query(
      `SELECT ts.id, ts.tenant_id, ts.current_period_start, ts.current_period_end,
              ts.status, sp.duration_days
       FROM tenant_subscriptions ts
       LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
       WHERE ts.id = $1`,
      [subId]
    );
    if (cur.rows.length === 0) {
      return c.json({ success: false, error: 'Subscription not found' }, 404);
    }
    const sub = cur.rows[0];

    let end = parseEAT(body.end, true);
    if (!end) {
      // No end given → keep the plan's length counted from the new start
      // (30-day plan starting 01/10 → covered through 30/10 23:59:59).
      const days = Math.max(1, Number(sub.duration_days) || 30);
      end = new Date(start.getTime() + days * 86400000 - 1000);
    }
    if (end.getTime() <= start.getTime()) {
      return c.json({ success: false, error: 'End date must be after the start date.' }, 400);
    }

    // A future end date also (re)activates the row: subscriptions that the
    // expiry cron had flipped to 'expired' must come back to life, otherwise
    // the guard (which requires status = 'active') would keep the tenant
    // locked out even though they have paid time ahead of them.
    await pool.query(
      `UPDATE tenant_subscriptions
       SET current_period_start = $1,
           current_period_end = $2,
           status = CASE WHEN $2::timestamp > NOW() THEN 'active' ELSE status END,
           updated_at = NOW()
       WHERE id = $3`,
      [start, end, subId]
    );

    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_tenant_id, target_subscription_id, notes)
       VALUES ($1, 'adjust_period', $2, $3, $4)`,
      [adminId, sub.tenant_id, subId, notes || `Period set to ${start.toISOString()} → ${end.toISOString()}`]
    );

    // Drop the guard + entitlement caches so the new period takes effect on
    // the tenant's very next request instead of after the 30s TTL.
    cache.invalidate(`tenant:subscription:${sub.tenant_id}`);
    cache.invalidate(`tenant:entitlements:${sub.tenant_id}`);

    return c.json({ success: true, data: { id: subId, start, end, previousStart: sub.current_period_start, previousEnd: sub.current_period_end } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Plan management
adminRoutes.get('/plans', async (c) => {
  try {
    const result = await cache.getOrSet(
      'subscription:plans',
      () => pool.query(`SELECT * FROM subscription_plans ORDER BY duration_days ASC`),
      300 // 5 minutes
    );
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message, data: [] }, 500);
  }
});

const toLimit = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const toFeatures = (v: any): string[] | null => {
  if (!Array.isArray(v)) return null;
  return v.filter((k: any) => typeof k === 'string' && FEATURE_KEYS.includes(k));
};

adminRoutes.put('/plans/:id', async (c: any) => {
  const planId = c.req.param('id');
  const body = await c.req.json();
  await ensurePlanLimitSetup();
  const { name, price_tzs, full_price_tzs, discount_percent, duration_days, description, badge, is_active } = body;
  const applyMode: 'new' | 'all' = body.applyMode === 'all' ? 'all' : 'new';
  const fullAccess = body.full_access === true;
  const maxShops = fullAccess ? null : toLimit(body.max_shops);
  const maxSellers = fullAccess ? null : toLimit(body.max_sellers);
  const maxAdmins = fullAccess ? null : toLimit(body.max_admins);
  const maxProducts = fullAccess ? null : toLimit(body.max_products);
  const features = fullAccess ? null : toFeatures(body.features);

  try {
    const existingRes = await pool.query(`SELECT * FROM subscription_plans WHERE id = $1`, [planId]);
    if (existingRes.rows.length === 0) {
      return c.json({ success: false, error: 'Plan not found' }, 404);
    }
    const existing = existingRes.rows[0];

    const limitsChanged =
      (existing.full_access === true) !== fullAccess ||
      (existing.max_shops ?? null) !== maxShops ||
      (existing.max_sellers ?? null) !== maxSellers ||
      (existing.max_admins ?? null) !== maxAdmins ||
      (existing.max_products ?? null) !== maxProducts ||
      JSON.stringify(existing.features ?? null) !== JSON.stringify(features);

    // 'new' → only subscriptions created after this save are limited
    // 'all' → limits apply immediately to every subscriber of this plan
    let effectiveFrom: Date | null = existing.limits_effective_from ? new Date(existing.limits_effective_from) : null;
    if (applyMode === 'all' || fullAccess) effectiveFrom = null;
    else if (limitsChanged) effectiveFrom = new Date();

    const result = await pool.query(`
      UPDATE subscription_plans
      SET name = $1, price_tzs = $2, full_price_tzs = $3, discount_percent = $4,
          duration_days = $5, max_shops = $6, max_sellers = $7, description = $8, badge = $9, is_active = $10,
          max_products = $11, max_admins = $12, features = $13::jsonb,
          limits_effective_from = $14, limits_apply_mode = $15, full_access = $16
      WHERE id = $17
      RETURNING *
    `, [name, price_tzs, full_price_tzs, discount_percent, duration_days, maxShops, maxSellers, description, badge, is_active,
        maxProducts, maxAdmins, JSON.stringify(features), effectiveFrom, applyMode, fullAccess, planId]);

    cache.invalidate('subscription:plans');
    cache.invalidateByPrefix('tenant:entitlements:');
    return c.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.post('/plans', async (c: any) => {
  const body = await c.req.json();
  await ensurePlanLimitSetup();
  const { name, price_tzs, full_price_tzs, discount_percent, duration_days, description, badge, is_active } = body;
  const applyMode: 'new' | 'all' = body.applyMode === 'all' ? 'all' : 'new';
  const fullAccess = body.full_access === true;
  const maxShops = fullAccess ? null : toLimit(body.max_shops);
  const maxSellers = fullAccess ? null : toLimit(body.max_sellers);
  const maxAdmins = fullAccess ? null : toLimit(body.max_admins);
  const maxProducts = fullAccess ? null : toLimit(body.max_products);
  const features = fullAccess ? null : toFeatures(body.features);

  try {
    const result = await pool.query(`
      INSERT INTO subscription_plans
        (name, price_tzs, full_price_tzs, discount_percent, duration_days, max_shops, max_sellers,
         description, badge, is_active, max_products, max_admins, features, limits_effective_from, limits_apply_mode, full_access)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NULL, $14, $15)
      RETURNING *
    `, [name, price_tzs, full_price_tzs, discount_percent, duration_days, maxShops, maxSellers,
        description, badge, is_active ?? true, maxProducts, maxAdmins, JSON.stringify(features), applyMode, fullAccess]);

    cache.invalidate('subscription:plans');
    cache.invalidateByPrefix('tenant:entitlements:');
    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.delete('/plans/:id', async (c: any) => {
  const planId = c.req.param('id');
  try {
    const inUse = await pool.query(`SELECT COUNT(*) FROM tenant_subscriptions WHERE plan_id = $1`, [planId]);
    if (parseInt(inUse.rows[0].count) > 0) {
      return c.json({ success: false, error: 'Cannot delete plan — it is currently assigned to active tenants. Deactivate it instead.' }, 409);
    }
    const result = await pool.query(`DELETE FROM subscription_plans WHERE id = $1 RETURNING id`, [planId]);
    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Plan not found' }, 404);
    }
    cache.invalidate('subscription:plans');
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Per-tenant subscription management
adminRoutes.get('/tenant/:tenantId', async (c: any) => {
  try {
    const tenantId = c.req.param('tenantId');
    const result = await pool.query(`
      SELECT ts.*, sp.name as plan_name, sp.price_tzs, sp.duration_days,
             u.name as user_name, u.email as user_email
      FROM tenant_subscriptions ts
      LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
      LEFT JOIN tenants t ON t.id = ts.tenant_id
      LEFT JOIN "user" u ON u.tenant_id = t.id::text AND u.role = 'admin'
      WHERE ts.tenant_id = $1
      ORDER BY ts.created_at DESC
    `, [tenantId]);
    return c.json({ success: true, data: result.rows[0] ?? null });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

adminRoutes.post('/tenant/:tenantId/subscription', async (c: any) => {
  const tenantId = c.req.param('tenantId');
  const { plan_id, days } = await c.req.json();

  const plan = days
    ? null
    : (await pool.query(`SELECT * FROM subscription_plans WHERE id = $1`, [plan_id])).rows[0];

  const durationDays = days ?? plan?.duration_days ?? 30;
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setDate(periodEnd.getDate() + durationDays);

  try {
    const result = await pool.query(`
      INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
      VALUES ($1, $2, 'active', $3, $4)
      RETURNING *
    `, [tenantId, plan_id || null, now, periodEnd]);
    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.get('/shops', async (c: any) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;
    const search = c.req.query('search') || '';

    let whereClause = 'WHERE s.is_super_admin IS NOT TRUE';
    const params = [];
    let idx = 1;

    if (search) {
      whereClause += ` AND (s.name ILIKE $${idx} OR s.business_name ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const countResult = await pool.query(`SELECT COUNT(*) FROM shops s ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(`
      SELECT
        s.id, s.name, s.business_name, s.address, s.phone, s.email,
        s.branch_name, s.is_active, s.created_at,
        s.tenant_id,
        t.name as tenant_name, t.email as tenant_email,
        u.id as owner_id, u.name as owner_name, u.email as owner_email,
        (SELECT login_at FROM login_history WHERE user_id::text = u.id ORDER BY login_at DESC LIMIT 1) as owner_last_login,
        (SELECT COUNT(*) FROM products WHERE shop_id = s.id) as product_count,
        (SELECT COUNT(*) FROM sales WHERE shop_id = s.id) as sale_count,
        (SELECT COUNT(*) FROM user_shops WHERE shop_id = s.id) as user_count,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = s.id) as total_revenue,
        (SELECT MAX(created_at) FROM sales WHERE shop_id = s.id) as last_sale_at,
        (SELECT MAX(created_at) FROM products WHERE shop_id = s.id) as last_product_at
      FROM shops s
      LEFT JOIN tenants t ON t.id = s.tenant_id
      LEFT JOIN user_shops us ON us.shop_id = s.id AND us.role = 'owner'
      LEFT JOIN "user" u ON u.id = us.user_id
      ${whereClause}
      ORDER BY s.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, limit, offset]);

    return c.json({
      success: true,
        data: result.rows.map(r => ({
          id: r.id, name: r.name, businessName: r.business_name, address: r.address,
          phone: r.phone, email: r.email,
          branchName: r.branch_name, isActive: r.is_active, createdAt: r.created_at,
        tenantId: r.tenant_id, tenantName: r.tenant_name, tenantEmail: r.tenant_email,
        ownerId: r.owner_id, ownerName: r.owner_name, ownerEmail: r.owner_email,
        ownerLastLogin: r.owner_last_login,
        productCount: parseInt(r.product_count), saleCount: parseInt(r.sale_count),
        userCount: parseInt(r.user_count), totalRevenue: parseFloat(r.total_revenue),
        lastSaleAt: r.last_sale_at, lastProductAt: r.last_product_at
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message, data: [], pagination: null }, 500);
  }
});

adminRoutes.get('/shop/:id', async (c: any) => {
  try {
    const shopId = c.req.param('id');

    const shop = await pool.query(`
      SELECT s.*, t.name as tenant_name, t.email as tenant_email,
        (SELECT COUNT(*) FROM products WHERE shop_id = s.id) as product_count,
        (SELECT COUNT(*) FROM sales WHERE shop_id = s.id) as sale_count,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE shop_id = s.id) as total_revenue
      FROM shops s LEFT JOIN tenants t ON t.id = s.tenant_id WHERE s.id = $1
    `, [shopId]);

    if (shop.rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);

    const products = await pool.query(`
      SELECT id, name, sku, price, stock_quantity, is_active, created_at
      FROM products WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 50
    `, [shopId]);

    const sales = await pool.query(`
      SELECT sa.id, sa.total_amount, sa.payment_method, sa.created_at, u.name as seller_name
      FROM sales sa LEFT JOIN "user" u ON u.id = sa.seller_id
      WHERE sa.shop_id = $1 ORDER BY sa.created_at DESC LIMIT 20
    `, [shopId]);

    const users = await pool.query(`
      SELECT u.id, u.name, u.email, u.role, u.banned, us.role as shop_role, u.created_at
      FROM "user" u JOIN user_shops us ON u.id = us.user_id WHERE us.shop_id = $1
    `, [shopId]);

    return c.json({
      success: true,
      data: {
        shop: shop.rows[0],
        products: products.rows,
        sales: sales.rows,
        users: users.rows
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── FREE TRIAL STATISTICS ────────────────────────────────────────────────────────────
adminRoutes.get('/trial/stats', async (c) => {
  const now = new Date();

  try {
    // Overall trial statistics
    const statsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE trial_activated = true) as total_activated,
        COUNT(*) FILTER (WHERE trial_activated = true AND trial_end > $1) as active_now,
        COUNT(*) FILTER (WHERE trial_activated = true AND trial_end <= $1) as expired,
        COUNT(*) FILTER (WHERE trial_activated = false) as not_activated,
        COUNT(*) FILTER (WHERE trial_activated = true AND trial_end > $1 AND NOT EXISTS (
          SELECT 1 FROM tenant_subscriptions ts2
          WHERE ts2.tenant_id = tenants.id AND ts2.status = 'active' AND ts2.current_period_end > $1
        )) as active_trial_no_paid,
        COUNT(*) FILTER (WHERE trial_activated = true AND EXISTS (
          SELECT 1 FROM tenant_subscriptions ts3
          WHERE ts3.tenant_id = tenants.id AND ts3.status = 'active' AND ts3.current_period_end > $1
        )) as converted_to_paid
      FROM tenants
    `, [now]);

    const stats = statsResult.rows[0];

    // Conversion rate
    const totalActivated = parseInt(stats.total_activated) || 0;
    const convertedToPaid = parseInt(stats.converted_to_paid) || 0;
    const conversionRate = totalActivated > 0 ? Math.round((convertedToPaid / totalActivated) * 100) : 0;

    // Average trial usage (days used before conversion or expiry)
    const avgUsageResult = await pool.query(`
      SELECT AVG(
        CASE
          WHEN trial_end IS NOT NULL AND trial_start IS NOT NULL
          THEN EXTRACT(EPOCH FROM (trial_end - trial_start)) / 86400
          ELSE 0
        END
      ) as avg_trial_days
      FROM tenants
      WHERE trial_activated = true
    `);
    const avgTrialDays = parseFloat(avgUsageResult.rows[0]?.avg_trial_days) || 0;

    // Recent trial activations (last 30 days)
    const recentResult = await pool.query(`
      SELECT COUNT(*) FROM tenants
      WHERE trial_activated = true AND trial_start >= $1
    `, [new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)]);
    const recentActivations = parseInt(recentResult.rows[0].count) || 0;

    return c.json({
      success: true,
      data: {
        overview: {
          totalActivated,
          activeNow: parseInt(stats.active_now) || 0,
          expired: parseInt(stats.expired) || 0,
          notActivated: parseInt(stats.not_activated) || 0,
          activeTrialNoPaid: parseInt(stats.active_trial_no_paid) || 0,
          convertedToPaid,
          conversionRate,
          avgTrialDays: Math.round(avgTrialDays * 10) / 10,
          recentActivations,
        },
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── FREE TRIAL USERS LIST ────────────────────────────────────────────────────────────
adminRoutes.get('/trial/users', async (c) => {
  try {
    const status = c.req.query('status'); // 'active', 'expired', 'converted', 'all'
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;
    const now = new Date();

    // All filter conditions compare against "now". The count query binds it as
    // $1; the list query ALSO binds now as $1, so the same clause is valid for
    // both — never append unreferenced params (Postgres errors on those).
    let whereClause = 'WHERE t.trial_activated = true';

    if (status === 'active') {
      whereClause += ` AND t.trial_end > $1`;
    } else if (status === 'expired') {
      whereClause += ` AND t.trial_end <= $1`;
    } else if (status === 'converted') {
      whereClause += ` AND EXISTS (
        SELECT 1 FROM tenant_subscriptions ts
        WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > $1
      )`;
    }

    // Count
    const countResult = await pool.query(`SELECT COUNT(*) FROM tenants t ${whereClause}`, [now]);
    const total = parseInt(countResult.rows[0].count);

    // List params: [$1 = now, $2 = limit, $3 = offset]
    const listParams = [now, limit, offset];
    const limitIdx = 2;
    const offsetIdx = 3;

    const result = await pool.query(`
      SELECT
        t.id, t.name, t.email, t.created_at,
        t.trial_start, t.trial_end, t.trial_activated,
        CASE
          WHEN t.trial_end > $1 THEN 'active'
          ELSE 'expired'
        END as trial_status,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM tenant_subscriptions ts
            WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > $1
          ) THEN true
          ELSE false
        END as has_paid_subscription,
        (SELECT sp.name FROM tenant_subscriptions ts
         JOIN subscription_plans sp ON sp.id = ts.plan_id
         WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > $1
         ORDER BY ts.created_at DESC LIMIT 1) as plan_name,
        (SELECT ts.current_period_end FROM tenant_subscriptions ts
         WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > $1
         ORDER BY ts.created_at DESC LIMIT 1) as subscription_end,
        (SELECT COUNT(*) FROM shops WHERE tenant_id = t.id) as shop_count,
        (SELECT COUNT(*) FROM products p JOIN shops s ON s.id = p.shop_id WHERE s.tenant_id = t.id) as product_count,
        (SELECT COUNT(*) FROM sales sa JOIN shops s ON s.id = sa.shop_id WHERE s.tenant_id = t.id) as sale_count,
        (SELECT COALESCE(SUM(sa.total_amount), 0) FROM sales sa JOIN shops s ON s.id = sa.shop_id WHERE s.tenant_id = t.id) as total_revenue,
        (SELECT u.name || ' (' || u.email || ')' FROM "user" u WHERE u.tenant_id = t.id::text AND u.role = 'admin' LIMIT 1) as admin_user
      FROM tenants t
      ${whereClause}
      ORDER BY t.trial_end ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, listParams);

    const users = result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      createdAt: r.created_at,
      trialStart: r.trial_start,
      trialEnd: r.trial_end,
      trialStatus: r.trial_status,
      hasPaidSubscription: r.has_paid_subscription,
      planName: r.plan_name,
      subscriptionEnd: r.subscription_end,
      daysRemaining: r.trial_status === 'active'
        ? Math.ceil((new Date(r.trial_end).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : 0,
      daysExpired: r.trial_status === 'expired'
        ? Math.ceil((now.getTime() - new Date(r.trial_end).getTime()) / (1000 * 60 * 60 * 24))
        : 0,
      shopCount: parseInt(r.shop_count),
      productCount: parseInt(r.product_count),
      saleCount: parseInt(r.sale_count),
      totalRevenue: parseFloat(r.total_revenue),
      adminUser: r.admin_user,
    }));

    return c.json({
      success: true,
      data: users,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message, data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } }, 500);
  }
});

// ─── EXTEND TRIAL (admin action) ──────────────────────────────────────────────────────
adminRoutes.post('/trial/:tenantId/extend', async (c: any) => {
  const adminId = c.get('userId');
  const tenantId = c.req.param('tenantId');
  const body = await c.req.json().catch(() => ({}));
  const days = Number(body.days) || 7;
  const notes = body.notes ?? '';

  try {
    const tenantResult = await pool.query(`
      SELECT trial_end, name, email FROM tenants WHERE id = $1
    `, [tenantId]);

    if (tenantResult.rows.length === 0) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }

    const tenant = tenantResult.rows[0];
    const currentEnd = tenant.trial_end ? new Date(tenant.trial_end) : new Date();
    const now = new Date();
    const newEnd = currentEnd > now ? new Date(currentEnd) : now;
    newEnd.setDate(newEnd.getDate() + days);

    await pool.query(`
      UPDATE tenants SET trial_end = $1, trial_activated = true, updated_at = NOW() WHERE id = $2
    `, [newEnd, tenantId]);

    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, target_tenant_id, notes)
      VALUES ($1, 'extend_trial', $2, $3)
    `, [adminId, tenantId, notes || `Extended trial by ${days} days. New end: ${newEnd.toISOString()}`]);

    return c.json({
      success: true,
      data: {
        tenantId,
        tenantName: tenant.name,
        newTrialEnd: newEnd,
        daysExtended: days,
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── GLOBAL TRIAL SETTINGS ────────────────────────────────────────────────────────────
adminRoutes.get('/trial/settings', async (c) => {
  try {
    await ensurePlanLimitSetup();
    const settings = await getTrialSettings();
    const tenantCount = await pool.query(`SELECT COUNT(*) FROM tenants`);
    return c.json({
      success: true,
      data: { ...settings, totalTenants: parseInt(tenantCount.rows[0].count) },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.put('/trial/settings', async (c: any) => {
  const adminId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));

  if (body.defaultDays !== undefined && (body.defaultDays < 1 || body.defaultDays > 365)) {
    return c.json({ success: false, error: 'Trial days must be between 1 and 365' }, 400);
  }

  try {
    const settings = await saveTrialSettings(body, adminId);

    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, notes)
      VALUES ($1, 'update_trial_settings', $2)
    `, [adminId, JSON.stringify({
      defaultDays: settings.defaultDays,
      enabled: settings.enabled,
      limits: settings.limits,
      features: settings.features,
      applyMode: settings.limits_apply_mode,
    })]);

    return c.json({ success: true, data: settings });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── RESET TRIALS FOR ALL TENANTS ─────────────────────────────────────────────────────
adminRoutes.post('/trial/reset-all', async (c: any) => {
  const adminId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const days = Number(body.days) || 30;

  try {
    const settingsResult = await pool.query(`SELECT value FROM system_settings WHERE key = 'trial_settings'`);
    const trialDays = days || (settingsResult.rows.length > 0
      ? (typeof settingsResult.rows[0].value === 'string' ? JSON.parse(settingsResult.rows[0].value) : settingsResult.rows[0].value)?.defaultDays ?? 14
      : 30);

    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    // Reset for tenants WITHOUT active paid subscriptions
    const result = await pool.query(`
      UPDATE tenants SET
        trial_start = $1,
        trial_end = $2,
        trial_activated = true,
        updated_at = NOW()
      WHERE NOT EXISTS (
          SELECT 1 FROM tenant_subscriptions ts
          WHERE ts.tenant_id = tenants.id
            AND ts.status = 'active'
            AND ts.current_period_end > $1
        )
      RETURNING id, name, email
    `, [now, trialEnd]);

    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, notes)
      VALUES ($1, 'reset_all_trials', $2)
    `, [adminId, `Reset trials for ${result.rowCount} tenants. New duration: ${trialDays} days. End: ${trialEnd.toISOString()}`]);

    cache.invalidate('trial:settings');
    cache.invalidateByPrefix('trial:stats');

    return c.json({
      success: true,
      data: {
        resetCount: result.rowCount,
        trialDays,
        trialEnd,
        message: `Trials reset for ${result.rowCount} tenants with ${trialDays} days`,
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── FREE-TRIAL CLEANUP (WARN + DELETE ABANDONED TRIALS) ──────────────────────────────
// All endpoints are developer-only (requireSuperAdmin above). Deletion never
// touches active trials, active subscribers, or anyone who ever completed a
// payment — eligibility is re-validated in a row-locked transaction per tenant.

adminRoutes.get('/trial/cleanup/settings', async (c) => {
  try {
    const [settings, counts] = await Promise.all([
      getTrialCleanupSettings(),
      getTrialCleanupCounts(),
    ]);
    return c.json({ success: true, data: { ...settings, counts } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

adminRoutes.put('/trial/cleanup/settings', async (c: any) => {
  const adminId = c.get('userId');
  try {
    const body = await c.req.json().catch(() => ({}));
    const settings = await saveTrialCleanupSettings(body);
    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, notes)
      VALUES ($1, 'update_trial_cleanup_settings', $2)
    `, [adminId, JSON.stringify(settings)]);
    return c.json({ success: true, data: settings });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.get('/trial/cleanup/candidates', async (c) => {
  try {
    const settings = await getTrialCleanupSettings();
    const days = Math.min(Math.max(parseInt(c.req.query('days') || String(settings.deleteAfterDays)) || settings.deleteAfterDays, 1), 365);
    const page = Math.max(parseInt(c.req.query('page') || '1') || 1, 1);
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100') || 100, 1), 500);
    const search = c.req.query('search') || '';

    const { data, total } = await listDeletionCandidates({
      minDaysExpired: days,
      search,
      limit,
      offset: (page - 1) * limit,
    });

    return c.json({
      success: true,
      data,
      meta: { days, settings },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message, data: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } }, 500);
  }
});

adminRoutes.post('/trial/cleanup/warn', async (c: any) => {
  const adminId = c.get('userId');
  try {
    const body = await c.req.json().catch(() => ({}));
    const settings = await getTrialCleanupSettings();
    const days = Math.min(Math.max(parseInt(body.days) || settings.deleteAfterDays, 1), 365);
    const tenantIds: string[] = Array.isArray(body.tenantIds) ? body.tenantIds.filter((id: any) => typeof id === 'string') : [];

    if (!body.all && tenantIds.length === 0) {
      return c.json({ success: false, error: 'Select at least one account or set all=true' }, 400);
    }

    const result = await sendWarningsForTenants({ tenantIds, all: body.all === true, minDaysExpired: days });

    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, notes)
      VALUES ($1, 'send_trial_deletion_warnings', $2)
    `, [adminId, JSON.stringify({ days, all: body.all === true, tenantIds: tenantIds.length, ...result })]);

    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.post('/trial/cleanup/delete', async (c: any) => {
  const adminId = c.get('userId');
  try {
    const body = await c.req.json().catch(() => ({}));

    if (body.confirm !== 'DELETE') {
      return c.json({ success: false, error: 'Confirmation required. Send confirm="DELETE" to permanently delete accounts.' }, 400);
    }

    const tenantIds: string[] = Array.isArray(body.tenantIds) ? body.tenantIds.filter((id: any) => typeof id === 'string') : [];
    if (!body.all && tenantIds.length === 0) {
      return c.json({ success: false, error: 'Select at least one account or set all=true' }, 400);
    }

    const settings = await getTrialCleanupSettings();
    const days = Math.min(Math.max(parseInt(body.days) || settings.deleteAfterDays, 1), 365);

    const result = await deleteEligibleTenants({
      tenantIds,
      all: body.all === true,
      minDaysExpired: days,
      notify: body.notify !== false,
      adminId,
    });

    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, notes)
      VALUES ($1, 'delete_expired_trial_accounts', $2)
    `, [adminId, JSON.stringify({
      days,
      all: body.all === true,
      requested: result.requested,
      deleted: result.deleted,
      skipped: result.skipped,
      failed: result.failed,
      tenants: result.results.filter(r => r.success).map(r => ({ id: r.tenantId, name: r.name, email: r.email })),
    })]);

    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

adminRoutes.post('/trial/cleanup/run', async (c: any) => {
  const adminId = c.get('userId');
  try {
    const result = await runTrialCleanup();
    await pool.query(`
      INSERT INTO admin_audit_log (admin_id, action, notes)
      VALUES ($1, 'run_trial_cleanup', $2)
    `, [adminId, JSON.stringify(result)]);
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// GET /subscriptions/stats — aggregated subscription stats
adminRoutes.get('/stats', async (c) => {
  const safeCount = async (sql: string) => {
    try {
      const r = await pool.query(sql);
      return parseInt(r.rows[0]?.count ?? 0);
    } catch { return 0; }
  };
  const safeSum = async (sql: string) => {
    try {
      const r = await pool.query(sql);
      return parseFloat(r.rows[0]?.value ?? 0);
    } catch { return 0; }
  };

  const result = {
    active_subscriptions: await safeCount(`SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = 'active' AND current_period_end > NOW()`),
    expired_subscriptions: await safeCount(`SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = 'expired'`),
    active_trials: await safeCount(`SELECT COUNT(*) as count FROM tenants WHERE trial_activated = true AND trial_end > NOW()`),
    total_tenants: await safeCount(`SELECT COUNT(*) as count FROM tenants`),
    pending_subscriptions: await safeCount(`SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = 'pending'`),
    total_plans: await safeCount(`SELECT COUNT(*) as count FROM subscription_plans`),
    total_revenue: await safeSum(`SELECT COALESCE(SUM(amount_tzs), 0) as value FROM subscription_payments WHERE status = 'completed'`),
    total_payments: await safeCount(`SELECT COUNT(*) as count FROM subscription_payments WHERE status = 'completed'`),
    expiring_soon: await safeCount(`SELECT COUNT(*) as count FROM tenant_subscriptions WHERE current_period_end BETWEEN NOW() AND NOW() + INTERVAL '7 days'`),
  };
  return c.json({ success: true, data: result });
});

// GET /subscriptions/offers — list all offers
adminRoutes.get('/offers', async (c) => {
  try {
    const result = await pool.query(`SELECT * FROM subscription_offers ORDER BY created_at DESC`);
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// POST /subscriptions/offers — create offer
adminRoutes.post('/offers', async (c: any) => {
  try {
    const { title, description, offer_type, discount_percent, bonus_days, max_uses, expires_at, tenant_ids } = await c.req.json();
    const result = await pool.query(
      `INSERT INTO subscription_offers (title, description, offer_type, discount_percent, bonus_days, max_uses, expires_at, tenant_ids, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING *`,
      [title, description, offer_type, discount_percent ?? 0, bonus_days ?? 0, max_uses ?? null, expires_at, tenant_ids ?? null]
    );
    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// PUT /subscriptions/offers/:id — update offer
adminRoutes.put('/offers/:id', async (c: any) => {
  try {
    const id = c.req.param('id');
    const { title, description, offer_type, discount_percent, bonus_days, max_uses, expires_at, tenant_ids, is_active } = await c.req.json();
    const result = await pool.query(
      `UPDATE subscription_offers SET title = COALESCE($1, title), description = COALESCE($2, description), offer_type = COALESCE($3, offer_type), discount_percent = COALESCE($4, discount_percent), bonus_days = COALESCE($5, bonus_days), max_uses = COALESCE($6, max_uses), expires_at = COALESCE($7, expires_at), tenant_ids = COALESCE($8, tenant_ids), is_active = COALESCE($9, is_active) WHERE id = $10 RETURNING *`,
      [title, description, offer_type, discount_percent, bonus_days, max_uses, expires_at, tenant_ids, is_active, id]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Offer not found' }, 404);
    return c.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// DELETE /subscriptions/offers/:id — delete offer
adminRoutes.delete('/offers/:id', async (c: any) => {
  try {
    const id = c.req.param('id');
    await pool.query(`DELETE FROM subscription_offers WHERE id = $1`, [id]);
    return c.json({ success: true, data: null });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

export default adminRoutes;
