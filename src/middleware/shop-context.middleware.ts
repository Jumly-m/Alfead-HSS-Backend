import { Context, Next } from 'hono';
import { pool } from '../config/drizzle.js';

/**
 * Runs AFTER authMiddleware (which already sets userId, userRole, shopIds).
 * Resolves which shop THIS request is acting on, and validates the logged-in
 * user actually belongs to it. This is the single choke point that makes the
 * admin's shop-switcher work on the backend — every scoped route reads
 * c.get('activeShopId') instead of trusting whatever the client sends.
 *
 * Reads the target shop from (in priority order):
 *   1. ?shopId=       query param   (GET / DELETE requests)
 *   2. body.shopId    JSON body     (POST / PUT / PATCH requests)
 *   3. falls back to the user's first accessible shop (their default)
 *
 * On success sets:
 *   c.set('activeShopId', shopId)
 *   c.set('activeShopRole', 'owner' | 'manager' | 'seller')
 *
 * SECURITY NOTE: if the client explicitly asks for a shopId they don't
 * belong to, this REJECTS the request rather than silently falling back
 * to their default shop. That's what stops a tampered shopId in a request
 * body from ever leaking another shop's data.
 */
export async function shopContext(c: Context, next: Next) {
  const userId = c.get('userId') as string;
  const userRole = c.get('userRole') as string; // global role: 'developer' | 'admin' | 'seller'
  const shopIds = (c.get('shopIds') as string[]) || [];

  // Super admin (developer) is not scoped to a single shop by default.
  // Shop-specific admin endpoints should still pass an explicit shopId
  // through the query string, which this middleware will still honor below.
  if (userRole === 'developer' && !c.req.query('shopId')) {
    c.set('activeShopRole', 'owner');
    await next();
    return;
  }

  let requestedShopId = c.req.query('shopId');

  if (!requestedShopId && ['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
    try {
      // Clone the request so downstream handlers can still read the body.
      const cloned = c.req.raw.clone();
      const body: any = await cloned.json().catch(() => ({}));
      requestedShopId = body?.shopId;
    } catch {
      // no JSON body — ignore, fall through to default shop
    }
  }

  if (requestedShopId && userRole !== 'developer' && !shopIds.includes(requestedShopId)) {
    return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
  }

  const shopId = requestedShopId || shopIds[0];

  if (!shopId) {
    return c.json({ success: false, error: 'No shop access' }, 403);
  }

  try {
    const roleResult = await pool.query(
      `SELECT role FROM user_shops WHERE user_id = $1 AND shop_id::text = $2 LIMIT 1`,
      [userId, shopId]
    );
    // Admins/owners manage the whole tenant — treat them as owner everywhere.
    const role = userRole === 'developer' || userRole === 'admin' || userRole === 'owner'
      ? 'owner'
      : (roleResult.rows[0]?.role || 'seller');
    c.set('activeShopId', shopId);
    c.set('activeShopRole', role);
  } catch (e: any) {
    console.error('[shopContext] role lookup failed:', e.message);
    c.set('activeShopId', shopId);
    c.set('activeShopRole', 'seller');
  }

  await next();
}

/**
 * Guard for owner-only actions within the active shop — managing sellers,
 * editing shop settings, deleting the shop, changing permissions.
 * Use AFTER shopContext in the route chain.
 */
export function requireShopOwner(c: Context, next: Next) {
  const role = c.get('activeShopRole');
  const userRole = c.get('userRole');
  if (userRole === 'developer' || role === 'owner') {
    return next();
  }
  return c.json({ success: false, error: 'Only the shop owner can do this' }, 403);
}
