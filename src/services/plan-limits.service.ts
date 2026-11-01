// =====================================================
// PLAN LIMITS & FEATURE ENTITLEMENTS
// =====================================================
// Resolves what a tenant is allowed to do based on:
//   - an active paid subscription → its plan's limits/features, or
//   - an active free trial      → the global trial limits/features, or
//   - no active plan            → full access (the paywall handles expiry).
//
// Grandfathering ("New users only" mode): when a plan or the trial settings
// are saved with apply_mode='new', limits_effective_from is stamped with NOW().
// Subscriptions/trials that started BEFORE that timestamp keep full access —
// so changing limits never disrupts users who were already subscribed.

import { pool } from '../config/drizzle.js';
import cache from '../utils/cache.js';

// Feature keys that can be toggled per plan. Core modules (dashboard, POS,
// products, sales, invoices, settings) are always available.
export const FEATURE_CATALOG = [
  { key: 'reports', label: 'Reports & Profits', description: 'Sales/profit reports and shop reports' },
  { key: 'expenses', label: 'Expenses', description: 'Record and manage business expenses' },
  { key: 'debts', label: 'Debts (Madeni)', description: 'Debtors, payments and reminders' },
  { key: 'customers', label: 'Customers', description: 'Customer database' },
  { key: 'suppliers', label: 'Suppliers', description: 'Supplier management' },
  { key: 'services', label: 'Services', description: 'Service jobs and pricing' },
  { key: 'categories', label: 'Categories', description: 'Product categories' },
  { key: 'units', label: 'Units', description: 'Units and conversions' },
  { key: 'stock_take', label: 'Stock Take', description: 'Stock taking sessions' },
  { key: 'preorders', label: 'Pre-orders', description: 'Customer pre-orders and deposits' },
  { key: 'sms', label: 'SMS Center & Bulk SMS', description: 'SMS sending, campaigns and contacts' },
  { key: 'ai', label: 'AI Intelligence', description: 'AI advisor and AI selling assistant' },
  { key: 'export', label: 'Data Export', description: 'Export data to Excel/PDF' },
  { key: 'backups', label: 'Cloud Backups', description: 'Automatic cloud backup and restore' },
] as const;

export const FEATURE_KEYS = FEATURE_CATALOG.map(f => f.key) as string[];

// API path prefix → feature key. Used by subscriptionGuard to block disabled
// modules before they reach their route handlers.
const PATH_FEATURES: [string, string][] = [
  ['/api/reports', 'reports'],
  ['/api/shop-reports', 'reports'],
  ['/api/profits', 'reports'],
  ['/api/expenses', 'expenses'],
  ['/api/debtors', 'debts'],
  ['/api/customers', 'customers'],
  ['/api/suppliers', 'suppliers'],
  ['/api/services', 'services'],
  ['/api/categories', 'categories'],
  ['/api/units', 'units'],
  ['/api/stock-take', 'stock_take'],
  ['/api/pre-orders', 'preorders'],
  ['/api/sms', 'sms'],
  ['/api/ai', 'ai'],
  ['/api/ai-advisor', 'ai'],
  ['/api/export', 'export'],
  ['/api/backups', 'backups'],
  ['/api/backup-notifications', 'backups'],
];

export function featureForPath(path: string): string | null {
  for (const [prefix, feature] of PATH_FEATURES) {
    if (path.startsWith(prefix)) return feature;
  }
  return null;
}

export type PlanLimits = {
  max_products: number | null;
  max_admins: number | null;
  max_sellers: number | null;
  max_shops: number | null;
};

export type Entitlements = {
  source: 'plan' | 'trial' | 'full';
  planName: string | null;
  grandfathered: boolean;
  limits: PlanLimits;
  // null = every feature enabled (legacy/unrestricted)
  features: string[] | null;
};

export const DEFAULT_TRIAL_LIMITS: PlanLimits = {
  max_products: 100,
  max_admins: 1,
  max_sellers: 1,
  max_shops: 1,
};

export const DEFAULT_TRIAL_FEATURES: string[] = [
  'reports', 'expenses', 'debts', 'customers', 'suppliers', 'services', 'categories', 'units',
];

const FULL_ENTITLEMENTS: Entitlements = {
  source: 'full',
  planName: null,
  grandfathered: true,
  limits: { max_products: null, max_admins: null, max_sellers: null, max_shops: null },
  features: null,
};

function emptyLimits(): PlanLimits {
  return { max_products: null, max_admins: null, max_sellers: null, max_shops: null };
}

function normalizeFeatures(value: any): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.filter((k: any) => typeof k === 'string');
  return null;
}

function normalizeLimit(value: any): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

// ─── SETUP (idempotent — safe on every boot) ─────────────────────────────────

let setupDone = false;

export async function ensurePlanLimitSetup(): Promise<void> {
  if (setupDone) return;
  setupDone = true;
  try {
    await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_products INTEGER`);
    await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_admins INTEGER`);
    await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features JSONB`);
    await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS limits_effective_from TIMESTAMP`);
    await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS limits_apply_mode VARCHAR(20) DEFAULT 'new'`);
    await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS full_access BOOLEAN DEFAULT FALSE`);

    // One-time trial migration: 14 days + default limits/features. Existing
    // trials are grandfathered via limits_effective_from = NOW().
    const row = await pool.query(`SELECT value FROM system_settings WHERE key = 'trial_settings'`);
    const current: any = row.rows[0]?.value || {};
    const firstTime = current.limits === undefined || current.features === undefined;
    const merged = {
      ...current,
      defaultDays: firstTime ? 14 : (current.defaultDays ?? 14),
      limits: current.limits ?? DEFAULT_TRIAL_LIMITS,
      features: current.features ?? DEFAULT_TRIAL_FEATURES,
      limits_effective_from: current.limits_effective_from ?? new Date().toISOString(),
      limits_apply_mode: current.limits_apply_mode ?? 'new',
    };
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('trial_settings', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
  } catch (e: any) {
    setupDone = false;
    console.error('[PlanLimits] Setup error:', e.message);
  }
}

// ─── TRIAL SETTINGS ──────────────────────────────────────────────────────────

export type TrialSettings = {
  enabled: boolean;
  defaultDays: number;
  autoActivate: boolean;
  limits: PlanLimits;
  features: string[] | null;
  limits_effective_from: string | null;
  limits_apply_mode: 'new' | 'all';
};

export async function getTrialSettings(): Promise<TrialSettings> {
  return cache.getOrSet('trial:settings', async () => {
    try {
      const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'trial_settings'`);
      const val: any = result.rows[0]?.value || {};
      return {
        enabled: val.enabled ?? true,
        defaultDays: Number(val.defaultDays) || 14,
        autoActivate: val.autoActivate ?? true,
        limits: {
          max_products: normalizeLimit(val.limits?.max_products),
          max_admins: normalizeLimit(val.limits?.max_admins),
          max_sellers: normalizeLimit(val.limits?.max_sellers),
          max_shops: normalizeLimit(val.limits?.max_shops),
        },
        features: normalizeFeatures(val.features) ?? DEFAULT_TRIAL_FEATURES,
        limits_effective_from: val.limits_effective_from ?? null,
        limits_apply_mode: val.limits_apply_mode === 'all' ? 'all' : 'new',
      };
    } catch {
      return {
        enabled: true,
        defaultDays: 14,
        autoActivate: true,
        limits: { ...DEFAULT_TRIAL_LIMITS },
        features: [...DEFAULT_TRIAL_FEATURES],
        limits_effective_from: null,
        limits_apply_mode: 'new',
      };
    }
  }, 300);
}

export async function saveTrialSettings(input: any, adminId?: string | null): Promise<TrialSettings> {
  await ensurePlanLimitSetup();
  const current = await getTrialSettings();

  const nextLimits: PlanLimits = {
    max_products: input?.limits?.max_products !== undefined ? normalizeLimit(input.limits.max_products) : current.limits.max_products,
    max_admins: input?.limits?.max_admins !== undefined ? normalizeLimit(input.limits.max_admins) : current.limits.max_admins,
    max_sellers: input?.limits?.max_sellers !== undefined ? normalizeLimit(input.limits.max_sellers) : current.limits.max_sellers,
    max_shops: input?.limits?.max_shops !== undefined ? normalizeLimit(input.limits.max_shops) : current.limits.max_shops,
  };
  const nextFeatures = Array.isArray(input?.features)
    ? input.features.filter((k: any) => FEATURE_KEYS.includes(k))
    : current.features;

  const applyMode: 'new' | 'all' = input?.applyMode === 'all' ? 'all' : (input?.applyMode === 'new' ? 'new' : 'new');
  const limitsChanged =
    JSON.stringify(nextLimits) !== JSON.stringify(current.limits) ||
    JSON.stringify(nextFeatures) !== JSON.stringify(current.features);

  let effectiveFrom = current.limits_effective_from;
  if (applyMode === 'all') effectiveFrom = null;
  else if (limitsChanged) effectiveFrom = new Date().toISOString();

  const defaultDays = Number(input?.defaultDays);
  const merged = {
    enabled: input?.enabled ?? current.enabled,
    defaultDays: Number.isFinite(defaultDays) && defaultDays >= 1 && defaultDays <= 365 ? Math.round(defaultDays) : current.defaultDays,
    autoActivate: input?.autoActivate ?? current.autoActivate,
    limits: nextLimits,
    features: nextFeatures,
    limits_effective_from: effectiveFrom,
    limits_apply_mode: applyMode,
    updatedAt: new Date().toISOString(),
    updatedBy: adminId ?? null,
  };

  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('trial_settings', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(merged)]
  );
  cache.invalidate('trial:settings');
  cache.invalidateByPrefix('tenant:entitlements:');
  return { ...merged, limits_apply_mode: applyMode } as TrialSettings;
}

// ─── ENTITLEMENTS ────────────────────────────────────────────────────────────

async function subscriptionEnabled(): Promise<boolean> {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'subscription'`);
    if (result.rows.length === 0) return false;
    const val: any = result.rows[0].value;
    return val?.enabled ?? false;
  } catch {
    return false;
  }
}

export async function getEntitlements(tenantId: string): Promise<Entitlements> {
  if (!tenantId) return FULL_ENTITLEMENTS;
  return cache.getOrSet(`tenant:entitlements:${tenantId}`, async () => {
    if (!(await subscriptionEnabled())) return FULL_ENTITLEMENTS;

    // Active paid subscription → plan entitlements
    const sub = await pool.query(`
      SELECT ts.created_at,
             sp.name AS plan_name, sp.max_products, sp.max_admins, sp.max_sellers, sp.max_shops,
             sp.features, sp.limits_effective_from, sp.full_access
      FROM tenant_subscriptions ts
      JOIN subscription_plans sp ON sp.id = ts.plan_id
      WHERE ts.tenant_id = $1 AND ts.status = 'active' AND ts.current_period_end > NOW()
      ORDER BY ts.created_at DESC
      LIMIT 1
    `, [tenantId]);

    if (sub.rows.length > 0) {
      const s = sub.rows[0];
      // Plans explicitly marked "Full access" always keep every feature and no limits.
      if (s.full_access === true) {
        return { source: 'plan', planName: s.plan_name, grandfathered: true, limits: emptyLimits(), features: null };
      }
      const grandfathered = !!(s.limits_effective_from && s.created_at && new Date(s.created_at) < new Date(s.limits_effective_from));
      if (grandfathered) {
        return { source: 'plan', planName: s.plan_name, grandfathered: true, limits: emptyLimits(), features: null };
      }
      return {
        source: 'plan',
        planName: s.plan_name,
        grandfathered: false,
        limits: {
          max_products: normalizeLimit(s.max_products),
          max_admins: normalizeLimit(s.max_admins),
          max_sellers: normalizeLimit(s.max_sellers),
          max_shops: normalizeLimit(s.max_shops),
        },
        features: normalizeFeatures(s.features),
      };
    }

    // Active free trial → trial entitlements (unless grandfathered)
    const tenant = await pool.query(`SELECT trial_start, trial_end, trial_activated FROM tenants WHERE id = $1`, [tenantId]);
    const t = tenant.rows[0];
    if (t?.trial_activated && t.trial_end && new Date(t.trial_end) > new Date()) {
      const settings = await getTrialSettings();
      // Compare in SQL so both sides use the database's timestamp convention
      // (the JSON setting is an ISO instant, the column is timestamp without TZ).
      let grandfathered = false;
      if (settings.limits_effective_from) {
        const g = await pool.query(
          `SELECT (trial_start IS NOT NULL AND trial_start < $2::timestamp) AS grandfathered FROM tenants WHERE id = $1`,
          [tenantId, settings.limits_effective_from]
        );
        grandfathered = g.rows[0]?.grandfathered === true;
      }
      if (grandfathered) {
        return { source: 'trial', planName: 'Free Trial', grandfathered: true, limits: emptyLimits(), features: null };
      }
      return { source: 'trial', planName: 'Free Trial', grandfathered: false, limits: settings.limits, features: settings.features };
    }

    // No active plan — the subscription guard handles expiry; no extra limits.
    return FULL_ENTITLEMENTS;
  }, 30);
}

export function isFeatureEnabled(ent: Entitlements, feature: string): boolean {
  if (ent.features === null) return true;
  return ent.features.includes(feature);
}

// ─── USAGE & LIMIT CHECKS ────────────────────────────────────────────────────
//
// Subscription billing is switched off, so plan limits are NOT enforced: the
// product/shop/admin/seller checks below always allow the action. Usage and
// entitlement helpers are kept because the developer dashboard still displays
// them (read-only stats). To re-enable limits, restore the previous bodies
// that delegate to checkResource().

export type Usage = { products: number; shops: number; admins: number; sellers: number };

export async function getUsage(tenantId: string): Promise<Usage> {
  const [products, shops, admins, sellers] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM products p JOIN shops s ON s.id = p.shop_id WHERE s.tenant_id = $1::uuid`, [tenantId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM shops WHERE tenant_id = $1::uuid AND COALESCE(is_super_admin, false) = false`, [tenantId]),
    pool.query(`
      SELECT COUNT(DISTINCT u.id)::int AS count FROM "user" u
      WHERE (u.tenant_id = $1::text AND u.role IN ('admin', 'owner'))
         OR EXISTS (
           SELECT 1 FROM user_shops us JOIN shops s ON s.id = us.shop_id
           WHERE us.user_id = u.id AND s.tenant_id = $1::uuid AND us.role IN ('admin', 'owner')
         )`, [tenantId]),
    pool.query(`
      SELECT COUNT(DISTINCT u.id)::int AS count FROM "user" u
      WHERE (u.tenant_id = $1::text AND u.role IN ('seller', 'manager'))
         OR EXISTS (
           SELECT 1 FROM user_shops us JOIN shops s ON s.id = us.shop_id
           WHERE us.user_id = u.id AND s.tenant_id = $1::uuid AND us.role IN ('seller', 'manager')
         )`, [tenantId]),
  ]);
  return {
    products: products.rows[0]?.count || 0,
    shops: shops.rows[0]?.count || 0,
    admins: admins.rows[0]?.count || 0,
    sellers: sellers.rows[0]?.count || 0,
  };
}

export type LimitCheck = {
  allowed: boolean;
  resource: 'products' | 'shops' | 'admins' | 'sellers';
  limit: number | null;
  current: number;
  planName: string | null;
  message?: string;
};

function limitMessage(resource: string, limit: number, planName: string | null): string {
  const plan = planName ? ` (${planName})` : '';
  switch (resource) {
    case 'products':
      return `Umefikia kikomo cha bidhaa ${limit} kwa kifurushi chako${plan}. Panda kifurushi ili kuongeza bidhaa zaidi.`;
    case 'shops':
      return `Umefikia kikomo cha maduka ${limit} kwa kifurushi chako${plan}. Panda kifurushi ili kuongeza duka lingine.`;
    case 'admins':
      return `Umefikia kikomo cha admin ${limit} kwa kifurushi chako${plan}. Panda kifurushi ili kuongeza admin mwingine.`;
    case 'sellers':
      return `Umefikia kikomo cha wauzaji ${limit} kwa kifurushi chako${plan}. Panda kifurushi ili kuongeza muuzaji mwingine.`;
    default:
      return `Umefikia kikomo cha kifurushi chako${plan}.`;
  }
}

async function checkResource(tenantId: string, resource: 'products' | 'shops' | 'admins' | 'sellers', adding = 1): Promise<LimitCheck> {
  const ent = await getEntitlements(tenantId);
  const limitKey = resource === 'admins' ? 'max_admins' : resource === 'sellers' ? 'max_sellers' : resource === 'shops' ? 'max_shops' : 'max_products';
  const limit = ent.limits[limitKey as keyof PlanLimits];

  if (ent.grandfathered || limit === null) {
    return { allowed: true, resource, limit: null, current: 0, planName: ent.planName };
  }

  const usage = await getUsage(tenantId);
  const current = resource === 'products' ? usage.products : resource === 'shops' ? usage.shops : resource === 'admins' ? usage.admins : usage.sellers;
  const allowed = current + adding <= limit;
  return {
    allowed,
    resource,
    limit,
    current,
    planName: ent.planName,
    message: allowed ? undefined : limitMessage(resource, limit, ent.planName),
  };
}

function unlimited(resource: LimitCheck['resource']): LimitCheck {
  return { allowed: true, resource, limit: null, current: 0, planName: null };
}

export async function checkProductLimit(_tenantId: string, _adding = 1) {
  return unlimited('products');
}
export async function checkShopLimit(_tenantId: string, _adding = 1) {
  return unlimited('shops');
}
export async function checkAdminLimit(_tenantId: string, _adding = 1) {
  return unlimited('admins');
}
export async function checkSellerLimit(_tenantId: string, _adding = 1) {
  return unlimited('sellers');
}

// Convenience for routes: returns the JSON error payload or null when allowed.
export function limitErrorResponse(check: LimitCheck) {
  if (check.allowed) return null;
  return {
    success: false,
    error: 'plan_limit_reached',
    resource: check.resource,
    limit: check.limit,
    current: check.current,
    planName: check.planName,
    message: check.message,
  };
}
