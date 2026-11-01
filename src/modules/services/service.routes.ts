import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { db as readDb } from '../../config/database.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { logActivity } from '../../utils/activity-logger.js';
import { cache } from '../../utils/cache.js';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    shopIds: string[];
    tenantId: string;
    user: any;
  }
}>();

router.use('*', authMiddleware);

const DEFAULT_SERVICES_SETTINGS = { add_to_sales: false };

export async function getServicesSettings(shopId: string) {
  const r = await pool.query(
    `SELECT value FROM settings WHERE key = 'services' AND shop_id = $1 LIMIT 1`,
    [shopId]
  );
  if (r.rows.length === 0) return { ...DEFAULT_SERVICES_SETTINGS };
  const value = typeof r.rows[0].value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0].value;
  return { ...DEFAULT_SERVICES_SETTINGS, ...value };
}

export async function saveServicesSettings(shopId: string, settings: any) {
  const current = await getServicesSettings(shopId);
  const merged = { ...current, ...settings };
  await pool.query(`DELETE FROM settings WHERE key = 'services' AND shop_id = $1`, [shopId]);
  await pool.query(
    `INSERT INTO settings (key, value, shop_id) VALUES ('services', $1, $2)`,
    [JSON.stringify(merged), shopId]
  );
  return merged;
}

// Resolve the shop we operate on: explicit shopId or the user's first shop.
function resolveShopId(c: any): { shopId: string; shopIds: string[]; userRole: string } {
  const shopIds = (c.get('shopIds') as string[]) || [];
  const userRole = c.get('userRole');
  const userEmail = (c.get('user') as any)?.email?.toLowerCase();

  let shopId = c.req.query('shopId');
  if (!shopId && shopIds.length === 1) shopId = shopIds[0];

  // Developers pass an explicit shopId; everyone else is validated below.
  if (shopId && userRole !== 'developer' && !shopIds.includes(shopId)) {
    return { shopId: null as any, shopIds, userRole };
  }
  return { shopId, shopIds, userRole };
}

function guardShop(c: any, shopId: string | null | undefined): string | null {
  const { shopIds, userRole } = resolveShopId(c);
  if (!shopId) return null;
  if (userRole !== 'developer' && !shopIds.includes(shopId)) return null;
  return shopId;
}

// ─── Service Categories ─────────────────────────────────────────────────────
router.get('/categories', requirePermission('service:read'), async (c) => {
  try {
    const shopId = guardShop(c, c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const result = await pool.query(
      `SELECT sc.*, (SELECT COUNT(*) FROM services s WHERE s.category_id = sc.id AND s.is_active = true) as service_count
       FROM service_categories sc
       WHERE sc.shop_id = $1
       ORDER BY sc.name ASC`,
      [shopId]
    );

    return c.json({
      success: true,
      data: result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        serviceCount: parseInt(r.service_count) || 0,
        createdAt: r.created_at
      }))
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

router.post('/categories', requirePermission('service:update'), async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId') as string;
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const name = (body.name || '').trim();
    if (!name) return c.json({ success: false, error: 'Category name is required' }, 400);

    const existing = await pool.query(
      `SELECT id FROM service_categories WHERE shop_id = $1 AND LOWER(name) = LOWER($2)`,
      [shopId, name]
    );
    if (existing.rows.length > 0) {
      return c.json({ success: false, error: 'Category with this name already exists' }, 400);
    }

    const result = await pool.query(
      `INSERT INTO service_categories (shop_id, name, description, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [shopId, name, body.description || null, userId]
    );

    cache.invalidateByPrefix('services:');

    const user = (c.get('user') as any) || {};
    logActivity({
      userId,
      userName: user.name || user.email || 'Unknown',
      userEmail: user.email || '',
      action: 'service_category_created',
      entityType: 'service_category',
      entityId: result.rows[0].id,
      shopId,
      details: { name }
    }).catch(() => {});

    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

router.put('/categories/:id', requirePermission('service:update'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const result = await pool.query(
      `UPDATE service_categories SET name = $1, description = $2, updated_at = NOW()
       WHERE id = $3 AND shop_id = $4 RETURNING *`,
      [body.name, body.description || null, id, shopId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Category not found' }, 404);

    cache.invalidateByPrefix('services:');
    return c.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

router.delete('/categories/:id', requirePermission('service:update'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const result = await pool.query(
      `DELETE FROM service_categories WHERE id = $1 AND shop_id = $2 RETURNING id`,
      [id, shopId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Category not found' }, 404);

    cache.invalidateByPrefix('services:');
    return c.json({ success: true, message: 'Category deleted' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── Services ────────────────────────────────────────────────────────────────
router.get('/', requirePermission('service:read'), async (c) => {
  try {
    const shopId = guardShop(c, c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const result = await pool.query(
      `SELECT s.*, sc.name as category_name
       FROM services s
       LEFT JOIN service_categories sc ON sc.id = s.category_id
       WHERE s.shop_id = $1
       ORDER BY s.name ASC`,
      [shopId]
    );

    return c.json({
      success: true,
      data: result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        price: parseFloat(r.price),
        description: r.description,
        categoryId: r.category_id,
        categoryName: r.category_name,
        isActive: r.is_active,
        createdAt: r.created_at
      }))
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

router.post('/', requirePermission('service:update'), async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId') as string;
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const name = (body.name || '').trim();
    const price = parseFloat(body.price) || 0;
    if (!name) return c.json({ success: false, error: 'Service name is required' }, 400);

    const result = await pool.query(
      `INSERT INTO services (shop_id, category_id, name, price, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [shopId, body.categoryId || null, name, price, body.description || null, userId]
    );

    cache.invalidateByPrefix('services:');

    const user = (c.get('user') as any) || {};
    logActivity({
      userId,
      userName: user.name || user.email || 'Unknown',
      userEmail: user.email || '',
      action: 'service_created',
      entityType: 'service',
      entityId: result.rows[0].id,
      shopId,
      details: { name, price }
    }).catch(() => {});

    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── Settings (per-shop) ─────────────────────────────────────────────────────
// NOTE: these static routes MUST stay above `/:id` — Hono matches in
// registration order, so a later PUT /settings would be swallowed by PUT /:id
// and "settings" would be used as a UUID (invalid input syntax for type uuid).
router.get('/settings', requirePermission('service:read'), async (c) => {
  try {
    const shopId = guardShop(c, c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);
    const settings = await getServicesSettings(shopId);
    return c.json({ success: true, data: settings });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

router.put('/settings', requirePermission('settings:update'), async (c) => {
  try {
    const body = await c.req.json();
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const settings = await saveServicesSettings(shopId, {
      add_to_sales: body.add_to_sales === true
    });

    // Stats are cached per shop — force a recompute after the toggle changes.
    cache.invalidateByPrefix('stats:');

    return c.json({ success: true, data: settings });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

router.put('/:id', requirePermission('service:update'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const result = await pool.query(
      `UPDATE services SET name = $1, price = $2, category_id = $3, description = $4,
              is_active = $5, updated_at = NOW()
       WHERE id = $6 AND shop_id = $7 RETURNING *`,
      [body.name, parseFloat(body.price) || 0, body.categoryId || null,
       body.description || null, body.isActive ?? true, id, shopId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Service not found' }, 404);

    cache.invalidateByPrefix('services:');
    return c.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

router.delete('/:id', requirePermission('service:update'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const result = await pool.query(
      `DELETE FROM services WHERE id = $1 AND shop_id = $2 RETURNING id`,
      [id, shopId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Service not found' }, 404);

    cache.invalidateByPrefix('services:');
    return c.json({ success: true, message: 'Service deleted' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── Record a service performed ──────────────────────────────────────────────
router.post('/records', requirePermission('service:create'), async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId') as string;
    const shopId = guardShop(c, body.shopId || c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    let serviceName = (body.serviceName || '').trim();
    let unitPrice = parseFloat(body.unitPrice);
    let categoryId: string | null = body.categoryId || null;
    let categoryName: string | null = body.categoryName || null;

    // Look the service up by id if provided
    if (body.serviceId) {
      const svc = await pool.query(
        `SELECT s.*, sc.name as category_name FROM services s
         LEFT JOIN service_categories sc ON sc.id = s.category_id
         WHERE s.id = $1 AND s.shop_id = $2`,
        [body.serviceId, shopId]
      );
      if (svc.rows.length === 0) {
        return c.json({ success: false, error: 'Service not found in this shop' }, 400);
      }
      const s = svc.rows[0];
      serviceName = serviceName || s.name;
      if (!Number.isFinite(unitPrice)) unitPrice = parseFloat(s.price) || 0;
      categoryId = s.category_id;
      categoryName = s.category_name;
    }

    if (!serviceName) return c.json({ success: false, error: 'Service name is required' }, 400);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      return c.json({ success: false, error: 'A valid service price is required' }, 400);
    }

    const quantity = parseFloat(body.quantity) || 1;
    const total = Math.round(quantity * unitPrice * 100) / 100;

    const result = await pool.query(
      `INSERT INTO service_records (shop_id, service_id, service_name, category_id, category_name,
        quantity, unit_price, total, customer_name, customer_phone, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [shopId, body.serviceId || null, serviceName, categoryId, categoryName,
       quantity, unitPrice, total, body.customerName || null,
       body.customerPhone || null, body.notes || null, userId]
    );

    // Keep dashboard stats fresh immediately
    cache.invalidateByPrefix('stats:');

    const user = (c.get('user') as any) || {};
    logActivity({
      userId,
      userName: user.name || user.email || 'Unknown',
      userEmail: user.email || '',
      action: 'service_recorded',
      entityType: 'service_record',
      entityId: result.rows[0].id,
      shopId,
      details: { serviceName, total }
    }).catch(() => {});

    const row = result.rows[0];
    return c.json({
      success: true,
      data: {
        id: row.id,
        serviceName: row.service_name,
        quantity: parseFloat(row.quantity),
        unitPrice: parseFloat(row.unit_price),
        total: parseFloat(row.total),
        customerName: row.customer_name,
        createdAt: row.created_at
      }
    }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── Service records list ────────────────────────────────────────────────────
router.get('/records', requirePermission('service:read'), async (c) => {
  try {
    const shopId = guardShop(c, c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE sr.shop_id = $1';
    const params: any[] = [shopId];

    if (startDate) {
      params.push(`${startDate} 00:00:00`);
      whereClause += ` AND sr.created_at >= $${params.length}`;
    }
    if (endDate) {
      params.push(`${endDate} 23:59:59`);
      whereClause += ` AND sr.created_at <= $${params.length}`;
    }

    const countRes = await readDb.read(
      `SELECT COUNT(*) as total FROM service_records sr ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].total);

    const totalRes = await readDb.read(
      `SELECT COALESCE(SUM(total), 0) as total FROM service_records sr ${whereClause}`,
      params
    );

    params.push(limit, offset);
    const result = await readDb.read(
      `SELECT sr.*, u.first_name || ' ' || COALESCE(u.last_name, '') as recorded_by_name
       FROM service_records sr
       LEFT JOIN "user" u ON sr.recorded_by = u.id
       ${whereClause}
       ORDER BY sr.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return c.json({
      success: true,
      data: {
        records: result.rows.map((r: any) => ({
          id: r.id,
          serviceId: r.service_id,
          serviceName: r.service_name,
          categoryName: r.category_name,
          quantity: parseFloat(r.quantity),
          unitPrice: parseFloat(r.unit_price),
          total: parseFloat(r.total),
          customerName: r.customer_name,
          customerPhone: r.customer_phone,
          notes: r.notes,
          recordedByName: r.recorded_by_name,
          createdAt: r.created_at
        })),
        totalAmount: parseFloat(totalRes.rows[0].total),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── Stats: today / week / month / custom range ─────────────────────────────
router.get('/records/stats', requirePermission('service:read'), async (c) => {
  try {
    const shopId = guardShop(c, c.req.query('shopId'));
    if (!shopId) return c.json({ success: false, error: 'No shop access' }, 403);

    const customStart = c.req.query('startDate');
    const customEnd = c.req.query('endDate');

    const periods: Record<string, { start: string; end: string }> = {};
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Today (EAT-compatible: local server day)
    periods.today = { start: today, end: today };

    // This week (Monday start)
    const day = now.getDay(); // 0=Sun
    const diffToMon = (day + 6) % 7;
    const mon = new Date(now);
    mon.setDate(now.getDate() - diffToMon);
    periods.week = {
      start: mon.toISOString().split('T')[0],
      end: today
    };

    // This month
    periods.month = {
      start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0],
      end: today
    };

    if (customStart && customEnd) {
      periods.custom = { start: customStart, end: customEnd };
    }

    const out: Record<string, any> = {};
    for (const [key, range] of Object.entries(periods)) {
      const res = await readDb.read(
        `SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
         FROM service_records
         WHERE shop_id = $1 AND created_at >= $2 AND created_at <= $3`,
        [shopId, `${range.start} 00:00:00`, `${range.end} 23:59:59`]
      );
      out[key] = {
        count: parseInt(res.rows[0].count),
        total: parseFloat(res.rows[0].total)
      };
    }

    // Breakdown by service for the custom/default range
    const range = customStart && customEnd ? periods.custom : periods.today;
    const byServiceRes = await readDb.read(
      `SELECT service_name, category_name, COUNT(*) as count, COALESCE(SUM(total), 0) as total
       FROM service_records
       WHERE shop_id = $1 AND created_at >= $2 AND created_at <= $3
       GROUP BY service_name, category_name
       ORDER BY total DESC`,
      [shopId, `${range.start} 00:00:00`, `${range.end} 23:59:59`]
    );

    // Daily totals for the range (chart)
    const byDayRes = await readDb.read(
      `SELECT DATE(created_at) as date, COUNT(*) as count, COALESCE(SUM(total), 0) as total
       FROM service_records
       WHERE shop_id = $1 AND created_at >= $2 AND created_at <= $3
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [shopId, `${range.start} 00:00:00`, `${range.end} 23:59:59`]
    );

    return c.json({
      success: true,
      data: {
        periods: out,
        byService: byServiceRes.rows.map((r: any) => ({
          serviceName: r.service_name,
          categoryName: r.category_name,
          count: parseInt(r.count),
          total: parseFloat(r.total)
        })),
        byDay: byDayRes.rows.map((r: any) => ({
          date: r.date,
          count: parseInt(r.count),
          total: parseFloat(r.total)
        }))
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

export default router;