import { Hono } from 'hono';
import { db } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import { DEBUG_LOGS } from '../../config/index.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { logActivity } from '../../utils/activity-logger.js';
import { checkShopLimit, limitErrorResponse } from '../../services/plan-limits.service.js';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
  }
}>();

export interface ShopListOptions {
  userRole: string;
  userId: string;
  shopIds: string[];
  tenantId: string;
  requestedType?: string;
}

// Whether the shops.type column exists (cached per process). Older databases
// created by `db:migrate` alone may lack it — the runtime schema bootstrap adds
// it. Without the column every query that filters by type would fail with
// "column s.type does not exist", so listings fall back to no type filter.
let shopsHasTypeColumn: boolean | null = null;
async function detectShopsTypeColumn(): Promise<boolean> {
  if (shopsHasTypeColumn !== null) return shopsHasTypeColumn;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'shops' AND column_name = 'type' LIMIT 1`
    );
    shopsHasTypeColumn = r.rows.length > 0;
  } catch {
    shopsHasTypeColumn = true; // assume present; real errors surface normally
  }
  return shopsHasTypeColumn;
}

// Shared by GET /shops and GET /api/bootstrap so both always return the same
// rows, columns and ordering.
export async function listShopsForUser(opts: ShopListOptions): Promise<{ rows: any[] }> {
    const { userRole, userId, shopIds, tenantId, requestedType } = opts;
    
    // Stores (type='store') are the back-office/ghala and must not appear as
    // sellable shops. Normal callers get shops only; ?type=store fetches the
    // stores (used by the store module), ?type=all fetches both. Store staff
    // get their store by default.
    let typeClause = "type = 'shop'";
    if (requestedType === 'store') typeClause = "type = 'store'";
    else if (requestedType === 'all') typeClause = "(type = 'shop' OR type = 'store')";
    else if (userRole === 'store') typeClause = "type = 'store'";
    // Never filter on a column that does not exist.
    if (!(await detectShopsTypeColumn())) typeClause = 'TRUE';
    
    if (DEBUG_LOGS) console.log('[Shop GET] userRole:', userRole, 'shopIds:', shopIds, 'tenantId:', tenantId, 'type:', typeClause);
    
    let result;
    if (userRole === 'developer') {
      // Pre-aggregate the per-shop counters once (GROUP BY shop_id) and join,
      // instead of running ~9 correlated subqueries per shop row. With 100+
      // shops that was the 1s+ [SLOW] case. Same columns, same ordering.
      result = await db.read(`
        WITH sale_stats AS (
          SELECT sa.shop_id,
                 COUNT(*) AS sale_count,
                 COALESCE(SUM(sa.total_amount), 0) AS total_revenue,
                 MAX(sa.created_at) AS last_sale_at
          FROM sales sa
          GROUP BY sa.shop_id
        ),
        product_stats AS (
          SELECT p.shop_id,
                 COUNT(*) AS product_count,
                 MAX(p.created_at) AS last_product_at
          FROM products p
          GROUP BY p.shop_id
        ),
        activity_stats AS (
          SELECT al.shop_id::text AS shop_id,
                 MAX(al.created_at) AS last_activity_at
          FROM activity_logs al
          GROUP BY al.shop_id::text
        ),
        user_stats AS (
          SELECT us.shop_id,
                 COUNT(*) AS user_count
          FROM user_shops us
          GROUP BY us.shop_id
        )
        SELECT s.*,
          t.name as tenant_name, t.email as tenant_email, t.slug,
          COALESCE(ps.product_count, 0) as product_count,
          COALESCE(ss.sale_count, 0) as sale_count,
          COALESCE(ss.total_revenue, 0) as total_revenue,
          ss.last_sale_at,
          ps.last_product_at,
          acts.last_activity_at,
          COALESCE(us2.user_count, 0) as user_count
        FROM shops s
        LEFT JOIN tenants t ON t.id = s.tenant_id
        LEFT JOIN sale_stats ss ON ss.shop_id = s.id
        LEFT JOIN product_stats ps ON ps.shop_id = s.id
        LEFT JOIN activity_stats acts ON acts.shop_id = s.id::text
        LEFT JOIN user_stats us2 ON us2.shop_id = s.id
        WHERE ${typeClause.replace(/\btype\b/g, 's.type')}
        ORDER BY 
          (COALESCE(ss.sale_count, 0) > 0) DESC,
          (COALESCE(ps.product_count, 0) > 0) DESC,
          ss.last_sale_at DESC NULLS LAST,
          s.created_at DESC
      `);
    } else if (userRole === 'admin' || userRole === 'owner') {
      // Managers see the whole tenant (all their shops).
      if (shopIds && shopIds.length > 0) {
        // Use shopIds directly - these are already filtered by tenant in auth middleware.
        // LEFT JOIN user_shops so each shop carries the caller's role (Owner/Seller) —
        // admins/owners manage whole-tenant shops even without an explicit row, so
        // those default to 'owner'. The frontend shop switcher relies on my_role.
        // ids are compared as text so a legacy non-UUID value can never make the
        // whole endpoint fail with "invalid input syntax for type uuid".
        result = await db.read(
          `SELECT s.*, COALESCE(us.role, $3) as my_role
           FROM shops s
           LEFT JOIN user_shops us ON us.shop_id = s.id AND us.user_id = $2
           WHERE s.id::text = ANY($1::text[]) AND ${typeClause.replace(/\btype\b/g, 's.type')}
           ORDER BY (s.id::text = (SELECT shop_id FROM "user" WHERE id = $2)) DESC,
                    (COALESCE(us.role, $3) = 'owner') DESC,
                    s.created_at ASC`,
          [shopIds, userId, 'owner']
        );
      } else if (tenantId) {
        // Admin/owner with tenant sees only their tenant's shops - filter by tenantId
        try {
          result = await db.read(
            `SELECT * FROM shops WHERE tenant_id::text = $1 AND ${typeClause} AND (is_super_admin IS NOT TRUE OR is_super_admin = FALSE)
             ORDER BY (id::text = (SELECT shop_id FROM "user" WHERE id = $2)) DESC, created_at ASC`,
            [tenantId, userId]
          );
        } catch (e) {
          // Column doesn't exist, query without it
          result = await db.read(
            `SELECT * FROM shops WHERE tenant_id::text = $1 AND ${typeClause}
             ORDER BY (id::text = (SELECT shop_id FROM "user" WHERE id = $2)) DESC, created_at ASC`,
            [tenantId, userId]
          );
        }
      } else {
        // Admin/owner with no tenant - return all non-super-admin shops
        // This allows new admins to see existing shops they can join
        try {
          result = await db.read(
            `SELECT * FROM shops WHERE (is_super_admin IS NOT TRUE OR is_super_admin = FALSE) AND ${typeClause} ORDER BY created_at DESC`
          );
        } catch (e) {
          result = await db.read(
            `SELECT * FROM shops WHERE ${typeClause} ORDER BY created_at DESC`
          );
        }
      }
    } else {
      // Seller / team member: ONLY the shops an admin explicitly added them to.
      // user_shops is the single source of truth here — a seller must never see
      // the owner's other shops (or even know they exist).
      try {
        result = await db.read(
          `SELECT s.*, us.role as my_role
           FROM shops s
           JOIN user_shops us ON s.id = us.shop_id
           WHERE us.user_id = $1 AND ${typeClause.replace(/\btype\b/g, 's.type')} AND (s.is_super_admin IS NOT TRUE OR s.is_super_admin = FALSE)
           ORDER BY s.created_at ASC`,
          [userId]
        );
      } catch (e) {
        result = await db.read(
          `SELECT s.*, us.role as my_role
           FROM shops s
           JOIN user_shops us ON s.id = us.shop_id
           WHERE us.user_id = $1 AND ${typeClause.replace(/\btype\b/g, 's.type')}
           ORDER BY s.created_at ASC`,
          [userId]
        );
      }
    }
    
    if (DEBUG_LOGS) console.log('[Shop GET] Returning shops:', result.rows.length);
    
    return result;
}

router.get('/', authMiddleware, requirePermission('shop:read'), async (c) => {
  try {
    const result = await listShopsForUser({
      userRole: c.get('userRole'),
      userId: c.get('userId'),
      shopIds: (c.get('shopIds') as string[]) || [],
      tenantId: c.get('tenantId'),
      requestedType: c.req.query('type'),
    });
    return c.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Shop list error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/', authMiddleware, requirePermission('shop:create'), requireActiveSubscription, async (c) => {
  try {
    const body = await c.req.json();
    if (DEBUG_LOGS) console.log('Shop creation request body:', body);
    
    const { 
      name, 
      description, 
      address, 
      phone, 
      email,
      businessName,
      branchName,
      serialNumber,
      logo,
      invoiceFooter,
      tinNumber,
      vrnNumber
    } = body;
    
    const userId = c.get('userId');
    const tenantId = c.get('tenantId');
    
    if (DEBUG_LOGS) console.log('Creating shop:', { name, tenantId, userId });
    
    // Validation
    if (!name || name.trim() === '') {
      return c.json({ success: false, error: 'Shop name is required' }, 400);
    }
    
    if (!tenantId) {
      return c.json({ success: false, error: 'No tenant assigned to user. Please ensure you have a valid tenant.' }, 400);
    }

    // Plan/trial shop limit — blocks adding shops beyond the package allowance.
    const userRoleForLimit = c.get('userRole');
    if (userRoleForLimit !== 'developer') {
      const gate = await checkShopLimit(tenantId, 1);
      const limitError = limitErrorResponse(gate);
      if (limitError) return c.json(limitError, 403);
    }
    
    // Check if tenant exists
    const tenantCheck = await db.read('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (DEBUG_LOGS) console.log('Tenant check result:', tenantCheck.rows);
    
    if (tenantCheck.rows.length === 0) {
      if (DEBUG_LOGS) console.log('Tenant not found, creating default tenant:', tenantId);
      // Create a default tenant for this user
      const tenantName = name + ' Tenant';
      const tenantSlug = name.toLowerCase().replace(/\s+/g, '-') + '-tenant';
      const tenantEmail = email || 'admin@example.com';
      
      try {
        await pool.query(
          `INSERT INTO tenants (id, name, slug, email, is_active, plan_type, created_at, updated_at) 
           VALUES ($1, $2, $3, $4, true, 'basic', NOW(), NOW()) 
           ON CONFLICT (id) DO NOTHING`,
          [tenantId, tenantName, tenantSlug, tenantEmail]
        );
        if (DEBUG_LOGS) console.log('Created default tenant successfully');
      } catch (tenantErr: any) {
        console.error('Failed to create tenant:', tenantErr);
        return c.json({ success: false, error: 'Failed to create tenant: ' + tenantErr.message }, 400);
      }
    }
    
    const code = name.toLowerCase().replace(/\s+/g, '-').slice(0, 20);
    
    if (DEBUG_LOGS) console.log('Inserting shop with data:', { name, code, tenantId });
    
    const result = await pool.query(
      `INSERT INTO shops (name, code, description, address, phone, email, business_name, branch_name, serial_number, tenant_id, logo, invoice_footer, tin_number, vrn_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [name, code, description || null, address || null, phone || null, email || null, businessName || null, branchName || null, serialNumber || null, tenantId, logo || null, invoiceFooter || null, tinNumber || null, vrnNumber || null]
    );
    
    const shop = result.rows[0];
    if (DEBUG_LOGS) console.log('Shop created:', shop.id);
    
    await pool.query(
      'INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [userId, shop.id, 'owner']
    );
    
    // Update user role to admin since they're creating a shop
    await pool.query(
      `UPDATE "user" SET shop_id = $1, role = 'admin', updated_at = NOW() WHERE id = $2`,
      [shop.id, userId]
    );
    
    // Log shop creation
    const user = c.get('user') as any;
    await logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'shop_created',
      entityType: 'shop',
      entityId: shop.id,
      shopId: shop.id,
      details: { name, address, phone, email }
    });
    
    return c.json({ success: true, data: shop }, 201);
  } catch (error: any) {
    console.error('Shop creation error:', error);
    console.error('Error stack:', error.stack);
    return c.json({ success: false, error: error.message || 'Unknown error' }, 400);
  }
});

router.get('/:id', authMiddleware, requirePermission('shop:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const result = await db.read('SELECT * FROM shops WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Shop not found' }, 404);
    }
    
    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.put('/:id', authMiddleware, requirePermission('shop:update'), requireActiveSubscription, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { 
      name, 
      description, 
      address, 
      phone, 
      email, 
      is_active,
      businessName,
      branchName,
      serialNumber,
      logo,
      invoiceFooter,
      tinNumber,
      vrnNumber
    } = body;
    
    // Only update fields that are explicitly provided (preserve existing values)
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (address !== undefined) { updates.push(`address = $${idx++}`); values.push(address); }
    if (phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(phone); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); values.push(email); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); values.push(is_active); }
    if (businessName !== undefined) { updates.push(`business_name = $${idx++}`); values.push(businessName); }
    if (branchName !== undefined) { updates.push(`branch_name = $${idx++}`); values.push(branchName); }
    if (serialNumber !== undefined) { updates.push(`serial_number = $${idx++}`); values.push(serialNumber); }
    if (logo !== undefined) { updates.push(`logo = $${idx++}`); values.push(logo); }
    if (invoiceFooter !== undefined) { updates.push(`invoice_footer = $${idx++}`); values.push(invoiceFooter); }
    if (tinNumber !== undefined) { updates.push(`tin_number = $${idx++}`); values.push(tinNumber); }
    if (vrnNumber !== undefined) { updates.push(`vrn_number = $${idx++}`); values.push(vrnNumber); }

    if (updates.length === 0) {
      return c.json({ success: false, error: 'No fields to update' }, 400);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE shops SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Shop not found' }, 404);
    }
    
    // Log shop update
    const user = c.get('user') as any;
    const updatedFields = Object.keys(body).filter(k => body[k] !== undefined);
    await logActivity({
      userId: c.get('userId'),
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'shop_updated',
      entityType: 'shop',
      entityId: id,
      shopId: id,
      details: { updatedFields }
    });
    
    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Delete shop - only if not user's primary shop
router.delete('/:id', authMiddleware, requirePermission('shop:delete'), requireActiveSubscription, async (c) => {
  try {
    const id = c.req.param('id');
    const userRole = c.get('userRole');
    const userId = c.get('userId');
    
    // Check if shop exists
    const shopResult = await db.read('SELECT id, is_super_admin, tenant_id FROM shops WHERE id = $1', [id]);
    if (shopResult.rows.length === 0) {
      return c.json({ success: false, error: 'Shop not found' }, 404);
    }
    
    const shop = shopResult.rows[0];
    
    // Prevent deleting super admin shop
    if (shop.is_super_admin === true) {
      return c.json({ success: false, error: 'Cannot delete system shop' }, 403);
    }
    
    // Check if this shop is the user's primary shop (the main shop they own)
    const primaryShopResult = await db.read(
      'SELECT shop_id FROM "user" WHERE id = $1 AND shop_id = $2',
      [userId, id]
    );
    
    if (primaryShopResult.rows.length > 0) {
      return c.json({ success: false, error: 'Cannot delete your primary shop. Only edit is allowed.' }, 403);
    }
    
    // Prevent deleting the last shop in a tenant (user would lose all shops)
    const tenantShopCount = await db.read(
      'SELECT COUNT(*) as count FROM shops WHERE tenant_id = $1',
      [shop.tenant_id]
    );
    if (parseInt(tenantShopCount.rows[0].count) <= 1) {
      return c.json({ success: false, error: 'Cannot delete the only shop in your tenant.' }, 403);
    }
    
    // Remove user_shops associations first
    await pool.query('DELETE FROM user_shops WHERE shop_id = $1', [id]);
    
    // `user.shop_id` never had a FK to shops — clear it for every user still
    // pointing at this shop. Otherwise their account stays stuck on a deleted
    // shop and shop-scoped INSERTs fail with FK errors (e.g. applying for a
    // sender ID in the SMS Center) until the auth middleware repairs them.
    await pool.query('UPDATE "user" SET shop_id = NULL, updated_at = NOW() WHERE shop_id = $1', [id]);
    
    // Delete the shop (cascade will handle related records)
    await pool.query('DELETE FROM shops WHERE id = $1', [id]);
    
    return c.json({ success: true, message: 'Shop deleted successfully' });
  } catch (error: any) {
    console.error('Delete shop error:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Update tenant name (admin/owner only for their own tenant)
router.put('/tenant/name', authMiddleware, requirePermission('settings:update'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { name } = await c.req.json();

    if (!name || name.trim() === '') {
      return c.json({ success: false, error: 'Tenant name is required' }, 400);
    }

    const result = await pool.query(
      `UPDATE tenants SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [name.trim(), tenantId]
    );

    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }

    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get current tenant info
router.get('/tenant/me', authMiddleware, async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const result = await db.read(
      `SELECT id, name, email, is_active, created_at FROM tenants WHERE id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }

    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;

