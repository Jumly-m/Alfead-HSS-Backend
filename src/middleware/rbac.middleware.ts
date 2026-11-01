import { createMiddleware } from 'hono/factory';

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();

const PERMISSIONS: Record<string, string[]> = {
  super_admin: ['*'], // Super admin - full access
  owner: ['*'], // Shop owner - full access
  admin: [
    'sale:create', 'sale:read', 'sale:update', 'sale:delete',
    'report:read',
    'product:read', 'product:create', 'product:update', 'product:delete',
    'expense:create', 'expense:read', 'expense:update', 'expense:delete',
    'shop:create', 'shop:read', 'shop:update', 'shop:delete',
    'invoice:create', 'invoice:read', 'invoice:update',
    'user:manage', 'user:create', 'user:read', 'user:update', 'user:delete',
    'export:data',
    'stock_take:create', 'stock_take:read', 'stock_take:update', 'stock_take:complete', 'stock_take:approve',
    'settings:read', 'settings:update',
    'customer:create', 'customer:read', 'customer:update', 'customer:delete',
    'service:create', 'service:read', 'service:update', 'service:delete',
    'supplier:create', 'supplier:read', 'supplier:update', 'supplier:delete'
  ],
  // Sensitive keys are intentionally NOT granted to sellers by default and are
  // only enabled per-shop by an admin via the user_permissions toggles. Even a
  // legacy "unmanaged" seller never falls through to them (deny by default).
  seller: [
    // POS & basic sales
    'sale:create', 'sale:read', 'sale:update',
    'shop:read',
    'invoice:create', 'invoice:read', 'invoice:update',
    // Pre-orders: same as before (they had this via sale:create) but now a
    // dedicated toggle the owner can turn off.
    'preorder:create', 'preorder:read',
    // Products: sellers may VIEW but not add/edit/delete/price by default
    'product:read',
    // Customers & debts (record + view, no edit/delete by default)
    'customer:create', 'customer:read',
    'debtor:create', 'debtor:read',
    'stock_take:read',
    // Personal tools (owner can hide each of these per member)
    'notebook:read', 'subscription:read', 'support:read', 'referral:read',
    // Store requests are OFF by default — the owner enables "Omba Mzigo"
    // per seller from the team permissions screen.
  ],
  // Shift supervisor: seller baseline plus light management duties. Like every
  // member role the owner can widen or narrow this per shop from Shop Settings
  // (user_permissions toggles) — the static list is only the fallback for
  // members the owner has never configured.
  manager: [
    'sale:create', 'sale:read', 'sale:update', 'sale:profit',
    'shop:read',
    'invoice:create', 'invoice:read', 'invoice:update',
    'preorder:create', 'preorder:read', 'preorder:update',
    'product:read', 'product:create', 'product:update',
    'inventory:manage',
    'customer:create', 'customer:read', 'customer:update',
    'debtor:create', 'debtor:read', 'debtor:update',
    'expense:create', 'expense:read', 'expense:update',
    'service:read', 'service:create',
    'supplier:read',
    'report:read', 'report:profit',
    'stock_take:create', 'stock_take:read', 'stock_take:update',
    'store:request',
    'notebook:read', 'subscription:read', 'support:read', 'referral:read',
  ],
  // Back office / store (ghala) staff: warehouse duties only. No sales, no
  // POS, no customer data — just suppliers, receiving, requests, issuing,
  // store stock, store reports and physical counts (approval stays with the
  // owner/admin).
  store: [
    'store:read', 'store:manage', 'store:request',
    // Baseline: every member may read the shops/stores they belong to — this
    // is what lets the app resolve their active store after login.
    'shop:read',
    'supplier:create', 'supplier:read', 'supplier:update', 'supplier:delete',
    'product:read',
    'report:read',
    'stock_take:create', 'stock_take:read', 'stock_take:update', 'stock_take:complete',
    'notebook:read', 'subscription:read', 'support:read',
  ]
};

// Roles whose access is governed by the owner's per-shop toggles
// (user_permissions) rather than only by the static map above.
export const MEMBER_ROLES = new Set(['seller', 'manager', 'store']);

// All permission keys the system understands. Used by /api/permissions-list and
// /api/my-permissions so the front-end can render and evaluate the full set.
export const ALL_PERMISSION_KEYS = [
  // Sales & POS
  'sale:create', 'sale:read', 'sale:update', 'sale:delete', 'sale:profit',
  'invoice:create', 'invoice:read', 'invoice:update', 'invoice:delete',
  // Pre-orders (Oda za Awali)
  'preorder:create', 'preorder:read', 'preorder:update', 'preorder:delete',
  // Products
  'product:read', 'product:create', 'product:update', 'product:delete',
  'product:buying', 'product:value', 'inventory:manage',
  // Dashboard
  'dashboard:revenue', 'dashboard:profit', 'dashboard:value',
  // Customers & Debts
  'customer:create', 'customer:read', 'customer:update', 'customer:delete',
  'debtor:create', 'debtor:read', 'debtor:update', 'debtor:delete',
  // Expenses
  'expense:create', 'expense:read', 'expense:update', 'expense:delete',
  // Services (Huduma)
  'service:create', 'service:read', 'service:update', 'service:delete',
  // Suppliers
  'supplier:create', 'supplier:read', 'supplier:update', 'supplier:delete',
  // Reports, Export & Stock Take
  'report:read', 'report:profit', 'report:shops', 'export:data',
  'stock_take:create', 'stock_take:read', 'stock_take:update',
  'stock_take:complete', 'stock_take:approve',
  // Earnings & SMS
  'earning:read', 'sms:read',
  // Store / Back office (Ghala)
  'store:read', 'store:manage', 'store:request',
  // Extras members can be granted
  'notebook:read', 'subscription:read', 'support:read', 'referral:read',
  // Settings & Users
  'settings:read', 'settings:update', 'user:manage',
];

// In-memory cache for per-shop permission lookups (30s TTL) so the DB-aware
// seller check does not hit the database on every request. `configured` means
// the seller has at least one permission row for that shop — enforcement only
// bites for managed sellers; legacy sellers fall back to the static map.
const permCache = new Map<string, { configured: boolean; granted: Record<string, boolean>; expires: number }>();
const PERM_CACHE_TTL = 30 * 1000;

async function getShopPermissions(userId: string, shopId: string): Promise<{ configured: boolean; granted: Record<string, boolean> }> {
  const key = `${userId}|${shopId}`;
  const cached = permCache.get(key);
  if (cached && Date.now() < cached.expires) return cached;

  const empty = { configured: false, granted: {} };
  let result = empty;
  try {
    const { pool } = await import('../config/drizzle.js');
    const rows = await pool.query(
      `SELECT permission, granted FROM user_permissions
       WHERE user_id = $1 AND shop_id = $2`,
      [userId, shopId]
    );
    const granted: Record<string, boolean> = {};
    for (const r of rows.rows as any[]) {
      granted[r.permission] = r.granted === true;
    }
    result = { configured: Object.keys(granted).length > 0, granted };
  } catch (e: any) {
    console.error('[RBAC] permission lookup failed:', e.message);
  }
  permCache.set(key, { ...result, expires: Date.now() + PERM_CACHE_TTL });
  return result;
}

// Call after writing user_permissions so the 30s cache does not serve stale
// grants. Called by the shop-members routes whenever permissions change.
export function invalidateShopPermissions(userId: string, shopId: string): void {
  permCache.delete(`${userId}|${shopId}`);
}

// True for roles that bypass per-shop toggles entirely (owner / admin own the
// shop, developer + the configured super admin own the platform).
export function isFullAccessRole(role: string, userEmail?: string): boolean {
  return role === 'developer' || role === 'owner' || role === 'admin'
    || (!!SUPER_ADMIN_EMAIL && !!userEmail && userEmail === SUPER_ADMIN_EMAIL);
}

/**
 * Effective "can this user do X in this shop?" check for use inside controllers
 * (data scrubbing) and the /api/my-permissions endpoint. Mirrors the logic of
 * requirePermission: full-access roles always pass; sellers resolve the per-shop
 * toggles from user_permissions and fall back to the static map when unmanaged.
 */
export async function hasPermission(
  userId: string,
  role: string,
  shopId: string,
  permission: string,
  userEmail?: string
): Promise<boolean> {
  if (isFullAccessRole(role, userEmail)) return true;
  if (MEMBER_ROLES.has(role) && shopId) {
    // Baseline: a member may always read the shops they belong to (the list
    // endpoint is filtered to their memberships and /shops/:id is validated).
    if (permission === 'shop:read') return true;
    const { configured, granted } = await getShopPermissions(userId, shopId);
    if (configured) return granted[permission] === true;
  }
  return (PERMISSIONS[role] || []).includes(permission);
}

/**
 * Effective granted map across ALL known permission keys for a user in a shop.
 * Used by /api/my-permissions so the client can gate menus and fields. Admin/
 * owner/developer get everything; sellers get per-shop toggles (or static map).
 */
export async function getEffectivePermissions(
  userId: string,
  role: string,
  shopId: string,
  userEmail?: string
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const key of ALL_PERMISSION_KEYS) {
    out[key] = await hasPermission(userId, role, shopId, key, userEmail);
  }
  return out;
}

export const requirePermission = (permission: string) => {
  return createMiddleware(async (c, next) => {
    const role = c.get('userRole');
    const userId = c.get('userId');
    const userEmail = c.get('user')?.email?.toLowerCase();
    const userPermissions = PERMISSIONS[role] || [];

    // Owner, admin, developer and the configured super admin always pass —
    // per-shop permission toggles are for member roles (seller/manager/store).
    const fullAccessRole = role === 'developer' || role === 'owner' || role === 'admin' || userEmail === SUPER_ADMIN_EMAIL;
    if (fullAccessRole || userPermissions.includes('*')) {
      await next();
      return;
    }

    // Member roles (seller / manager / store): enforce the owner's per-shop
    // toggles for THIS shop. Resolve the active shop from shopContext
    // middleware, else ?shopId=, else body.shopId.
    if (MEMBER_ROLES.has(role)) {
      const activeShopId = c.get('activeShopId');
      const queryShopId = c.req.query('shopId');
      let bodyShopId: string | null = null;
      if (!activeShopId && !queryShopId) {
        try {
          const body: any = await c.req.json();
          bodyShopId = typeof body?.shopId === 'string' ? body.shopId : null;
        } catch { /* not a JSON body */ }
      }
      const shopId = activeShopId || queryShopId || bodyShopId || ((c.get('shopIds') as string[]) || [])[0];

      if (shopId) {
        // Never let a member act on a shop they don't belong to, even if their
        // static role map would otherwise allow the permission (pre-existing
        // unmanaged members). Prevents cross-shop data access by ID tampering.
        const shopIds = (c.get('shopIds') as string[]) || [];
        if (!shopIds.includes(shopId)) {
          console.log(`[RBAC] Forbidden - ${role}: ${userId}, target shop: ${shopId}, not a member`);
          return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
        }

        // shop:read is a baseline — a member may always read the shops they are
        // a member of (the list endpoint is already filtered to shopIds, and
        // /shops/:id is validated against membership right above). It is
        // intentionally NOT a toggleable permission.
        if (permission === 'shop:read') {
          await next();
          return;
        }

        const { configured, granted } = await getShopPermissions(userId, shopId);
        if (configured) {
          if (granted[permission]) {
            await next();
            return;
          }
          console.log(`[RBAC] Forbidden - ${role}: ${userId}, shop: ${shopId}, permission: ${permission}`);
          return c.json({ success: false, error: 'Forbidden - Insufficient permissions for this shop' }, 403);
        }
        // Not managed via per-shop toggles yet → fall through to legacy static map.
      } else if (permission === 'shop:read' && ((c.get('shopIds') as string[]) || []).length > 0) {
        // Baseline even before an active shop is resolved (first login).
        await next();
        return;
      }
      // No shop resolved: fall through to the legacy static map below.
    }

    if (userPermissions.includes(permission)) {
      await next();
    } else {
      console.log(`[RBAC] Forbidden - role: ${role}, permission: ${permission}, hasPermissions: ${JSON.stringify(userPermissions)}`);
      return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
    }
  });
};

/**
 * Gate on ANY of the given permissions (OR semantics). Useful for endpoints
 * where either permission is sufficient — e.g. a seller granted only
 * `expense:create` may still list expense categories to pick from, while
 * admins keep working via `settings:update`.
 */
export const requireAnyPermission = (...permissions: string[]) => {
  return createMiddleware(async (c, next) => {
    const role = c.get('userRole');
    const userId = c.get('userId');
    const userEmail = c.get('user')?.email?.toLowerCase();
    const userPermissions = PERMISSIONS[role] || [];

    const fullAccessRole = role === 'developer' || role === 'owner' || role === 'admin' || userEmail === SUPER_ADMIN_EMAIL;
    if (fullAccessRole || userPermissions.includes('*')) {
      await next();
      return;
    }

    if (MEMBER_ROLES.has(role)) {
      const activeShopId = c.get('activeShopId');
      const queryShopId = c.req.query('shopId');
      let bodyShopId: string | null = null;
      if (!activeShopId && !queryShopId) {
        try {
          const body: any = await c.req.json();
          bodyShopId = typeof body?.shopId === 'string' ? body.shopId : null;
        } catch { /* not a JSON body */ }
      }
      const shopId = activeShopId || queryShopId || bodyShopId || ((c.get('shopIds') as string[]) || [])[0];

      if (shopId) {
        const shopIds = (c.get('shopIds') as string[]) || [];
        if (!shopIds.includes(shopId)) {
          return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
        }
        const { configured, granted } = await getShopPermissions(userId, shopId);
        if (configured) {
          if (permissions.some(p => granted[p])) {
            await next();
            return;
          }
          return c.json({ success: false, error: 'Forbidden - Insufficient permissions for this shop' }, 403);
        }
      }
    }

    if (permissions.some(p => userPermissions.includes(p))) {
      await next();
    } else {
      return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
    }
  });
};

// Check if user is super admin (by role OR by email)
export const isSuperAdmin = (userId: string, userEmail?: string): Promise<boolean> => {
  return new Promise(async (resolve) => {
    try {
      // First check if it's the configured super admin email
      if (SUPER_ADMIN_EMAIL && userEmail?.toLowerCase() === SUPER_ADMIN_EMAIL) {
        resolve(true);
        return;
      }
      
      const { pool } = await import('../config/drizzle.js');
      const result = await pool.query('SELECT role, email FROM "user" WHERE id = $1', [userId]);
      const user = result.rows[0];
      
      // Check by role OR by email
      const isRoleSuperAdmin = user?.role === 'developer';
      const isEmailSuperAdmin = !!(SUPER_ADMIN_EMAIL && user?.email?.toLowerCase() === SUPER_ADMIN_EMAIL);
      
      resolve(isRoleSuperAdmin || isEmailSuperAdmin);
    } catch {
      resolve(false);
    }
  });
};
