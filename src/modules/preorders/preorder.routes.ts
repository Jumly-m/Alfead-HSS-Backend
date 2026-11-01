import { Hono } from 'hono';
import { db as readDb } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { cache } from '../../utils/cache.js';
import { logActivity } from '../../utils/activity-logger.js';

const router = new Hono();

router.get('/', authMiddleware, requirePermission('preorder:read'), async (c: any) => {
  try {
    const shopIds = c.get('shopIds') as string[] || [];
    const shopId = c.req.query('shopId');
    
    if (!shopIds || shopIds.length === 0) {
      return c.json({ success: false, error: 'No shops assigned' }, 400);
    }
    
    const query = shopId && shopIds.includes(shopId) 
      ? `SELECT * FROM pre_orders WHERE shop_id = $1 ORDER BY created_at DESC`
      : `SELECT * FROM pre_orders WHERE shop_id = ANY($1) ORDER BY created_at DESC`;
    
    const params = shopId && shopIds.includes(shopId) ? [shopId] : [shopIds];
    
    const result = await readDb.read(query, params);
    const rows = result.rows;
    
    // Batch-fetch all payments for these pre-orders (eliminate N+1)
    const ids = rows.map(r => r.id);
    const paymentsById: Record<string, any[]> = {};
    if (ids.length > 0) {
      const paymentsRes = await readDb.read(
        `SELECT pre_order_id, id, amount, payment_method, notes, received_by, created_at 
         FROM pre_order_payments WHERE pre_order_id = ANY($1) ORDER BY created_at DESC`,
        [ids]
      );
      for (const p of paymentsRes.rows) {
        if (!paymentsById[p.pre_order_id]) paymentsById[p.pre_order_id] = [];
        paymentsById[p.pre_order_id].push({
          id: p.id,
          amount: parseFloat(p.amount),
          paymentMethod: p.payment_method,
          notes: p.notes,
          createdAt: p.created_at
        });
      }
    }

    const preOrders = rows.map(row => {
      let itemsData = [];
      try {
        itemsData = typeof row.items_data === 'string' ? JSON.parse(row.items_data) : (row.items_data || []);
      } catch { itemsData = []; }
      return {
        id: row.id,
        shopId: row.shop_id,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        customerEmail: row.customer_email,
        productName: row.product_name,
        productId: row.product_id,
        quantity: parseFloat(row.quantity) || 0,
        totalAmount: parseFloat(row.total_amount),
        paidAmount: parseFloat(row.paid_amount),
        status: row.status,
        notes: row.notes,
        items: itemsData,
        payments: paymentsById[row.id] || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
    
    return c.json({ success: true, data: { preOrders } });
  } catch (error: any) {
    console.error('Error fetching pre-orders:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/', authMiddleware, requirePermission('preorder:create'), requireActiveSubscription, async (c: any) => {
  const body = await c.req.json();
  const { shopId, customerName, customerPhone, customerEmail, productName, totalAmount, paidAmount, notes, productId, quantity, items } = body;
  const userId = c.get('userId');
  const initialPaid = parseFloat(paidAmount) || 0;
  const qty = parseFloat(quantity) || 1;
  
  const itemsData = (items || []).map((item: any) => ({
    productId: item.productId || null,
    productName: item.productName,
    quantity: parseFloat(item.quantity) || 0.0001,
    unitPrice: parseFloat(item.unitPrice) || 0,
    buyingPrice: parseFloat(item.buyingPrice) || 0,
    discount: parseFloat(item.discount) || 0,
    total: parseFloat(item.total) || 0,
    profit: parseFloat(item.profit) || 0,
  }));
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Deduct stock FIRST (atomic update, before creating pre-order)
    let stockDeducted = false;
    for (const item of itemsData) {
      if (item.productId) {
        const updResult = await client.query(
          `UPDATE products SET current_stock = GREATEST(0, current_stock - $1), updated_at = NOW() WHERE id = $2`,
          [item.quantity, item.productId]
        );
        if ((updResult.rowCount ?? 0) > 0) stockDeducted = true;
      }
    }
    if (!stockDeducted && productId) {
      const updResult = await client.query(
        `UPDATE products SET current_stock = GREATEST(0, current_stock - $1), updated_at = NOW() WHERE id = $2`,
        [qty, productId]
      );
      if ((updResult.rowCount ?? 0) > 0) stockDeducted = true;
    }
    
    // 2. Create pre-order
    const result = await client.query(
      `INSERT INTO pre_orders (shop_id, customer_name, customer_phone, customer_email, product_name, total_amount, paid_amount, notes, product_id, quantity, items_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [shopId, customerName, customerPhone, customerEmail || null, productName || null, totalAmount, initialPaid, notes || null, productId || null, qty, JSON.stringify(itemsData)]
    );
    const preOrder = result.rows[0];
    
    // 3. Record initial payment if > 0 — creates ONE sale for the entire order
    if (initialPaid > 0) {
      await client.query(
        `INSERT INTO pre_order_payments (pre_order_id, amount, payment_method, received_by, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [preOrder.id, initialPaid, 'cash', userId, 'Initial payment']
      );
      
      const fullTotal = parseFloat(totalAmount) || initialPaid;
      const saleResult = await client.query(
        `INSERT INTO sales (shop_id, seller_id, total_amount, amount_paid, payment_method, payment_status, customer_name, customer_phone, notes, sale_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pre_order')
         RETURNING id`,
        [shopId, userId, fullTotal, initialPaid, 'cash', initialPaid >= fullTotal ? 'paid' : 'partial',
         customerName, customerPhone || null,
         notes ? `${notes} (Pre-order initial payment)` : 'Pre-order initial payment']
      );
      const saleId = saleResult.rows[0].id;
      
      // Link sale to pre_order
      await client.query(
        `UPDATE pre_orders SET sale_id = $1 WHERE id = $2`,
        [saleId, preOrder.id]
      );
      
      // Insert ALL sale_items once (full quantities and profit)
      if (itemsData.length > 0) {
        for (const item of itemsData) {
          await client.query(
            `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, buying_price_at_sale, total_price, profit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [saleId, item.productId || null, item.productName, item.quantity, item.unitPrice, item.buyingPrice, item.total, item.profit]
          );
        }
      } else {
        let buyingPriceAtSale = 0;
        if (productId) {
          const prodResult = await client.query('SELECT buying_price FROM products WHERE id = $1', [productId]);
          if (prodResult.rows.length > 0) {
            buyingPriceAtSale = parseFloat(prodResult.rows[0].buying_price) || 0;
          }
        }
        const itemQty = parseFloat(quantity) || 1;
        const profit = (parseFloat(initialPaid > 0 ? totalAmount : '0') || 0) - (buyingPriceAtSale * itemQty);
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, buying_price_at_sale, total_price, profit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [saleId, productId || null, productName || 'Pre-order item', itemQty, parseFloat(totalAmount) || initialPaid, buyingPriceAtSale, parseFloat(totalAmount) || initialPaid, profit]
        );
      }
    }
    
    await client.query('COMMIT');
    
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
    
    const user = c.get('user') as any;
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'preorder_created',
      entityType: 'preorder',
      entityId: preOrder.id,
      shopId,
      details: { customerName, totalAmount, itemCount: itemsData.length }
    }).catch(() => {});
    
    return c.json({ success: true, data: { preOrder } }, 201);
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    return c.json({ success: false, error: error.message }, 400);
  } finally {
    client.release();
  }
});

router.post('/:id/payment', authMiddleware, requirePermission('preorder:create'), requireActiveSubscription, async (c: any) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { amount, paymentMethod, notes } = body;
  const userId = c.get('userId');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const orderResult = await client.query('SELECT * FROM pre_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return c.json({ success: false, error: 'Pre-order not found' }, 404);
    }
    
    const order = orderResult.rows[0];
    const fullTotal = parseFloat(order.total_amount);
    const newPaidAmount = parseFloat(order.paid_amount) + amount;
    const newStatus = newPaidAmount >= fullTotal ? 'completed' : 'pending';
    
    await client.query(
      `UPDATE pre_orders SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newPaidAmount, newStatus, id]
    );
    
    await client.query(
      `INSERT INTO pre_order_payments (pre_order_id, amount, payment_method, received_by, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, amount, paymentMethod || 'cash', userId, notes || null]
    );
    
    const isFullyPaid = newPaidAmount >= fullTotal;
    const fullPaymentMethod = paymentMethod || 'cash';
    
    if (order.sale_id) {
      // Update existing sale — adjust amount_paid and payment_status only
      await client.query(
        `UPDATE sales SET amount_paid = $1, payment_status = $2, payment_method = $3,
         updated_at = NOW() WHERE id = $4`,
        [newPaidAmount, isFullyPaid ? 'paid' : 'partial', fullPaymentMethod, order.sale_id]
      );
    } else {
      // No sale yet (pre-order was created with 0 initial payment) — create one now
      const saleResult = await client.query(
        `INSERT INTO sales (shop_id, seller_id, total_amount, amount_paid, payment_method, payment_status, customer_name, customer_phone, notes, sale_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pre_order')
         RETURNING id`,
        [order.shop_id, userId, fullTotal, newPaidAmount, fullPaymentMethod,
         isFullyPaid ? 'paid' : 'partial',
         order.customer_name, order.customer_phone,
         notes ? `${notes} (Pre-order payment)` : 'Pre-order payment']
      );
      const saleId = saleResult.rows[0].id;
      
      // Link sale to pre_order
      await client.query(
        `UPDATE pre_orders SET sale_id = $1 WHERE id = $2`,
        [saleId, id]
      );
      
      // Insert sale_items for the full order
      let orderItemsData = [];
      try {
        orderItemsData = typeof order.items_data === 'string' ? JSON.parse(order.items_data) : (order.items_data || []);
      } catch { orderItemsData = []; }
      
      if (orderItemsData.length > 0) {
        for (const item of orderItemsData) {
          await client.query(
            `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, buying_price_at_sale, total_price, profit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [saleId, item.productId || null, item.productName, item.quantity, item.unitPrice, item.buyingPrice, item.total, item.profit]
          );
        }
      } else {
        let buyingPriceAtSale = 0;
        if (order.product_id) {
          const prodResult = await client.query('SELECT buying_price FROM products WHERE id = $1', [order.product_id]);
          if (prodResult.rows.length > 0) {
            buyingPriceAtSale = parseFloat(prodResult.rows[0].buying_price) || 0;
          }
        }
        const itemQty = parseFloat(order.quantity) || 1;
        const profit = fullTotal - (buyingPriceAtSale * itemQty);
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, buying_price_at_sale, total_price, profit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [saleId, order.product_id || null, order.product_name || 'Pre-order item', itemQty, fullTotal, buyingPriceAtSale, fullTotal, profit]
        );
      }
    }
    
    await client.query('COMMIT');
    
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
    
    const user = c.get('user') as any;
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'preorder_payment',
      entityType: 'preorder',
      entityId: id,
      shopId: order.shop_id,
      details: { amount, newPaidAmount, isFullyPaid }
    }).catch(() => {});
    
    return c.json({ success: true, message: 'Payment recorded successfully' });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    return c.json({ success: false, error: error.message }, 400);
  } finally {
    client.release();
  }
});

router.put('/:id/complete', authMiddleware, requirePermission('preorder:update'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    
    // Fetch the pre-order to get productId and quantity
    const orderResult = await pool.query('SELECT * FROM pre_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return c.json({ success: false, error: 'Pre-order not found' }, 404);
    }
    
    const order = orderResult.rows[0];
    
    await pool.query(
      `UPDATE pre_orders SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    
    const user = c.get('user') as any;
    const userId = c.get('userId');
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'preorder_completed',
      entityType: 'preorder',
      entityId: id,
      shopId: order.shop_id,
      details: { customerName: order.customer_name }
    }).catch(() => {});
    
    return c.json({ success: true, message: 'Order completed successfully' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.delete('/:id', authMiddleware, requirePermission('preorder:delete'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[];
    
    // Fetch pre-order items before deleting so we can restore stock
    const orderResult = await pool.query('SELECT * FROM pre_orders WHERE id = $1 AND shop_id = ANY($2)', [id, shopIds]);
    if (orderResult.rows.length === 0) {
      return c.json({ success: false, error: 'Pre-order not found' }, 404);
    }
    
    const order = orderResult.rows[0];
    let orderItemsData = [];
    try {
      orderItemsData = typeof order.items_data === 'string' ? JSON.parse(order.items_data) : (order.items_data || []);
    } catch { orderItemsData = []; }
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Restore stock for each item
      if (orderItemsData.length > 0) {
        for (const item of orderItemsData) {
          if (item.productId) {
            await client.query(
              `UPDATE products SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2`,
              [item.quantity, item.productId]
            );
          }
        }
      } else if (order.product_id) {
        const restoreQty = parseFloat(order.quantity) || 1;
        await client.query(
          `UPDATE products SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2`,
          [restoreQty, order.product_id]
        );
      }
      
      // Delete the pre-order (cascade will delete payments)
      await client.query('DELETE FROM pre_orders WHERE id = $1', [id]);
      
      await client.query('COMMIT');
      
      cache.invalidateByPrefix('products:');
      cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
      
      const user = c.get('user') as any;
      const userId = c.get('userId');
      logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'preorder_deleted',
        entityType: 'preorder',
        entityId: id,
        shopId: order.shop_id,
        details: { customerName: order.customer_name, productName: order.product_name }
      }).catch(() => {});
      
      return c.json({ success: true, message: 'Pre-order deleted, stock restored' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
