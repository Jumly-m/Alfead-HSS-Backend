import type { Context } from "hono";
import { unitService } from "./unit.service.js";
import { logActivity } from "../../utils/activity-logger.js";

/**
 * Resolves which shop the request targets, always validated against the
 * caller's memberships. Prefers an explicit shopId (query/body), else the
 * user's first shop. Returns null when none can be resolved and 'forbidden'
 * when the caller asks for a shop they don't belong to.
 *
 * Module-level on purpose — NOT a class method: Hono registers controller
 * methods unbound, so a `this.`-based helper makes every units request die
 * with "Cannot read properties of undefined (reading 'resolveShopId')".
 *
 * This is what makes update/delete work for multi-shop owners: the client
 * sends the ACTIVE shop, so a unit in shop B is edited/deleted in shop B —
 * not in whichever shop happens to be first.
 */
function resolveShopId(c: Context, requested?: string | null): string | null | 'forbidden' {
  const userRole = c.get('userRole');
  const userShopIds = (c.get('shopIds') as string[]) || [];
  if (userRole === 'developer') return requested || userShopIds[0] || null;
  if (requested) return userShopIds.includes(requested) ? requested : 'forbidden';
  return userShopIds[0] || null;
}

export class UnitController {
  async getAll(c: Context) {
    try {
      const requested = c.req.query("shopId");
      const resolved = resolveShopId(c, requested);
      if (resolved === 'forbidden') {
        return c.json({ success: false, error: "You do not have access to this shop" }, 403);
      }
      if (!resolved) {
        return c.json({ success: true, data: [] });
      }

      const units = await unitService.findAll(resolved);
      return c.json({ success: true, data: units });
    } catch (error: any) {
      console.error('[Units] list failed:', error.message);
      return c.json({ success: false, error: error.message }, 500);
    }
  }

  async create(c: Context) {
    try {
      const body = await c.req.json();
      const resolved = resolveShopId(c, body.shopId || null);
      if (resolved === 'forbidden') {
        return c.json({ success: false, error: "You do not have access to this shop" }, 403);
      }
      const shopId = resolved;
      if (!shopId) {
        return c.json({ success: false, error: "Shop ID required" }, 400);
      }

      const existing = await unitService.findByCode(body.code, shopId);
      if (existing) {
        return c.json({ success: false, error: `Unit code "${body.code}" already exists for this shop` }, 409);
      }

      const unit = await unitService.create({ ...body, shopId });
      
      const user = c.get('user') as any;
      const userId = c.get('userId');
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'unit_created',
        entityType: 'unit',
        entityId: unit?.id,
        shopId,
        details: { code: body.code, name: body.name }
      });
      
      return c.json({ success: true, data: unit }, 201);
    } catch (error: any) {
      console.error('[Units] create failed:', error.message);
      return c.json({ success: false, error: error.message }, 500);
    }
  }

  async update(c: Context) {
    try {
      const id = c.req.param("id") as string;
      const body = await c.req.json().catch(() => ({}));
      const requested = c.req.query("shopId") || body?.shopId || null;
      const resolved = resolveShopId(c, requested);
      if (resolved === 'forbidden') {
        return c.json({ success: false, error: "You do not have access to this shop" }, 403);
      }
      const shopId = resolved;

      if (!shopId) {
        return c.json({ success: false, error: "Shop ID required" }, 400);
      }

      const unit = await unitService.update(id, shopId, body);
      if (!unit) {
        return c.json({ success: false, error: "Unit not found" }, 404);
      }
      
      const user = c.get('user') as any;
      const userId = c.get('userId');
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'unit_updated',
        entityType: 'unit',
        entityId: id,
        shopId,
        details: { changes: Object.keys(body) }
      });
      
      return c.json({ success: true, data: unit });
    } catch (error: any) {
      console.error('[Units] update failed:', error.message);
      return c.json({ success: false, error: error.message }, 500);
    }
  }

  async delete(c: Context) {
    try {
      const id = c.req.param("id") as string;
      const body = await c.req.json().catch(() => ({}));
      const requested = c.req.query("shopId") || body?.shopId || null;
      const resolved = resolveShopId(c, requested);
      if (resolved === 'forbidden') {
        return c.json({ success: false, error: "You do not have access to this shop" }, 403);
      }
      const shopId = resolved;

      if (!shopId) {
        return c.json({ success: false, error: "Shop ID required" }, 400);
      }

      const unit = await unitService.delete(id, shopId);
      if (!unit) {
        return c.json({ success: false, error: "Unit not found" }, 404);
      }
      
      const user = c.get('user') as any;
      const userId = c.get('userId');
      await logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'unit_deleted',
        entityType: 'unit',
        entityId: id,
        shopId,
        details: { deletedUnitId: id }
      });
      
      return c.json({ success: true, message: "Unit deleted" });
    } catch (error: any) {
      console.error('[Units] delete failed:', error.message);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
}

export const unitController = new UnitController();
