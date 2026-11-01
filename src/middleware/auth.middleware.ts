/**
 * =====================================================
 * AUTHENTICATION MIDDLEWARE
 * =====================================================
 * 
 * This middleware runs on every protected API request.
 * It verifies the user's session and extracts their
 * role, shop assignments, and permissions.
 * 
 * WHAT IT DOES:
 * 1. Checks if user has valid session (logged in)
 * 2. Fetches user's role and shop assignments from database
 * 3. Handles special super admin logic
 * 4. Auto-creates shop for new users without one
 * 5. Sets context variables for downstream handlers
 * 
 * CONTEXT VARIABLES SET:
 * - userId: The user's unique ID
 * - userRole: 'developer', 'admin', 'owner', or 'seller'
 * - shopIds: Array of shop IDs the user has access to
 * - tenantId: The tenant/organization ID
 * - isSuperAdmin: Boolean flag for super admin
 * 
 * FOR DEVELOPERS:
 * - Add new roles in the role check logic
 * - Modify shop assignment logic for custom workflows
 * - Add permission checks here for authorization
 */

import { createMiddleware } from "hono/factory";
import { auth, createShopForUser } from "../auth.js";
import { db } from "../config/database.js";
import { pool } from "../config/drizzle.js";

// In-memory cache for auth data (5 min TTL)
const authCache = new Map<string, { data: any; expires: number }>();
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// `user.shop_id` / `user.tenant_id` are VARCHAR columns, so a legacy row can
// hold a non-UUID value (e.g. 'system'). Feeding that into a uuid-typed query
// (shops.id = $1, shops.tenant_id = $1) throws "invalid input syntax for type
// uuid" and used to break /api/shops and /api/bootstrap with a 400. Every id
// is validated before it reaches those queries.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function getAuthCache(key: string): any | null {
  const entry = authCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    authCache.delete(key);
    return null;
  }
  return entry.data;
}

function setAuthCache(key: string, data: any): void {
  authCache.set(key, { data, expires: Date.now() + AUTH_CACHE_TTL });
}

function invalidateAuthCache(userId: string): void {
  for (const key of authCache.keys()) {
    if (key.startsWith(`auth:${userId}:`)) {
      authCache.delete(key);
    }
  }
}

/**
 * Clear the cached role/shop resolution for a user. Call this whenever an
 * admin changes a user's role or shop memberships so the change takes effect
 * on the next request instead of after the 5-minute cache TTL.
 */
export function invalidateUserAuthCache(userId: string): void {
  invalidateAuthCache(userId);
}


// Super admin email from environment variables
// This user has system-wide access (for development/maintenance)
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();

/**
 * Type definitions for context variables
 * These are available in all protected routes after this middleware runs
 */
type Variables = {
  user: typeof auth.$Infer.Session.user | null;    // Better Auth user object
  session: typeof auth.$Infer.Session.session | null; // Better Auth session object
  shopIds: string[];        // Array of shop IDs user can access
  userRole: string;         // User's role: super_admin, admin, owner, seller
  userId: string;           // User's unique ID
  tenantId: string;        // Tenant/organization ID
  isSuperAdmin?: boolean;  // Flag for super admin check
  authError?: boolean;     // Session lookup failed due to a transient backend error
};

/**
 * Main authentication middleware function
 * Runs before protected route handlers
 * 
 * @param c - Hono context (request/response)
 * @param next - Function to call next middleware/route
 */
export const authMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  // Get session info set by Better Auth in index.ts
  let user = c.get('user') as any;
  let session = c.get('session');
  
  // Step 0: If no Better Auth session, try JWT Bearer token
  if (!user || !session) {
    const authHeader = c.req.header('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const { verifyToken } = await import('../utils/auth.js');
        const token = authHeader.substring(7);
        const payload = verifyToken(token);
        
       // Create synthetic user object from JWT payload
       user = {
         id: payload.userId,
         email: '', // Will be fetched from DB
         name: '',
         role: payload.role,
         tenantId: payload.tenantId,
       };
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now
        session = { 
          id: 'jwt-session', 
          userId: payload.userId, 
          createdAt: new Date(), 
          updatedAt: new Date(),
          expiresAt,
          token: 'jwt-token',
          ipAddress: null,
          userAgent: null,
        };
        
        // Set context for downstream handlers
        c.set('user', user);
        c.set('session', session);
      } catch (e: any) {
        return c.json({ success: false, error: 'Unauthorized - Invalid token' }, 401);
      }
    }
  }
  
  // Step 1: Reject requests without valid session (not logged in)
  if (!user || !session) {
    if (c.get('authError')) {
      return c.json({ success: false, error: 'Authentication service temporarily unavailable' }, 503);
    }
    return c.json({ success: false, error: 'Unauthorized - No valid session' }, 401);
  }

  // Step 2: Check if this is the configured super admin (cached check)
  const isSuperAdminEmail = user.email?.toLowerCase() === SUPER_ADMIN_EMAIL;
  
  if (isSuperAdminEmail) {
    const saCacheKey = `auth:superadmin:${user.id}`;
    let saCached = getAuthCache(saCacheKey);
    if (!saCached) {
      try {
        await pool.query(
          `UPDATE "user" SET role = 'developer', updated_at = NOW() 
           WHERE LOWER(email) = $1 AND role != 'developer'`,
          [SUPER_ADMIN_EMAIL]
        );
        const superAdminShop = await db.read(
          `SELECT id FROM shops WHERE is_super_admin = true LIMIT 1`
        );
        if (superAdminShop.rows.length > 0) {
          await pool.query(
            `INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
            [user.id, superAdminShop.rows[0].id]
          );
        }
        setAuthCache(saCacheKey, true);
      } catch (e) {
        console.error('Error ensuring super admin:', e);
      }
    }
  }

  // Step 3: Fetch user's role and shop from database (cached for 5 min)
  const cacheKey = `auth:${user.id}:profile`;
  let cached = getAuthCache(cacheKey);
  let shopId = null;
  let tenantId = null;
  let dbRole = 'admin';
  let dbUser: any = null;

  if (cached) {
    shopId = cached.shopId;
    tenantId = cached.tenantId;
    dbRole = cached.dbRole;
    dbUser = cached.dbUser;
  } else {
    try {
      const userResult = await db.read(
        'SELECT shop_id, role, tenant_id FROM "user" WHERE id = $1',
        [user.id]
      );
      shopId = userResult.rows[0]?.shop_id || null;
      tenantId = userResult.rows[0]?.tenant_id || (user as any).tenantId || null;
      dbRole = userResult.rows[0]?.role || 'admin';
      if (dbRole === 'user') {
        dbRole = 'admin';
        await pool.query(
          `UPDATE "user" SET role = 'admin', updated_at = NOW() WHERE id = $1 AND role = 'user'`,
          [user.id]
        );
      }
      dbUser = userResult.rows[0];
    } catch (e: any) {
      console.error('Error fetching user:', e.message);
      try {
        const userResult = await db.read(
          'SELECT shop_id, role FROM "user" WHERE id = $1', [user.id]
        );
        shopId = userResult.rows[0]?.shop_id || null;
        tenantId = tenantId || (user as any).tenantId || null;
        dbRole = userResult.rows[0]?.role || 'admin';
        if (dbRole === 'user') dbRole = 'admin';
        dbUser = userResult.rows[0];
      } catch (e2) {
        dbRole = 'admin';
        tenantId = tenantId || (user as any).tenantId || null;
      }
    }

   // Cache the user profile data
   setAuthCache(cacheKey, { shopId, tenantId, dbRole, dbUser });
   }

  // Step 4: Override role if this is the super admin email
  if (isSuperAdminEmail) {
    dbRole = 'developer';
    
    // Super admin should NOT have a specific shop assigned
    // They have system-wide access
    try {
      await pool.query(
        `UPDATE "user" SET shop_id = NULL, updated_at = NOW() 
         WHERE LOWER(email) = $1 AND shop_id IS NOT NULL`,
        [SUPER_ADMIN_EMAIL]
      );
    } catch (e) {
      console.error('Error clearing super admin shop_id:', e);
    }
    
    // Get tenant from super admin shop for system access
    try {
      const superAdminShop = await db.read(
        `SELECT tenant_id FROM shops WHERE is_super_admin = true LIMIT 1`
      );
      if (superAdminShop.rows.length > 0) {
        tenantId = superAdminShop.rows[0].tenant_id;
        
      }
    } catch (e: any) {
      console.error('Error getting super admin tenant:', e.message);
    }
  }

  // Step 5: Get shop IDs from user_shops table (cached for 5 min)
  const shopsCacheKey = `auth:${user.id}:shops`;
  let shopsCached = getAuthCache(shopsCacheKey);
  
  let shopIds: string[] = [];
  
  if (shopsCached) {
    shopIds = shopsCached;
  } else {
  try {
    // Get shops from user_shops (explicit assignments)
    const userShopsResult = await db.read(
      'SELECT shop_id FROM user_shops WHERE user_id = $1',
      [user.id]
    );
    shopIds = userShopsResult.rows.map((row: any) => row.shop_id);
    
    // Fallback: use user's default shop_id if no explicit assignments
    if (shopIds.length === 0 && shopId) {
      shopIds = [shopId];
    }
    
    // Super admin has no assigned shops (they access all through admin APIs)
    if (dbRole === 'developer') {
      shopIds = [];
    }
    } catch (e: any) {
      console.error('Error getting user shops:', e.message);
      if (shopId) {
        shopIds = [shopId];
      }
    }
    
    // Cache the shop IDs
    setAuthCache(shopsCacheKey, shopIds);
  }
  
  // Step 5.5: Repair stale shop references. `user_shops.shop_id` and
  // `user.shop_id` had no foreign key to shops on older databases, so deleting
  // a shop could leave an orphan id behind. An orphan passes straight through
  // to shop-scoped inserts and blows up as a raw FK error, e.g.
  //   insert or update on table "sms_sender_ids" violates foreign key
  //   constraint "sms_sender_ids_shop_id_fkey"
  // Keep only shops that still exist and clean the stale rows so the account
  // heals itself on this request (Step 7/8 below then re-assign or re-create).
  if (dbRole !== 'developer') {
    const candidates = [...new Set(([...shopIds, shopId].filter(Boolean) as string[]))];
    if (candidates.length > 0) {
      try {
        const existing = await db.read(
          `SELECT id::text AS id FROM shops WHERE id::text = ANY($1::text[])`,
          [candidates]
        );
        const valid = new Set(existing.rows.map((row: any) => row.id));
        const stale = candidates.filter((id) => !valid.has(id));
        if (stale.length > 0) {
          console.warn('[Auth] Stale shop reference(s) for user', user.id, '->', stale.join(', '), '- repairing');
          if (shopId && !valid.has(shopId)) shopId = null;
          shopIds = shopIds.filter((id) => valid.has(id));
          await pool.query(
            `UPDATE "user" SET shop_id = NULL, updated_at = NOW() WHERE id = $1 AND shop_id = ANY($2::text[])`,
            [user.id, stale]
          );
          await pool.query(
            `DELETE FROM user_shops WHERE user_id = $1 AND shop_id::text = ANY($2::text[])`,
            [user.id, stale]
          );
          // Drop the cached profile too — it still carries the orphan id.
          invalidateAuthCache(user.id);
        }
      } catch (e: any) {
        console.error('[Auth] Stale shop reference check failed:', e.message);
      }
    }
  }

  // Step 5.75: Never let a legacy non-UUID id reach a uuid-typed query.
  // Step 5.5 already repairs most of these against the database; this is the
  // safety net for the case where that repair query itself failed. The user
  // still gets a working session (tenant/shop resolved from their real rows),
  // instead of a 400 on every /shops and /bootstrap call.
  if (dbRole !== 'developer') {
    if (shopId && !isUuid(shopId)) shopId = null;
    if (tenantId && !isUuid(tenantId)) tenantId = null;
    shopIds = shopIds.filter((id) => isUuid(id));
  }

  // Step 6: If user has shop_id but not in shopIds, verify and add it
  if (dbRole !== 'developer' && shopIds.length === 0 && shopId && tenantId) {
    const shopCheck = await db.read(
      'SELECT id FROM shops WHERE id::text = $1 AND tenant_id::text = $2',
      [shopId, tenantId]
    );
    if (shopCheck.rows.length > 0) {
      shopIds = [shopId];
      
    }
  }
  
  // Step 6.5: If user has a shop but no tenant_id, look up tenant from shop
  if (dbRole !== 'developer' && !tenantId && shopId) {
    try {
      const shopTenantResult = await db.read(
        'SELECT tenant_id FROM shops WHERE id::text = $1',
        [shopId]
      );
      if (shopTenantResult.rows.length > 0) {
        tenantId = shopTenantResult.rows[0].tenant_id;
        // Update user record with the correct tenant_id
        await pool.query(
          `UPDATE "user" SET tenant_id = $1 WHERE id = $2 AND tenant_id IS NULL`,
          [tenantId, user.id]
        );
      }
    } catch (e: any) {
      console.error('[Auth] Error looking up tenant from shop:', e.message);
    }
  }
  
  // Step 7: Admin/owner with a tenant but no shop gets the tenant's first
  // shop. Sellers NEVER get an implicit shop — they only ever see the exact
  // shops an admin explicitly assigned to them (user_shops).
  if ((dbRole === 'admin' || dbRole === 'owner') && shopIds.length === 0 && tenantId) {
    try {
      const firstShop = await db.read(
        'SELECT id FROM shops WHERE tenant_id::text = $1 LIMIT 1',
        [tenantId]
      );
      if (firstShop.rows.length > 0) {
        const newShopId = firstShop.rows[0].id;
        shopId = newShopId;
        shopIds = [newShopId];
        
      }
    } catch (e: any) {
      console.error('Error assigning first shop:', e.message);
    }
  }

  // Step 7.5: For admin users, include ALL shops from their tenant (shop owners see all shops)
  if (dbRole === 'admin' && tenantId) {
    try {
      const allTenantShops = await db.read(
        'SELECT id FROM shops WHERE tenant_id::text = $1',
        [tenantId]
      );
      if (allTenantShops.rows.length > 0) {
        const allShopIds = allTenantShops.rows.map((row: any) => row.id);
        // Merge with existing shopIds, avoiding duplicates
        shopIds = [...new Set([...shopIds, ...allShopIds])];
      }
    } catch (e: any) {
      console.error('[Auth] Error fetching tenant shops for admin:', e.message);
    }
  }
  
  // Step 8: Admin/owner with NO shop at all — recover the explicit shop_id or
  // re-create a shop (registration fallback). Sellers are excluded: if an admin
  // hasn't assigned them a shop, they must see nothing and ask the owner.
  if ((dbRole === 'admin' || dbRole === 'owner') && shopIds.length === 0) {
    try {
      const doubleCheck = await db.read(
        'SELECT shop_id FROM user_shops WHERE user_id = $1 LIMIT 1',
        [user.id]
      );
      if (doubleCheck.rows.length > 0) {
        const existingShopId = doubleCheck.rows[0].shop_id;
        shopIds = [existingShopId];
        shopId = existingShopId;
        setAuthCache(shopsCacheKey, shopIds);
      } else {
        const userShopCheck = await db.read(
          'SELECT shop_id FROM "user" WHERE id = $1 AND shop_id IS NOT NULL LIMIT 1',
          [user.id]
        );
        if (userShopCheck.rows.length > 0) {
          const existingShopId = userShopCheck.rows[0].shop_id;
          shopIds = [existingShopId];
          shopId = existingShopId;
          setAuthCache(shopsCacheKey, shopIds);
          await pool.query(
            'INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, \'owner\') ON CONFLICT DO NOTHING',
            [user.id, existingShopId]
          );
        } else {
          console.warn('[Auth] User has no shop - attempting fallback creation for:', user.id);
          try {
            const userRecord = await db.read(
              'SELECT email, name FROM "user" WHERE id = $1',
              [user.id]
            );
            if (userRecord.rows.length > 0) {
              const userEmail = userRecord.rows[0].email;
              const userName = userRecord.rows[0].name || userEmail?.split('@')[0] || 'Shop';
              const fallback = await createShopForUser(user.id, userEmail, userName);
              shopIds = [fallback.shopId];
              shopId = fallback.shopId;
              tenantId = fallback.tenantId;
              setAuthCache(shopsCacheKey, shopIds);
              console.log('[Auth] Fallback shop created for user:', user.id, fallback.shopId);
            }
          } catch (fallbackErr: any) {
            console.error('[Auth] Fallback shop creation failed for user:', user.id, fallbackErr.message);
          }
        }
      }
    } catch (e: any) {
      console.error('[Auth] Error resolving user shops:', e.message);
    }
  }

  

  // Final safety net: the recovery branches above read VARCHAR columns too, so
  // re-validate before the ids are exposed to route handlers (and their
  // uuid-typed queries).
  if (dbRole !== 'developer') {
    if (shopId && !isUuid(shopId)) shopId = null;
    if (tenantId && !isUuid(tenantId)) tenantId = null;
    shopIds = shopIds.filter((id) => isUuid(id));
  }

  // Step 9: Set context variables for downstream handlers
  // These are available in route handlers via c.get('variableName')
  c.set('userId', user.id);
  
  // CRITICAL: tenantId must ALWAYS be a valid tenant UUID, never a shop ID
  // shopId is a shop UUID which is different from tenant UUID
  const validTenantId = dbRole === 'developer' ? tenantId : tenantId;
  c.set('tenantId', validTenantId || null);
  
  c.set('userRole', dbRole);
  c.set('isSuperAdmin', isSuperAdminEmail);
  
  // Super admin gets empty shopIds (they access all through admin APIs)
  // Regular users get their assigned shops
  c.set('shopIds', dbRole === 'developer' ? [] : shopIds);
  
  // Continue to the next middleware/route handler
  await next();
});

