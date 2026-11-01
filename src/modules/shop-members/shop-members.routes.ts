import { Hono } from 'hono';
import { db } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import { authMiddleware, invalidateUserAuthCache } from '../../middleware/auth.middleware.js';
import { shopContext } from '../../middleware/shop-context.middleware.js';
import { invalidateShopPermissions } from '../../middleware/rbac.middleware.js';
import { checkSellerLimit, limitErrorResponse } from '../../services/plan-limits.service.js';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
    activeShopId: string;
    activeShopRole: string;
  }
}>();

// Every route here acts on "the shop the admin is currently switched into" -
// shopContext reads ?shopId= (or body.shopId) and validates access.
router.use('*', authMiddleware, shopContext);

// A member can manage other members if they are the shop owner, or if the
// owner has explicitly granted them the 'user:manage' permission for this
// shop via the per-shop toggles.
async function canManageMembers(c: any): Promise<boolean> {
  const role = c.get('activeShopRole');
  if (role === 'owner') return true;
  const userId = c.get('userId') as string;
  const shopId = c.get('activeShopId') as string;
  try {
    const result = await db.read(
      `SELECT granted FROM user_permissions WHERE user_id = $1 AND shop_id = $2 AND permission = 'user:manage'`,
      [userId, shopId]
    );
    return result.rows[0]?.granted === true;
  } catch {
    return false;
  }
}

const requireMemberManager = async (c: any, next: any) => {
  if (await canManageMembers(c)) return next();
  return c.json({ success: false, error: 'Only the shop owner can manage members' }, 403);
};

// A member who belongs to exactly ONE shop has their account role follow that
// membership (so a store-only user gets the back-office app shell + redirect).
// Multi-shop members keep their account role; per-shop permissions govern each
// shop and their nav is the union of what they may access.
async function syncGlobalRoleIfSingleShop(targetUserId: string, membershipRole: string) {
  if (!['seller', 'manager', 'store'].includes(membershipRole)) return;
  const countRes = await db.read(`SELECT COUNT(*)::int as n FROM user_shops WHERE user_id = $1`, [targetUserId]);
  if (Number(countRes.rows[0]?.n || 0) !== 1) return;
  const userRes = await db.read(`SELECT role FROM "user" WHERE id = $1`, [targetUserId]);
  const globalRole = userRes.rows[0]?.role;
  if (['seller', 'manager', 'store'].includes(globalRole) && globalRole !== membershipRole) {
    await pool.query(`UPDATE "user" SET role = $1, updated_at = NOW() WHERE id = $2`, [membershipRole, targetUserId]);
    invalidateUserAuthCache(targetUserId);
  }
}

// Roles an owner may assign to a shop member.
const ASSIGNABLE_ROLES = ['seller', 'manager', 'store'];

// Sane defaults per role. Every permission key the UI exposes is written
// up-front so per-shop enforcement (rbac.middleware.ts) knows the member is
// "managed" and the owner can flip any toggle immediately after adding them.
function defaultPermissionsForRole(role: string): Record<string, boolean> {
  // Cashier-level baseline (seller)
  const sellerDefaults: Record<string, boolean> = {
    // Sales & POS
    'sale:create': true,
    'sale:read': true,
    'sale:update': false,
    'sale:delete': false,
    'sale:profit': false,
    'invoice:create': false,
    'invoice:read': false,
    'invoice:update': false,
    'invoice:delete': false,
    // Products
    'product:read': true,
    'product:create': false,
    'product:update': false,
    'product:delete': false,
    'product:buying': false,
    'product:value': false,
    'inventory:manage': false,
    // Dashboard (revenue, profit, stock value hidden by default)
    'dashboard:revenue': false,
    'dashboard:profit': false,
    'dashboard:value': false,
    // Customers & Debts
    'customer:create': true,
    'customer:read': true,
    'customer:update': false,
    'customer:delete': false,
    'debtor:create': true,
    'debtor:read': true,
    'debtor:update': false,
    'debtor:delete': false,
    // Expenses
    'expense:create': false,
    'expense:read': false,
    'expense:update': false,
    'expense:delete': false,
    // Services (Huduma)
    'service:create': false,
    'service:read': false,
    'service:update': false,
    'service:delete': false,
    // Suppliers (Wasambazaji)
    'supplier:create': false,
    'supplier:read': false,
    'supplier:update': false,
    'supplier:delete': false,
    // Reports, Export & Stock Take
    'report:read': false,
    'report:profit': false,
    'report:shops': false,
    'export:data': false,
    'stock_take:create': false,
    'stock_take:read': false,
    'stock_take:update': false,
    'stock_take:complete': false,
    'stock_take:approve': false,
    // Earnings & SMS (hidden by default)
    'earning:read': false,
    'sms:read': false,
    // Store / Back office — OFF by default: the owner decides whether this
    // seller may request goods from the store.
    'store:request': false,
    'store:read': false,
    'store:manage': false,
    // Settings & Users
    'settings:read': false,
    'settings:update': false,
    'user:manage': false,
  };

  if (role === 'store') {
    // Warehouse / back-office defaults: store duties ON, sales & money OFF.
    return {
      ...sellerDefaults,
      'sale:create': false,
      'sale:read': false,
      'sale:update': false,
      'customer:create': false,
      'customer:read': false,
      'debtor:create': false,
      'debtor:read': false,
      'store:read': true,
      'store:manage': true,
      'store:request': true,
      'supplier:create': true,
      'supplier:read': true,
      'supplier:update': true,
      'supplier:delete': false,
      'report:read': true,
      'stock_take:create': true,
      'stock_take:read': true,
      'stock_take:update': true,
      'stock_take:complete': true,
      'stock_take:approve': false,
    };
  }

  if (role === 'manager') {
    // Shift supervisor: seller baseline plus reporting and light management.
    return {
      ...sellerDefaults,
      'sale:profit': true,
      'invoice:create': true,
      'invoice:read': true,
      'invoice:update': true,
      'product:create': true,
      'product:update': true,
      'inventory:manage': true,
      'dashboard:revenue': true,
      'dashboard:profit': true,
      'customer:update': true,
      'debtor:update': true,
      'expense:create': true,
      'expense:read': true,
      'expense:update': true,
      'service:read': true,
      'service:create': true,
      'supplier:read': true,
      'report:read': true,
      'report:profit': true,
      'stock_take:create': true,
      'stock_take:read': true,
      'stock_take:update': true,
    };
  }

  return sellerDefaults;
}

// GET /api/shop-members  ->  members + their permissions (owner / user:manage only)
router.get('/', requireMemberManager, async (c) => {
  const shopId = c.get('activeShopId');
  try {
    const members = await db.read(
      `SELECT u.id, u.name, u.email, u.role as user_role, us.role, us.created_at as joined_at
       FROM user_shops us
       JOIN "user" u ON u.id = us.user_id
       WHERE us.shop_id = $1
       ORDER BY (us.role = 'owner') DESC, us.created_at ASC`,
      [shopId]
    );

    const perms = await db.read(
      `SELECT user_id, permission, granted FROM user_permissions WHERE shop_id = $1`,
      [shopId]
    );
    const permsByUser: Record<string, Record<string, boolean>> = {};
    for (const p of perms.rows) {
      permsByUser[p.user_id] ||= {};
      permsByUser[p.user_id][p.permission] = p.granted;
    }

    const data = members.rows.map((m: any) => {
      const stored = permsByUser[m.id] || {};
      const configured = Object.keys(stored).length > 0;
      return {
        ...m,
        // Un-customised members report their role defaults so the permission
        // checkboxes reflect what they can really do (saving then makes the
        // customisation explicit instead of silently revoking everything).
        permissions: configured ? stored : defaultPermissionsForRole(m.role),
        permissions_configured: configured,
      };
    });

    return c.json({ success: true, data });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/shop-members  ->  assign a member to the active shop (owner / user:manage only)
// body: { email, role?: 'seller'|'manager'|'store', permissions?: Record<string, boolean> }
router.post('/', requireMemberManager, async (c) => {
  const shopId = c.get('activeShopId');
  const ownerId = c.get('userId');

  try {
    const { email, role, permissions } = await c.req.json();
    if (!email) return c.json({ success: false, error: 'email is required' }, 400);
    const memberRole = ASSIGNABLE_ROLES.includes(role) ? role : 'seller';

    const userResult = await db.read(`SELECT id, name FROM "user" WHERE LOWER(email) = LOWER($1)`, [email]);
    if (userResult.rows.length === 0) {
      return c.json({ success: false, error: 'No user found with that email. Ask them to sign up first.' }, 404);
    }
    const targetUserId = userResult.rows[0].id;

    if (targetUserId === ownerId) {
      return c.json({ success: false, error: 'You already own this shop' }, 400);
    }

    // Plan/trial seller seat limit — only when this user isn't already a member
    // of the tenant (re-assigning an existing seller must never be blocked).
    const callerRole = c.get('userRole') as string;
    const tenantId = c.get('tenantId') as string;
    if (callerRole !== 'developer' && tenantId) {
      const memberCheck = await db.read(
        `SELECT 1 FROM user_shops us JOIN shops s ON s.id = us.shop_id
         WHERE us.user_id = $1 AND s.tenant_id = $2 AND us.role IN ('seller', 'manager', 'store')
         LIMIT 1`,
        [targetUserId, tenantId]
      );
      const tenantMemberCheck = await db.read(
        `SELECT 1 FROM "user" WHERE id = $1 AND tenant_id = $2::text AND role IN ('seller', 'manager', 'store') LIMIT 1`,
        [targetUserId, tenantId]
      );
      if (memberCheck.rows.length === 0 && tenantMemberCheck.rows.length === 0) {
        const gate = await checkSellerLimit(tenantId, 1);
        const limitError = limitErrorResponse(gate);
        if (limitError) return c.json(limitError, 403);
      }
    }

    await pool.query(
      `INSERT INTO user_shops (user_id, shop_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, shop_id) DO UPDATE SET role = $3`,
      [targetUserId, shopId, memberRole]
    );
    // Apply the new membership immediately (skip the 5-min auth cache).
    invalidateUserAuthCache(targetUserId);

    const defaultPerms = defaultPermissionsForRole(memberRole);
    const finalPerms = { ...defaultPerms, ...(permissions || {}) };

    for (const [permission, granted] of Object.entries(finalPerms)) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, shop_id, permission, granted, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, shop_id, permission)
         DO UPDATE SET granted = $4, granted_by = $5, granted_at = CURRENT_TIMESTAMP`,
        [targetUserId, shopId, permission, granted, ownerId]
      );
    }
    invalidateShopPermissions(targetUserId, shopId);
    await syncGlobalRoleIfSingleShop(targetUserId, memberRole);

    return c.json({ success: true, message: 'Member assigned to shop' }, 201);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// PUT /api/shop-members/:userId/permissions  ->  change one seller's limits (owner / user:manage only)
// body: { permissions: Record<string, boolean> }
router.put('/:userId/permissions', requireMemberManager, async (c) => {
  const shopId = c.get('activeShopId');
  const ownerId = c.get('userId');
  const targetUserId = c.req.param('userId');

  try {
    const { permissions } = await c.req.json();
    if (!permissions || typeof permissions !== 'object') {
      return c.json({ success: false, error: 'permissions object is required' }, 400);
    }

    for (const [permission, granted] of Object.entries(permissions)) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, shop_id, permission, granted, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, shop_id, permission)
         DO UPDATE SET granted = $4, granted_by = $5, granted_at = CURRENT_TIMESTAMP`,
        [targetUserId, shopId, permission, !!granted, ownerId]
      );
    }
    invalidateShopPermissions(targetUserId!, shopId);

    return c.json({ success: true, message: 'Permissions updated' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// PUT /api/shop-members/:userId/role  ->  change a member's role (owner / user:manage only)
router.put('/:userId/role', requireMemberManager, async (c) => {
  const shopId = c.get('activeShopId');
  const targetUserId = c.req.param('userId');

  try {
    const { role } = await c.req.json();
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return c.json({ success: false, error: 'Role must be seller, manager or store' }, 400);
    }

    const target = await db.read(`SELECT role FROM user_shops WHERE user_id = $1 AND shop_id = $2`, [targetUserId, shopId]);
    if (target.rows[0]?.role === 'owner') {
      return c.json({ success: false, error: 'Cannot change the shop owner role' }, 403);
    }

    await pool.query(`UPDATE user_shops SET role = $1 WHERE user_id = $2 AND shop_id = $3`, [role, targetUserId, shopId]);

    // Keep the member's account role in step when this is their only shop, so
    // their nav (Seller vs Store back-office) matches the role just set.
    await syncGlobalRoleIfSingleShop(targetUserId!, role);

    invalidateUserAuthCache(targetUserId!);
    return c.json({ success: true, message: 'Role updated' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// DELETE /api/shop-members/:userId  ->  revoke a seller's access to the active shop (owner / user:manage only)
router.delete('/:userId', requireMemberManager, async (c) => {
  const shopId = c.get('activeShopId');
  const targetUserId = c.req.param('userId');

  try {
    const target = await db.read(`SELECT role FROM user_shops WHERE user_id = $1 AND shop_id = $2`, [targetUserId, shopId]);
    if (target.rows[0]?.role === 'owner') {
      return c.json({ success: false, error: 'Cannot remove the shop owner' }, 403);
    }

    await pool.query(`DELETE FROM user_shops WHERE user_id = $1 AND shop_id = $2`, [targetUserId, shopId]);
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND shop_id = $2`, [targetUserId, shopId]);
    invalidateShopPermissions(targetUserId!, shopId);
    invalidateUserAuthCache(targetUserId!);

    return c.json({ success: true, message: 'Access removed' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;

