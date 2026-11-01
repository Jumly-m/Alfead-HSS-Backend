import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { logActivity } from '../../utils/activity-logger.js';
import { cache } from '../../utils/cache.js';
import { createCategorySchema, updateCategorySchema, reassignProductsSchema } from './category.schema.js';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    shopIds: string[];
    tenantId: string;
  }
}>();

router.use('*', authMiddleware);

// Resolve the shop we operate on: explicit shopId (admins) or the user's shop.
function resolveShopId(c: any): { shopId: string; shopIds: string[]; userRole: string } {
  const shopIds = c.get('shopIds') as string[] || [];
  const userRole = c.get('userRole');

  let shopId = c.req.query('shopId');
  if (!shopId && shopIds.length === 1) shopId = shopIds[0];

  return { shopId, shopIds, userRole };
}

// GET /api/categories?shopId= — categories with per-category stats
router.get('/', requirePermission('product:read'), async (c) => {
  try {
    const { shopId, userRole } = resolveShopId(c);
    if (!shopId) return c.json({ success: true, data: [], meta: { totalProducts: 0, uncategorized: { product_count: 0, stock_value_cost: 0, stock_value_selling: 0 } } });

    const categoriesRes = await pool.query(
      `SELECT c.id, c.name, c.description, c.color, c.created_at,
              COUNT(p.id) FILTER (WHERE p.is_active = true) as product_count,
              COALESCE(SUM(p.current_stock * p.buying_price) FILTER (WHERE p.is_active = true), 0) as stock_value_cost,
              COALESCE(SUM(p.current_stock * p.selling_price) FILTER (WHERE p.is_active = true), 0) as stock_value_selling
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.shop_id = c.shop_id
       WHERE c.shop_id = $1
       GROUP BY c.id, c.name, c.description, c.color, c.created_at
       ORDER BY c.name ASC`,
      [shopId]
    );

    const uncatRes = await pool.query(
      `SELECT COUNT(*) as product_count,
              COALESCE(SUM(current_stock * buying_price), 0) as stock_value_cost,
              COALESCE(SUM(current_stock * selling_price), 0) as stock_value_selling
       FROM products
       WHERE shop_id = $1 AND category_id IS NULL AND is_active = true`,
      [shopId]
    );

    const totalRes = await pool.query(
      `SELECT COUNT(*) as total FROM products WHERE shop_id = $1 AND is_active = true`,
      [shopId]
    );

    const categories = categoriesRes.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color || '#059669',
      createdAt: r.created_at,
      productCount: parseInt(r.product_count) || 0,
      stockValueCost: parseFloat(r.stock_value_cost) || 0,
      stockValueSelling: parseFloat(r.stock_value_selling) || 0,
      expectedRevenue: parseFloat(r.stock_value_selling) || 0,
    }));

    return c.json({
      success: true,
      data: categories,
      meta: {
        totalProducts: parseInt(totalRes.rows[0].total) || 0,
        uncategorized: {
          productCount: parseInt(uncatRes.rows[0].product_count) || 0,
          stockValueCost: parseFloat(uncatRes.rows[0].stock_value_cost) || 0,
          stockValueSelling: parseFloat(uncatRes.rows[0].stock_value_selling) || 0,
          expectedRevenue: parseFloat(uncatRes.rows[0].stock_value_selling) || 0,
        },
      },
    });
  } catch (e: any) {
    console.error('[Categories] list error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /api/categories/:id/products?limit= — products assigned to a category
router.get('/:id/products', requirePermission('product:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    const limit = Math.min(parseInt(c.req.query('limit') || '5000'), 5000);
    const offset = Math.max(parseInt(c.req.query('offset') || '0'), 0);

    const shopWhere = userRole === 'developer' ? '' : `AND p.shop_id = ANY($2::uuid[])`;
    const params: any[] = [id];
    if (userRole !== 'developer') params.push(shopIds);

    const res = await pool.query(
      `SELECT p.id, p.name, p.sku, p.barcode, p.selling_price, p.buying_price, p.current_stock,
              p.low_stock_threshold, p.unit_type, p.is_active
       FROM products p
       WHERE p.category_id = $1 ${shopWhere}
       ORDER BY p.name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return c.json({
      success: true,
      data: res.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        sku: r.sku,
        barcode: r.barcode,
        sellingPrice: r.selling_price,
        buyingPrice: r.buying_price,
        currentStock: r.current_stock,
        lowStockThreshold: r.low_stock_threshold,
        unitType: r.unit_type,
        isActive: r.is_active,
      })),
    });
  } catch (e: any) {
    console.error('[Categories] products error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /api/categories — create
router.post('/', requirePermission('product:create'), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createCategorySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
    }
    const { shopId, name, description, color } = parsed.data;

    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Access denied to this shop' }, 403);
    }

    const existing = await pool.query(
      `SELECT id FROM categories WHERE shop_id = $1 AND LOWER(name) = LOWER($2)`,
      [shopId, name]
    );
    if (existing.rows.length > 0) {
      return c.json({ success: false, error: `Category "${name}" already exists for this shop` }, 409);
    }

    const result = await pool.query(
      `INSERT INTO categories (shop_id, name, description, color)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [shopId, name, description || null, color || '#059669']
    );

    const user = (c as any).get('user');
    await logActivity({
      userId: c.get('userId'),
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'category_created',
      entityType: 'category',
      entityId: result.rows[0].id,
      shopId,
      details: { name },
    });

    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    console.error('[Categories] create error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// PUT /api/categories/:id — update
router.put('/:id', requirePermission('product:update'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateCategorySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
    }

    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    const ownRes = await pool.query(`SELECT shop_id FROM categories WHERE id = $1`, [id]);
    if (ownRes.rows.length === 0) {
      return c.json({ success: false, error: 'Category not found' }, 404);
    }
    if (userRole !== 'developer' && !shopIds.includes(ownRes.rows[0].shop_id)) {
      return c.json({ success: false, error: 'Access denied to this category' }, 403);
    }

    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (parsed.data.name !== undefined) {
      updates.push(`name = $${i++}`);
      values.push(parsed.data.name);
    }
    if (parsed.data.description !== undefined) {
      updates.push(`description = $${i++}`);
      values.push(parsed.data.description);
    }
    if (parsed.data.color !== undefined) {
      updates.push(`color = $${i++}`);
      values.push(parsed.data.color);
    }
    if (updates.length === 0) {
      return c.json({ success: false, error: 'Nothing to update' }, 400);
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE categories SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
      values
    );

    const user = (c as any).get('user');
    await logActivity({
      userId: c.get('userId'),
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'category_updated',
      entityType: 'category',
      entityId: id,
      shopId: ownRes.rows[0].shop_id,
      details: { changes: Object.keys(parsed.data) },
    });

    return c.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    console.error('[Categories] update error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// DELETE /api/categories/:id — delete (products become uncategorized)
router.delete('/:id', requirePermission('product:delete'), async (c) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');

    const ownRes = await pool.query(`SELECT shop_id FROM categories WHERE id = $1`, [id]);
    if (ownRes.rows.length === 0) {
      return c.json({ success: false, error: 'Category not found' }, 404);
    }
    if (userRole !== 'developer' && !shopIds.includes(ownRes.rows[0].shop_id)) {
      return c.json({ success: false, error: 'Access denied to this category' }, 403);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Move products to "no category" first (FK is ON DELETE SET NULL anyway,
      // but we do it explicitly so we can log how many moved).
      const moved = await client.query(
        `UPDATE products SET category_id = NULL WHERE category_id = $1 RETURNING id`,
        [id]
      );
      await client.query(`DELETE FROM categories WHERE id = $1`, [id]);
      await client.query('COMMIT');

      const user = (c as any).get('user');
      await logActivity({
        userId: c.get('userId'),
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'category_deleted',
        entityType: 'category',
        entityId: id,
        shopId: ownRes.rows[0].shop_id,
        details: { movedProducts: moved.rowCount },
      });

      return c.json({ success: true, message: 'Category deleted', movedProducts: moved.rowCount });
    } catch (e: any) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) {
    console.error('[Categories] delete error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /api/categories/reassign — bulk move products to a category (or clear it)
router.post('/reassign', requirePermission('product:update'), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = reassignProductsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
    }
    const { shopId, categoryId, productIds } = parsed.data;

    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Access denied to this shop' }, 403);
    }

    if (categoryId) {
      const catRes = await pool.query(`SELECT id FROM categories WHERE id = $1 AND shop_id = $2`, [categoryId, shopId]);
      if (catRes.rows.length === 0) {
        return c.json({ success: false, error: 'Category not found in this shop' }, 404);
      }
    }

    const result = await pool.query(
      `UPDATE products SET category_id = $1, updated_at = NOW()
       WHERE shop_id = $2 AND id = ANY($3::uuid[]) RETURNING id`,
      [categoryId, shopId, productIds]
    );

    const user = (c as any).get('user');
    await logActivity({
      userId: c.get('userId'),
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: categoryId ? 'products_categorized' : 'products_uncategorized',
      entityType: 'category',
      entityId: categoryId || undefined,
      shopId,
      details: { productIds, categoryId },
    });

    // Invalidate product caches so lists reflect the change immediately
    cache.invalidateByPrefix('products:shop');

    return c.json({ success: true, data: { updated: result.rowCount, categoryId } });
  } catch (e: any) {
    console.error('[Categories] reassign error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default router;
