import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { db as readDb } from '../../config/database.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { cache } from '../../utils/cache.js';
import { logActivity } from '../../utils/activity-logger.js';

const router = new Hono();

const getShopIds = (c: any): string[] => c.get('shopIds') as string[];

// ============ SUPPLIERS CRUD ============

// GET /api/suppliers - list suppliers with stats
router.get('/', authMiddleware, requirePermission('supplier:read'), async (c: any) => {
  try {
    const shopIds = getShopIds(c);
    const shopId = c.req.query('shopId');
    const search = c.req.query('search');

    let whereClause = shopId && shopIds.includes(shopId)
      ? 'WHERE s.shop_id = $1'
      : 'WHERE s.shop_id = ANY($1)';
    const params: any[] = shopId && shopIds.includes(shopId) ? [shopId] : [shopIds];

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (s.name ILIKE $${params.length} OR s.phone ILIKE $${params.length})`;
    }

    const result = await readDb.read(
      `SELECT s.*, sh.name as shop_name,
        (SELECT COUNT(*) FROM supplier_orders so WHERE so.supplier_id = s.id AND so.shop_id = s.shop_id) as order_count,
        (SELECT COALESCE(SUM(so.total_amount), 0) FROM supplier_orders so WHERE so.supplier_id = s.id AND so.shop_id = s.shop_id) as total_ordered,
        (SELECT COALESCE(SUM(so.total_amount - so.paid_amount), 0) FROM supplier_orders so WHERE so.supplier_id = s.id AND so.shop_id = s.shop_id AND so.status != 'cancelled') as total_owed
       FROM suppliers s
       LEFT JOIN shops sh ON sh.id = s.shop_id
       ${whereClause}
       ORDER BY s.created_at DESC`,
      params
    );

    const suppliers = result.rows.map((r: any) => ({
      id: r.id,
      shopId: r.shop_id,
      shopName: r.shop_name || null,
      name: r.name,
      phone: r.phone,
      email: r.email,
      address: r.address,
      notes: r.notes,
      orderCount: parseInt(r.order_count) || 0,
      totalOrdered: parseFloat(r.total_ordered) || 0,
      totalOwed: parseFloat(r.total_owed) || 0,
      createdAt: r.created_at,
    }));

    return c.json({ success: true, data: { suppliers } });
  } catch (error: any) {
    console.error('[Suppliers List]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/suppliers - create supplier
router.post('/', authMiddleware, requirePermission('supplier:create'), requireActiveSubscription, async (c: any) => {
  try {
    const shopIds = getShopIds(c);
    const body = await c.req.json();
    const { shopId, name, phone, email, address, notes } = body;

    if (!shopId || !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }
    if (!name || !name.trim()) {
      return c.json({ success: false, error: 'Supplier name is required' }, 400);
    }

    const result = await pool.query(
      `INSERT INTO suppliers (shop_id, name, phone, email, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [shopId, name.trim(), phone || null, email || null, address || null, notes || null]
    );

    const userId = c.get('userId');
    const user = c.get('user') as any;
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'supplier_created',
      entityType: 'supplier',
      entityId: result.rows[0].id,
      shopId,
      details: { name }
    }).catch(() => {});

    return c.json({ success: true, data: { supplier: result.rows[0] } }, 201);
  } catch (error: any) {
    console.error('[Supplier Create]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// PUT /api/suppliers/:id - update supplier
router.put('/:id', authMiddleware, requirePermission('supplier:update'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = getShopIds(c);
    const body = await c.req.json();
    const { name, phone, email, address, notes } = body;

    const result = await pool.query(
      `UPDATE suppliers SET name = $1, phone = $2, email = $3, address = $4, notes = $5, updated_at = NOW()
       WHERE id = $6 AND shop_id = ANY($7) RETURNING *`,
      [name?.trim() || null, phone || null, email || null, address || null, notes || null, id, shopIds]
    );

    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Supplier not found' }, 404);
    }

    return c.json({ success: true, data: { supplier: result.rows[0] } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// DELETE /api/suppliers/:id - delete supplier
router.delete('/:id', authMiddleware, requirePermission('supplier:delete'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = getShopIds(c);

    await pool.query('DELETE FROM suppliers WHERE id = $1 AND shop_id = ANY($2)', [id, shopIds]);

    const userId = c.get('userId');
    const user = c.get('user') as any;
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'supplier_deleted',
      entityType: 'supplier',
      entityId: id,
      shopId: shopIds?.[0],
      details: { deletedSupplierId: id }
    }).catch(() => {});

    return c.json({ success: true, message: 'Supplier deleted' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ============ SUPPLIER ORDERS ============

// GET /api/suppliers/orders - list orders with filters
router.get('/orders', authMiddleware, requirePermission('supplier:read'), async (c: any) => {
  try {
    const shopIds = getShopIds(c);
    const shopId = c.req.query('shopId');
    const supplierId = c.req.query('supplierId');
    const status = c.req.query('status');
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');

    let whereClause = shopId && shopIds.includes(shopId)
      ? 'WHERE so.shop_id = $1'
      : 'WHERE so.shop_id = ANY($1)';
    const params: any[] = shopId && shopIds.includes(shopId) ? [shopId] : [shopIds];
    let paramIndex = 2;

    if (supplierId) { whereClause += ` AND so.supplier_id = $${paramIndex}`; params.push(supplierId); paramIndex++; }
    if (status && status !== 'all') { whereClause += ` AND so.status = $${paramIndex}`; params.push(status); paramIndex++; }
    if (startDate) { whereClause += ` AND so.order_date >= $${paramIndex}`; params.push(startDate); paramIndex++; }
    if (endDate) { whereClause += ` AND so.order_date <= $${paramIndex}`; params.push(endDate); paramIndex++; }

    const result = await readDb.read(
      `SELECT so.*, s.name as supplier_name, s.phone as supplier_phone, sh.name as shop_name,
        (SELECT COUNT(*) FROM supplier_order_items soi WHERE soi.order_id = so.id) as item_count,
        (SELECT COALESCE(SUM(soi.received_quantity), 0) FROM supplier_order_items soi WHERE soi.order_id = so.id) as received_qty,
        (SELECT COALESCE(SUM(soi.quantity), 0) FROM supplier_order_items soi WHERE soi.order_id = so.id) as ordered_qty
       FROM supplier_orders so
       JOIN suppliers s ON so.supplier_id = s.id
       LEFT JOIN shops sh ON sh.id = so.shop_id
       ${whereClause}
       ORDER BY so.order_date DESC, so.created_at DESC`,
      params
    );

    const orders = result.rows.map((r: any) => ({
      id: r.id,
      shopId: r.shop_id,
      shopName: r.shop_name || null,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      supplierPhone: r.supplier_phone,
      orderNumber: r.order_number,
      status: r.status,
      totalAmount: parseFloat(r.total_amount) || 0,
      paidAmount: parseFloat(r.paid_amount) || 0,
      balance: Math.max(0, (parseFloat(r.total_amount) || 0) - (parseFloat(r.paid_amount) || 0)),
      orderDate: r.order_date,
      receivedDate: r.received_date,
      dueDate: r.due_date,
      notes: r.notes,
      itemCount: parseInt(r.item_count) || 0,
      orderedQty: parseFloat(r.ordered_qty) || 0,
      receivedQty: parseFloat(r.received_qty) || 0,
      createdAt: r.created_at,
    }));

    return c.json({ success: true, data: { orders } });
  } catch (error: any) {
    console.error('[Orders List]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/suppliers/orders - create order
router.post('/orders', authMiddleware, requirePermission('supplier:create'), requireActiveSubscription, async (c: any) => {
  try {
    const shopIds = getShopIds(c);
    const body = await c.req.json();
    const { shopId, supplierId, items, orderDate, dueDate, notes } = body;
    const userId = c.get('userId') as string;

    if (!shopId || !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Invalid shop' }, 400);
    }
    if (!supplierId) {
      return c.json({ success: false, error: 'Supplier is required' }, 400);
    }
    // The supplier may belong to ANY of the user's own shops — a supplier saved
    // before the store module existed (or under another of their shops) must
    // stay usable in the Ghala. Other tenants' suppliers are still never allowed.
    const supplierCheck = await readDb.read(
      `SELECT id, shop_id FROM suppliers WHERE id = $1 AND shop_id = ANY($2)`,
      [supplierId, shopIds]
    );
    if (supplierCheck.rows.length === 0) {
      return c.json({ success: false, error: 'Supplier not found' }, 400);
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: 'Add at least one item' }, 400);
    }

    let total = 0;
    for (const it of items) {
      const qty = parseFloat(it.quantity) || 1;
      const cost = parseFloat(it.unitCost) || 0;
      total += qty * cost;
    }

    const orderNumber = `SO-${Date.now().toString().slice(-8)}`;

    await pool.query('BEGIN');
    try {
      const orderResult = await pool.query(
        `INSERT INTO supplier_orders (shop_id, supplier_id, order_number, status, total_amount, paid_amount, order_date, due_date, notes, created_by)
         VALUES ($1, $2, $3, 'pending', $4, 0, COALESCE($5, CURRENT_DATE), $6, $7, $8)
         RETURNING *`,
        [shopId, supplierId, orderNumber, total, orderDate || null, dueDate || null, notes || null, userId]
      );
      const orderId = orderResult.rows[0].id;

      for (const it of items) {
        const qty = parseFloat(it.quantity) || 1;
        const cost = parseFloat(it.unitCost) || 0;
        await pool.query(
          `INSERT INTO supplier_order_items (order_id, product_id, product_name, quantity, unit_cost, total_cost, expiry_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, it.productId || null, it.productName || 'Item', qty, cost, qty * cost, it.expiryDate || null]
        );
      }

      await pool.query('COMMIT');

      const user = c.get('user') as any;
      logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'supplier_order_created',
        entityType: 'supplier_order',
        entityId: orderId,
        shopId,
        details: { supplierId, total, itemCount: items.length }
      }).catch(() => {});

      return c.json({ success: true, data: { order: orderResult.rows[0] } }, 201);
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Order Create]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// PUT /api/suppliers/orders/:id - edit a pending order (typos, wrong items,
// wrong supplier, dates, notes). Items are replaced with the submitted list.
// Received orders are locked so stock can never be rewritten after the fact.
router.put('/orders/:id', authMiddleware, requirePermission('supplier:update'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = getShopIds(c);
    const body = await c.req.json();
    const { supplierId, items, orderDate, dueDate, notes } = body;
    const userId = c.get('userId') as string;

    const existing = await pool.query(
      `SELECT * FROM supplier_orders WHERE id = $1 AND shop_id = ANY($2)`,
      [id, shopIds]
    );
    if (existing.rows.length === 0) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    const order = existing.rows[0];
    if (order.status === 'received') {
      return c.json({ success: false, error: 'Received orders cannot be edited' }, 400);
    }
    if (!supplierId) {
      return c.json({ success: false, error: 'Supplier is required' }, 400);
    }
    // The replacement supplier must belong to one of the user's own shops too
    // (it may be a supplier saved under another shop before Ghala existed).
    const supplierCheck = await readDb.read(
      `SELECT id FROM suppliers WHERE id = $1 AND shop_id = ANY($2)`,
      [supplierId, shopIds]
    );
    if (supplierCheck.rows.length === 0) {
      return c.json({ success: false, error: 'Supplier not found' }, 400);
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: 'Add at least one item' }, 400);
    }

    let total = 0;
    for (const it of items) {
      total += (parseFloat(it.quantity) || 1) * (parseFloat(it.unitCost) || 0);
    }

    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE supplier_orders
         SET supplier_id = $1, total_amount = $2, order_date = COALESCE($3, order_date),
             due_date = $4, notes = $5, updated_at = NOW()
         WHERE id = $6`,
        [supplierId, total, orderDate || null, dueDate || null, notes || null, id]
      );

      await pool.query(`DELETE FROM supplier_order_items WHERE order_id = $1`, [id]);
      for (const it of items) {
        const qty = parseFloat(it.quantity) || 1;
        const cost = parseFloat(it.unitCost) || 0;
        await pool.query(
          `INSERT INTO supplier_order_items (order_id, product_id, product_name, quantity, unit_cost, total_cost, expiry_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, it.productId || null, it.productName || 'Item', qty, cost, qty * cost, it.expiryDate || null]
        );
      }

      await pool.query('COMMIT');

      const user = c.get('user') as any;
      logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'supplier_order_updated',
        entityType: 'supplier_order',
        entityId: id,
        shopId: order.shop_id,
        details: { supplierId, total, itemCount: items.length }
      }).catch(() => {});

      cache.invalidateByPrefix('suppliers:');
      return c.json({ success: true, message: 'Order updated' });
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Order Update]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/suppliers/orders/:id - get order with items
router.get('/orders/:id', authMiddleware, requirePermission('supplier:read'), async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = getShopIds(c);

    const orderResult = await readDb.read(
      `SELECT so.*, s.name as supplier_name, s.phone as supplier_phone
       FROM supplier_orders so
       JOIN suppliers s ON so.supplier_id = s.id
       WHERE so.id = $1 AND so.shop_id = ANY($2)`,
      [id, shopIds]
    );
    if (orderResult.rows.length === 0) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const itemsResult = await readDb.read(
      `SELECT * FROM supplier_order_items WHERE order_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    const paymentsResult = await readDb.read(
      `SELECT sp.*, COALESCE(NULLIF(u.name, ''), NULLIF(TRIM(u.first_name || ' ' || COALESCE(u.last_name, '')), ''), u.email) as received_by_name
       FROM supplier_payments sp
       LEFT JOIN "user" u ON sp.received_by = u.id
       WHERE sp.order_id = $1 ORDER BY sp.created_at DESC`,
      [id]
    );

    const order = orderResult.rows[0];
    const items = itemsResult.rows.map((r: any) => ({
      id: r.id,
      productId: r.product_id || null,
      productName: r.product_name,
      quantity: parseFloat(r.quantity),
      unitCost: parseFloat(r.unit_cost),
      totalCost: parseFloat(r.total_cost),
      receivedQuantity: parseFloat(r.received_quantity) || 0,
      expiryDate: r.expiry_date || null,
    }));
    const payments = paymentsResult.rows.map((r: any) => ({
      id: r.id,
      amount: parseFloat(r.amount),
      paymentMethod: r.payment_method,
      date: r.date,
      notes: r.notes,
      receivedBy: r.received_by_name || 'Unknown',
      createdAt: r.created_at,
    }));

    return c.json({
      success: true,
      data: {
        order: {
          id: order.id,
          shopId: order.shop_id,
          supplierId: order.supplier_id,
          supplierName: order.supplier_name,
          supplierPhone: order.supplier_phone,
          orderNumber: order.order_number,
          status: order.status,
          totalAmount: parseFloat(order.total_amount) || 0,
          paidAmount: parseFloat(order.paid_amount) || 0,
          balance: Math.max(0, (parseFloat(order.total_amount) || 0) - (parseFloat(order.paid_amount) || 0)),
          orderDate: order.order_date,
          receivedDate: order.received_date,
          dueDate: order.due_date,
          notes: order.notes,
          items,
          payments,
        }
      }
    });
  } catch (error: any) {
    console.error('[Order Detail]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/suppliers/orders/:id/receive - mark order as received AND move the
// received quantities into stock. Stock lands in the shop the order belongs to:
// when that is a Ghala/store, it enters the store's catalog and is logged as a
// store movement, ready to be dispatched to shops from there.
router.post('/orders/:id/receive', authMiddleware, requirePermission('supplier:update'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = getShopIds(c);
    const body = await c.req.json();
    const { receivedDate, notes, items } = body;
    const userId = c.get('userId') as string;

    const orderResult = await pool.query(
      `SELECT so.*, s.name as supplier_name FROM supplier_orders so
       LEFT JOIN suppliers s ON s.id = so.supplier_id
       WHERE so.id = $1 AND so.shop_id = ANY($2)`,
      [id, shopIds]
    );
    if (orderResult.rows.length === 0) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    const order = orderResult.rows[0];
    if (order.status === 'received') {
      return c.json({ success: false, error: 'This order was already received' }, 400);
    }

    // Is the order's shop a Ghala/store? Then received stock is a store
    // movement (dispatchable to shops); otherwise it is plain shop stock.
    const shopTypeRes = await pool.query(`SELECT type FROM shops WHERE id = $1`, [order.shop_id]);
    const isStore = shopTypeRes.rows[0]?.type === 'store';

    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Unknown';

    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE supplier_orders SET status = 'received', received_date = COALESCE($1, CURRENT_DATE), notes = COALESCE($2, notes), updated_at = NOW()
         WHERE id = $3`,
        [receivedDate || null, notes || null, id]
      );

      const orderItems = (await pool.query(
        `SELECT * FROM supplier_order_items WHERE order_id = $1`,
        [id]
      )).rows;

      const provided = new Map<string, number>(
        (Array.isArray(items) ? items : []).map((it: any) => [String(it.id), parseFloat(it.receivedQuantity)])
      );

      for (const it of orderItems) {
        const providedQty = provided.get(String(it.id));
        const qty = Number.isFinite(providedQty as number)
          ? (providedQty as number)
          : (parseFloat(it.received_quantity) || parseFloat(it.quantity) || 0);

        await pool.query(
          `UPDATE supplier_order_items SET received_quantity = $1 WHERE id = $2 AND order_id = $3`,
          [qty, it.id, id]
        );
        if (qty <= 0) continue;

        const unitCost = parseFloat(it.unit_cost) || 0;

        // Resolve the product in the order's shop: the picked product first,
        // then an exact name match, otherwise create it so the received stock
        // is immediately usable (and dispatchable when this is a store).
        let productId: string | null = it.product_id || null;
        if (productId) {
          const owns = await pool.query(
            `SELECT id FROM products WHERE id = $1 AND shop_id = $2`,
            [productId, order.shop_id]
          );
          if (owns.rows.length === 0) productId = null;
        }
        if (!productId) {
          const byName = await pool.query(
            `SELECT id FROM products WHERE shop_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
            [order.shop_id, it.product_name]
          );
          productId = byName.rows[0]?.id || null;
        }

        if (productId) {
          await pool.query(
            `UPDATE products
             SET current_stock = current_stock + $1,
                 buying_price = CASE WHEN $2 > 0 THEN $2 ELSE buying_price END,
                 expiry_date = COALESCE($3::timestamp, expiry_date),
                 updated_at = NOW()
             WHERE id = $4`,
            [qty, unitCost, it.expiry_date || null, productId]
          );
        } else {
          const created = await pool.query(
            `INSERT INTO products (shop_id, name, buying_price, selling_price, current_stock, low_stock_threshold, expiry_date, created_by)
             VALUES ($1, $2, $3, $3, $4, 0, $5, $6) RETURNING id`,
            [order.shop_id, it.product_name, unitCost, qty, it.expiry_date || null, userId]
          );
          productId = created.rows[0].id;
        }

        if (isStore) {
          await pool.query(
            `INSERT INTO store_stock_movements (store_shop_id, product_id, product_name, type, quantity, unit_cost, total_cost, reference_type, reference_id, supplier_name, notes, created_by, created_by_name)
             VALUES ($1, $2, $3, 'receive', $4, $5, $6, 'supplier_order', $7, $8, $9, $10, $11)`,
            [order.shop_id, productId, it.product_name, qty, unitCost, qty * unitCost, order.id, order.supplier_name || null, notes || null, userId, userName]
          );
        }
      }

      await pool.query('COMMIT');

      cache.invalidateByPrefix('suppliers:');
      cache.invalidateByPrefix('products:');
      cache.invalidateByPrefix('stats:');
      cache.invalidateByPrefix('reports:');

      logActivity({
        userId,
        userName,
        userEmail: user?.email || '',
        action: 'supplier_order_received',
        entityType: 'supplier_order',
        entityId: id,
        shopId: order.shop_id,
        details: { isStore, itemCount: orderItems.length }
      }).catch(() => {});

      return c.json({
        success: true,
        message: isStore
          ? 'Order received — stock added to the store (ghala)'
          : 'Order received — stock added to the shop',
      });
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Order Receive]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/suppliers/orders/:id/payment - record payment to supplier
router.post('/orders/:id/payment', authMiddleware, requirePermission('supplier:create'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = getShopIds(c);
    const body = await c.req.json();
    const { amount, paymentMethod, date, notes } = body;
    const userId = c.get('userId') as string;

    const orderResult = await pool.query(
      'SELECT * FROM supplier_orders WHERE id = $1 AND shop_id = ANY($2)',
      [id, shopIds]
    );
    if (orderResult.rows.length === 0) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    const order = orderResult.rows[0];

    const payAmount = parseFloat(amount) || 0;
    if (payAmount <= 0) {
      return c.json({ success: false, error: 'Amount must be greater than 0' }, 400);
    }

    const currentPaid = parseFloat(order.paid_amount) || 0;
    const total = parseFloat(order.total_amount) || 0;
    const newPaid = currentPaid + payAmount;
    const isPaidOff = newPaid >= total - 0.01;

    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE supplier_orders SET paid_amount = $1,
           status = CASE WHEN $1 >= total_amount - 0.01 THEN 'paid' WHEN $1 > 0 THEN 'partial' ELSE status END,
           updated_at = NOW()
         WHERE id = $2`,
        [newPaid, id]
      );

      await pool.query(
        `INSERT INTO supplier_payments (order_id, shop_id, amount, payment_method, date, notes, received_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, order.shop_id, payAmount, paymentMethod || 'cash', date || null, notes || null, userId]
      );

      await pool.query('COMMIT');

      cache.invalidateByPrefix('suppliers:');
      const user = c.get('user') as any;
      logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'supplier_payment',
        entityType: 'supplier_order',
        entityId: id,
        shopId: order.shop_id,
        details: { amount: payAmount, isPaidOff }
      }).catch(() => {});

      return c.json({ success: true, message: 'Payment recorded' });
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Supplier Payment]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// DELETE /api/suppliers/orders/:id - delete order
router.delete('/orders/:id', authMiddleware, requirePermission('supplier:delete'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = getShopIds(c);

    await pool.query('DELETE FROM supplier_orders WHERE id = $1 AND shop_id = ANY($2)', [id, shopIds]);

    return c.json({ success: true, message: 'Order deleted' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ============ SUPPLIER REPORT ============

// GET /api/suppliers/report - aggregated report with filters
router.get('/report', authMiddleware, requirePermission('supplier:read'), async (c: any) => {
  try {
    const shopIds = getShopIds(c);
    const shopId = c.req.query('shopId');
    const supplierId = c.req.query('supplierId');
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    const period = c.req.query('period'); // today | week | month | year | custom

    // A supplier belongs to exactly one shop. Scope BOTH the orders and the
    // suppliers themselves to the requested shop(s): filtering only the joined
    // orders (the old behaviour) listed every supplier in the whole database,
    // so shops saw each other's supplier names.
    const scopedToShop = Boolean(shopId && shopIds.includes(shopId));
    const orderShopFilter = scopedToShop ? 'so.shop_id = $1' : 'so.shop_id = ANY($1)';
    const supplierShopFilter = scopedToShop ? 's.shop_id = $1' : 's.shop_id = ANY($1)';
    const params: any[] = scopedToShop ? [shopId] : [shopIds];
    let paramIndex = 2;

    let orderFilters = orderShopFilter;
    let supplierIdParam = 0;
    if (supplierId && supplierId !== 'all') {
      supplierIdParam = paramIndex;
      orderFilters += ` AND so.supplier_id = $${paramIndex}`;
      params.push(supplierId);
      paramIndex++;
    }
    if (startDate) { orderFilters += ` AND so.order_date >= $${paramIndex}`; params.push(startDate); paramIndex++; }
    if (endDate) { orderFilters += ` AND so.order_date <= $${paramIndex}`; params.push(endDate); paramIndex++; }

    const summaryResult = await readDb.read(
      `SELECT
         COUNT(*) as order_count,
         COALESCE(SUM(so.total_amount), 0) as total_ordered,
         COALESCE(SUM(so.paid_amount), 0) as total_paid,
         COALESCE(SUM(so.total_amount - so.paid_amount), 0) as total_owed,
         COUNT(*) FILTER (WHERE so.status = 'received') as received_count,
         COUNT(*) FILTER (WHERE so.status = 'pending') as pending_count
       FROM supplier_orders so
       WHERE ${orderFilters}`,
      params
    );

    const supplierWhere = supplierIdParam
      ? `${supplierShopFilter} AND s.id = $${supplierIdParam}`
      : supplierShopFilter;

    const bySupplierResult = await readDb.read(
      `SELECT s.id, s.name,
         COUNT(so.id) as order_count,
         COALESCE(SUM(so.total_amount), 0) as total_ordered,
         COALESCE(SUM(so.paid_amount), 0) as total_paid,
         COALESCE(SUM(so.total_amount - so.paid_amount), 0) as total_owed
       FROM suppliers s
       LEFT JOIN supplier_orders so ON so.supplier_id = s.id AND ${orderFilters}
       WHERE ${supplierWhere}
       GROUP BY s.id, s.name
       ORDER BY total_owed DESC`,
      params
    );

    const summary = summaryResult.rows[0];
    return c.json({
      success: true,
      data: {
        summary: {
          orderCount: parseInt(summary.order_count) || 0,
          totalOrdered: parseFloat(summary.total_ordered) || 0,
          totalPaid: parseFloat(summary.total_paid) || 0,
          totalOwed: parseFloat(summary.total_owed) || 0,
          receivedCount: parseInt(summary.received_count) || 0,
          pendingCount: parseInt(summary.pending_count) || 0,
        },
        bySupplier: bySupplierResult.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          orderCount: parseInt(r.order_count) || 0,
          totalOrdered: parseFloat(r.total_ordered) || 0,
          totalPaid: parseFloat(r.total_paid) || 0,
          totalOwed: parseFloat(r.total_owed) || 0,
        })),
      }
    });
  } catch (error: any) {
    console.error('[Supplier Report]', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
