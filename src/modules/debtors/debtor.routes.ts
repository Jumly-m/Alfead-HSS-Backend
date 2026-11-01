import { Hono } from 'hono';
import { db as readDb } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { cache } from '../../utils/cache.js';
import { logActivity } from '../../utils/activity-logger.js';

const router = new Hono();

router.get('/', authMiddleware, requirePermission('debtor:read'), async (c: any) => {
  try {
    const shopIds = c.get('shopIds') as string[];
    const shopId = c.req.query('shopId');
    const status = c.req.query('status');
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    
    let whereClause = shopId && shopIds?.includes(shopId) 
      ? 'WHERE d.shop_id = $1'
      : 'WHERE d.shop_id = ANY($1)';
    const params: any[] = shopId && shopIds?.includes(shopId) ? [shopId] : [shopIds];
    let paramIndex = 2;
    
    // Add status filter
    if (status && status !== 'all') {
      whereClause += ` AND d.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    // Add date filters
    if (startDate) {
      whereClause += ` AND d.created_at >= $${paramIndex}`;
      params.push(startDate + 'T00:00:00Z');
      paramIndex++;
    }
    
    if (endDate) {
      whereClause += ` AND d.created_at <= $${paramIndex}`;
      params.push(endDate + 'T23:59:59Z');
      paramIndex++;
    }
    
    const query = `
      SELECT d.*, s.name as shop_name,
        (SELECT COUNT(*) FROM debt_items WHERE debtor_id = d.id) as item_count,
        (SELECT STRING_AGG(di.product_name, ', ') FROM debt_items di WHERE di.debtor_id = d.id) as product_names,
        (SELECT MAX(dp.created_at) FROM debt_payments dp WHERE dp.debtor_id = d.id) as last_payment_at
      FROM debtors d 
      JOIN shops s ON d.shop_id = s.id 
      ${whereClause}
      ORDER BY d.created_at DESC
    `;
    
    const result = await readDb.read(query, params);
    
    const debtors = result.rows.map((row: any) => ({
      id: row.id,
      shopId: row.shop_id,
      shopName: row.shop_name,
      saleId: row.sale_id,
      name: row.customer_name || row.name,
      phone: row.customer_phone || row.phone,
      email: row.customer_email || row.email,
      totalAmount: parseFloat(row.total_amount || 0),
      paidAmount: parseFloat(row.paid_amount || 0),
      dueDate: row.due_date,
      status: row.status,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastPaymentAt: row.last_payment_at || null,
      itemCount: parseInt(row.item_count) || 0,
      productNames: row.product_names || null
    }));

    return c.json({ success: true, data: { debtors } });
  } catch (error: any) {
    console.error('Error fetching debtors:', error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/', authMiddleware, requirePermission('debtor:create'), requireActiveSubscription, async (c: any) => {
  try {
    const body = await c.req.json();
    const { shopId, saleId, name, phone, email, totalAmount, dueDate, notes } = body;
    
    const result = await pool.query(
      `INSERT INTO debtors (shop_id, sale_id, customer_name, customer_phone, customer_email, total_amount, due_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [shopId, saleId || null, name, phone, email || null, totalAmount, dueDate || null, notes || null]
    );
    
    const user = c.get('user') as any;
    const userId = c.get('userId');
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'debt_created',
      entityType: 'debtor',
      entityId: result.rows[0].id,
      shopId,
      details: { customerName: name, totalAmount, dueDate }
    }).catch(() => {});
    
    return c.json({ success: true, data: { debtor: result.rows[0] } }, 201);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/manual', authMiddleware, requirePermission('debtor:create'), requireActiveSubscription, async (c: any) => {
  try {
    const body = await c.req.json();
    const { shopId, name, phone, totalAmount, notes, items, date } = body;
    const userId = c.get('userId') as string;

    // Debt date (allow backdating) - defaults to today
    const debtDate = date ? new Date(date + 'T12:00:00Z') : null;

    // Compute total from items or provided amount
    let computedTotal = parseFloat(totalAmount) || 0;
    if (items && Array.isArray(items) && items.length > 0) {
      const itemSum = items.reduce((sum: number, it: any) => {
        const q = parseFloat(it.quantity) || 1;
        const up = parseFloat(it.unitPrice) || 0;
        const d = parseFloat(it.discount) || 0;
        return sum + Math.max(0, (q * up) - d);
      }, 0);
      if (itemSum > 0) computedTotal = itemSum;
    }

    await pool.query('BEGIN');

    try {
      // 1. Create sales record so it shows up in /sales and dashboard
      const saleResult = await pool.query(
        `INSERT INTO sales (shop_id, seller_id, total_amount, amount_paid, payment_method, customer_name, customer_phone, notes, sale_type, payment_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, NOW()))
         RETURNING *`,
        [shopId, userId, computedTotal, 0, 'debt', name, phone, notes || null, 'debt', 'unpaid', debtDate]
      );
      const saleId = saleResult.rows[0].id;

      // 2. Create debtor linked to the sale
      const debtorResult = await pool.query(
        `INSERT INTO debtors (shop_id, sale_id, customer_name, customer_phone, total_amount, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [shopId, saleId, name, phone, computedTotal, notes || null, 'unpaid']
      );
      const debtorId = debtorResult.rows[0].id;

      // 3. Create sale_items + debt_items and deduct stock
      if (items && Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          const qty = parseFloat(item.quantity) || 1;
          const unitPrice = parseFloat(item.unitPrice) || 0;
          const discount = parseFloat(item.discount) || 0;
          const buyingPrice = parseFloat(item.buyingPrice) || 0;
          const totalPrice = parseFloat(item.totalPrice || item.total) || Math.max(0, (qty * unitPrice) - discount);
          const profit = totalPrice - (buyingPrice * qty);

          // sale_items (only for items with product_id)
          if (item.productId) {
            await pool.query(
              `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, discount, buying_price_at_sale, total_price, profit)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [saleId, item.productId, item.productName || 'Item', qty, unitPrice, discount, buyingPrice, totalPrice, profit]
            );
            // Deduct stock
            await pool.query(
              'UPDATE products SET current_stock = current_stock - $1, updated_at = NOW() WHERE id = $2',
              [qty, item.productId]
            );
          }

          // debt_items (for detail view - always)
          await pool.query(
            `INSERT INTO debt_items (debtor_id, product_id, product_name, quantity, unit_price, discount, total_price, buying_price, date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [debtorId, item.productId || null, item.productName || 'Item', qty, unitPrice, discount, totalPrice, buyingPrice, debtDate ? debtDate.toISOString().slice(0, 10) : null]
          );
        }
      }

      await pool.query('COMMIT');

      // 4. Keep the customer registry (Wateja) in sync: when the person is not
      // saved yet, add them automatically so a debt always has a matching
      // customer. Existing customers (same phone or same name) are untouched.
      // Best-effort: a failure here must never undo a saved debt.
      try {
        const phoneDigits = String(phone || '').replace(/\D/g, '');
        const existingCustomer = await pool.query(
          `SELECT id FROM customers
           WHERE shop_id = $1
             AND (
               (LENGTH($2) >= 9 AND RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9) = RIGHT($2, 9))
               OR (COALESCE($3, '') <> '' AND LOWER(TRIM(name)) = LOWER(TRIM($3)))
             )
           LIMIT 1`,
          [shopId, phoneDigits, name]
        );
        if (existingCustomer.rows.length === 0) {
          await pool.query(
            `INSERT INTO customers (shop_id, name, phone, is_returned, return_count)
             VALUES ($1, $2, $3, FALSE, 0)`,
            [shopId, name, phone || '']
          );
        }
      } catch (customerErr: any) {
        console.error('[Manual Debt] Customer sync skipped:', customerErr.message);
      }

      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('stats:');
  cache.invalidateByPrefix('reports:');
      cache.invalidateByPrefix('debtors:');
      cache.invalidateByPrefix('products:shop');

      const user = c.get('user') as any;
      logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'debt_created',
        entityType: 'debtor',
        entityId: debtorId,
        shopId,
        details: { customerName: name, totalAmount: computedTotal, itemCount: items?.length || 0 }
      }).catch(() => {});

      return c.json({ success: true, data: { debtor: debtorResult.rows[0] } }, 201);
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Manual Debt] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/:id/payment', authMiddleware, requirePermission('debtor:create'), requireActiveSubscription, async (c: any) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json();
    const { amount, paymentMethod, notes, discount, date } = body;
    const userId = c.get('userId');
    
    console.log('[Debt Payment] Received id:', id, 'userId:', userId);
    
    // Validate ID format - better-auth uses text IDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    // Validate debtor ID format
    if (!uuidRegex.test(id)) {
      console.error('[Debt Payment] Invalid debtor ID format:', id);
      return c.json({ success: false, error: 'Invalid debtor ID format' }, 400);
    }
    
    // Validate userId exists (better-auth uses text IDs)
    if (!userId || typeof userId !== 'string') {
      console.error('[Debt Payment] Invalid userId:', userId);
      return c.json({ success: false, error: 'Invalid user session. Please login again.' }, 400);
    }
    
    const debtorResult = await pool.query('SELECT * FROM debtors WHERE id = $1', [id]);
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    
    const debtor = debtorResult.rows[0];
    const totalDebt = parseFloat(debtor.total_amount || 0);
    const currentPaid = parseFloat(debtor.paid_amount || 0);
    const effectiveDiscount = Math.max(0, parseFloat(discount || 0));
    // The discount forgives part of the debt: cash received + forgiven amount
    // both clear the balance. Never credits more than what's still owed.
    const credited = Math.min(Math.max(0, totalDebt - currentPaid), Math.max(0, parseFloat(amount) || 0) + effectiveDiscount);
    const newPaidAmount = currentPaid + credited;
    const actualPaid = credited;
    const isPaidOff = newPaidAmount >= totalDebt - 0.01;
    const newStatus = isPaidOff ? 'paid' : (newPaidAmount > 0 ? 'partial' : 'unpaid');
    
    await pool.query(
      `UPDATE debtors SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newPaidAmount, newStatus, id]
    );
    
    await pool.query(
      `INSERT INTO debt_payments (debtor_id, amount, payment_method, discount, date, notes, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, amount, paymentMethod || 'cash', effectiveDiscount, date || null, notes || null, userId]
    );

    // Spread this payment over the debt's products (oldest first) so each item
    // shows how much is settled and how much is still owed. Without this a
    // half-paid debt kept showing every product as fully unpaid, and the debt
    // looked settled only at the header level.
    if (credited > 0) {
      await pool.query(
        `WITH ordered AS (
           SELECT di.id,
                  GREATEST(COALESCE(di.total_price, 0) - COALESCE(di.paid_amount, 0), 0) AS item_remaining,
                  COALESCE(SUM(GREATEST(COALESCE(di.total_price, 0) - COALESCE(di.paid_amount, 0), 0)) OVER (
                    PARTITION BY di.debtor_id
                    ORDER BY di.created_at ASC, di.id ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                  ), 0) AS before_remaining
           FROM debt_items di
           WHERE di.debtor_id = $1
         )
         UPDATE debt_items di
         SET paid_amount = COALESCE(di.paid_amount, 0) + LEAST(o.item_remaining, GREATEST(0, $2::numeric - o.before_remaining))
         FROM ordered o
         WHERE di.id = o.id
           AND LEAST(o.item_remaining, GREATEST(0, $2::numeric - o.before_remaining)) > 0`,
        [id, credited]
      );
    }

    // Update the existing sale record instead of creating a duplicate
    const saleId = debtor.sale_id;
    if (saleId) {
      await pool.query(
        `UPDATE sales SET payment_status = $1, amount_paid = $2, updated_at = NOW() WHERE id = $3`,
        [newStatus, newPaidAmount, saleId]
      );
    }
    
    cache.invalidateByPrefix('sale:');
    cache.invalidateByPrefix('stats:');
  cache.invalidateByPrefix('reports:');
    cache.invalidateByPrefix('products:shop');
    
    const user = c.get('user') as any;
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'debt_payment',
      entityType: 'debtor',
      entityId: id,
      shopId: debtor.shop_id,
      details: { amount, discount: effectiveDiscount, netAmount: actualPaid, newPaidAmount, isPaidOff, customerName: debtor.customer_name }
    }).catch(() => {
      // swallow error
    });
    
    return c.json({ success: true, message: 'Payment recorded successfully' });
  } catch (error: any) {
    console.error('[Debt Payment] Error:', error.message, 'ID was:', id);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/:id/send-reminder', authMiddleware, requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    
    const debtorResult = await pool.query('SELECT * FROM debtors WHERE id = $1', [id]);
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    
    const debtor = debtorResult.rows[0];
    const remaining = parseFloat(debtor.total_amount || 0) - parseFloat(debtor.paid_amount || 0);
    
    console.log(`SMS Reminder would be sent to ${debtor.phone}: Please pay your debt of TZS ${remaining}`);
    
    return c.json({ success: true, message: 'Reminder sent successfully' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.get('/:id/items', authMiddleware, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[];
    
    const debtorResult = await pool.query(
      'SELECT id FROM debtors WHERE id = $1 AND shop_id = ANY($2)',
      [id, shopIds]
    );
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    
    const result = await pool.query(
      `SELECT di.*, p.name as product_system_name, p.selling_price as product_selling_price
       FROM debt_items di
       LEFT JOIN products p ON di.product_id = p.id
       WHERE di.debtor_id = $1
       ORDER BY di.created_at DESC`,
      [id]
    );
    
    const items = result.rows.map((row: any) => {
      const qty = parseFloat(row.quantity);
      const unitPrice = parseFloat(row.unit_price);
      const discount = parseFloat(row.discount || 0);
      const totalPrice = parseFloat(row.total_price) || Math.max(0, (qty * unitPrice) - discount);
      const buyingPrice = parseFloat(row.buying_price) || 0;
      const paidAmount = parseFloat(row.paid_amount || 0);
      const profit = totalPrice - (buyingPrice * qty);
      return {
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        productSystemName: row.product_system_name,
        quantity: qty,
        unitPrice,
        discount,
        totalPrice,
        paidAmount,
        balance: Math.max(0, totalPrice - paidAmount),
        buyingPrice,
        profit,
        date: row.date,
        createdAt: row.created_at,
      };
    });
    
    return c.json({ success: true, data: { items } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/:id/items', authMiddleware, requirePermission('debtor:create'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[];
    const body = await c.req.json();
    const { items, notes, date } = body;
    const userId = c.get('userId') as string;

    // Allow backdating new items (defaults to today)
    const itemDate = date ? new Date(date + 'T12:00:00Z') : null;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: 'No items provided' }, 400);
    }

    const debtorResult = await pool.query(
      'SELECT * FROM debtors WHERE id = $1 AND shop_id = ANY($2)',
      [id, shopIds]
    );
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    const debtor = debtorResult.rows[0];

    await pool.query('BEGIN');
    try {
      let addedTotal = 0;
      for (const item of items) {
        const qty = parseFloat(item.quantity) || 1;
        const unitPrice = parseFloat(item.unitPrice) || 0;
        const discount = parseFloat(item.discount) || 0;
        const buyingPrice = parseFloat(item.buyingPrice) || 0;
        const totalPrice = parseFloat(item.totalPrice || item.total) || Math.max(0, (qty * unitPrice) - discount);
        const productId = item.productId || null;
        addedTotal += totalPrice;

        // Merge into the existing line for the same product instead of stacking
        // duplicate rows: a customer who comes back for 4 more ceramics should
        // see one line with the combined quantity (2 + 4 = 6) and a bigger debt.
        // Quantities, totals, discounts and paid amounts are summed; prices are
        // blended so the line total stays exact.
        const existingResult = productId
          ? await pool.query(
              `SELECT * FROM debt_items
               WHERE debtor_id = $1 AND product_id = $2
               ORDER BY created_at ASC, id ASC
               FOR UPDATE`,
              [id, productId]
            )
          : await pool.query(
              `SELECT * FROM debt_items
               WHERE debtor_id = $1 AND product_id IS NULL AND product_name = $2 AND unit_price = $3
               ORDER BY created_at ASC, id ASC
               FOR UPDATE`,
              [id, item.productName || 'Item', unitPrice]
            );

        const existingRows = existingResult.rows as any[];
        if (existingRows.length > 0) {
          const primary = existingRows[0];
          const mergedQty = existingRows.reduce((s, r) => s + (parseFloat(r.quantity) || 0), 0) + qty;
          const mergedDiscount = existingRows.reduce((s, r) => s + (parseFloat(r.discount) || 0), 0) + discount;
          const mergedTotal = existingRows.reduce((s, r) => s + (parseFloat(r.total_price) || 0), 0) + totalPrice;
          const mergedPaid = existingRows.reduce((s, r) => s + (parseFloat(r.paid_amount) || 0), 0);
          const mergedBuying = existingRows.reduce((s, r) => s + ((parseFloat(r.buying_price) || 0) * (parseFloat(r.quantity) || 0)), 0) + (buyingPrice * qty);
          const mergedUnitPrice = mergedQty > 0 ? mergedTotal / mergedQty : unitPrice;
          const mergedBuyingUnit = mergedQty > 0 ? mergedBuying / mergedQty : buyingPrice;

          await pool.query(
            `UPDATE debt_items
             SET quantity = $1, unit_price = $2, discount = $3, total_price = $4, paid_amount = $5, buying_price = $6
             WHERE id = $7`,
            [mergedQty, mergedUnitPrice, mergedDiscount, mergedTotal, mergedPaid, mergedBuyingUnit, primary.id]
          );

          // Fold legacy duplicate rows for the same product into the kept row.
          const extraIds = existingRows.slice(1).map((r: any) => r.id);
          if (extraIds.length > 0) {
            await pool.query('DELETE FROM debt_items WHERE id = ANY($1)', [extraIds]);
          }
        } else {
          await pool.query(
            `INSERT INTO debt_items (debtor_id, product_id, product_name, quantity, unit_price, discount, total_price, buying_price, date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, productId, item.productName || 'Item', qty, unitPrice, discount, totalPrice, buyingPrice, itemDate ? itemDate.toISOString().slice(0, 10) : null]
          );
        }

        if (productId) {
          await pool.query(
            'UPDATE products SET current_stock = current_stock - $1, updated_at = NOW() WHERE id = $2',
            [qty, productId]
          );

          // Keep the linked sale's line items in sync with the debt ledger so
          // the sale detail shows the same combined quantity.
          if (debtor.sale_id) {
            const saleItemResult = await pool.query(
              `SELECT * FROM sale_items
               WHERE sale_id = $1 AND product_id = $2
               ORDER BY id ASC
               FOR UPDATE`,
              [debtor.sale_id, productId]
            );
            const saleRows = saleItemResult.rows as any[];
            if (saleRows.length > 0) {
              const primarySale = saleRows[0];
              const sQty = saleRows.reduce((s, r) => s + (parseFloat(r.quantity) || 0), 0) + qty;
              const sDiscount = saleRows.reduce((s, r) => s + (parseFloat(r.discount) || 0), 0) + discount;
              const sTotal = saleRows.reduce((s, r) => s + (parseFloat(r.total_price) || 0), 0) + totalPrice;
              const sBuying = saleRows.reduce((s, r) => s + ((parseFloat(r.buying_price_at_sale) || 0) * (parseFloat(r.quantity) || 0)), 0) + (buyingPrice * qty);
              const sUnit = sQty > 0 ? sTotal / sQty : unitPrice;
              const sBuyingUnit = sQty > 0 ? sBuying / sQty : buyingPrice;
              await pool.query(
                `UPDATE sale_items
                 SET quantity = $1, unit_price = $2, discount = $3, total_price = $4, buying_price_at_sale = $5, profit = $6
                 WHERE id = $7`,
                [sQty, sUnit, sDiscount, sTotal, sBuyingUnit, sTotal - (sBuyingUnit * sQty), primarySale.id]
              );
              const extraSaleIds = saleRows.slice(1).map((r: any) => r.id);
              if (extraSaleIds.length > 0) {
                await pool.query('DELETE FROM sale_items WHERE id = ANY($1)', [extraSaleIds]);
              }
            } else {
              await pool.query(
                `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, discount, buying_price_at_sale, total_price, profit)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [debtor.sale_id, productId, item.productName || 'Item', qty, unitPrice, discount, buyingPrice, totalPrice, totalPrice - (buyingPrice * qty)]
              );
            }
          }
        }
      }

      const newTotal = (parseFloat(debtor.total_amount) || 0) + addedTotal;
      const currentPaid = parseFloat(debtor.paid_amount) || 0;
      const newStatus = currentPaid >= newTotal - 0.01 ? 'paid' : (currentPaid > 0 ? 'partial' : 'unpaid');
      await pool.query(
        `UPDATE debtors SET total_amount = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newTotal, newStatus, id]
      );

      // The debt sale must grow by the same amount so the sales ledger stays
      // consistent with the debt ledger.
      if (debtor.sale_id) {
        await pool.query(
          `UPDATE sales
           SET total_amount = total_amount + $1, payment_status = $2, updated_at = NOW()
           WHERE id = $3`,
          [addedTotal, newStatus, debtor.sale_id]
        );
      }

      await pool.query('COMMIT');

      cache.invalidateByPrefix('debtors:');
      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('stats:');
  cache.invalidateByPrefix('reports:');
      cache.invalidateByPrefix('products:shop');

      logActivity({
        userId,
        userName: 'System',
        userEmail: '',
        action: 'debt_items_added',
        entityType: 'debtor',
        entityId: id,
        shopId: debtor.shop_id,
        details: { itemCount: items.length, addedTotal, customerName: debtor.customer_name }
      }).catch(() => {});

      return c.json({ success: true, data: { addedTotal, itemCount: items.length } }, 201);
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Add Debt Items] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.delete('/:id/items/:itemId', authMiddleware, requirePermission('debtor:delete'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const itemId = c.req.param('itemId');
    const shopIds = c.get('shopIds') as string[];
    // Deleting a fully paid record is only allowed as a deliberate correction
    // (wrong customer / wrong amount) via ?force=true, so paid records cannot
    // be wiped accidentally.
    const force = c.req.query('force') === 'true';

    const debtorResult = await pool.query(
      'SELECT * FROM debtors WHERE id = $1 AND shop_id = ANY($2)',
      [id, shopIds]
    );
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    const debtor = debtorResult.rows[0];

    const itemResult = await pool.query('SELECT * FROM debt_items WHERE id = $1 AND debtor_id = $2', [itemId, id]);
    if (itemResult.rows.length === 0) {
      return c.json({ success: false, error: 'Item not found' }, 404);
    }
    const item = itemResult.rows[0];

    const guardTotal = parseFloat(item.total_price) || 0;
    const guardPaid = parseFloat(item.paid_amount) || 0;
    if (guardTotal > 0 && guardPaid >= guardTotal - 0.01 && !force) {
      return c.json({
        success: false,
        code: 'PAID_ITEM',
        error: 'Bidhaa hii imelipwa kikamilifu. Rekodi zilizolipwa hazifutwi kwa bahati mbaya — futa kwenye sehemu ya Zimelipwa ukiwa na uhakika.'
      }, 409);
    }

    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM debt_items WHERE id = $1 AND debtor_id = $2', [itemId, id]);

      const itemTotal = parseFloat(item.total_price) || 0;
      const itemPaid = parseFloat(item.paid_amount) || 0;
      const newTotal = Math.max(0, (parseFloat(debtor.total_amount) || 0) - itemTotal);
      const newPaid = Math.max(0, (parseFloat(debtor.paid_amount) || 0) - itemPaid);

      await pool.query(
        `UPDATE debtors SET total_amount = $1, paid_amount = $2,
           status = CASE WHEN $2 >= $1 - 0.01 THEN 'paid' WHEN $2 > 0 THEN 'partial' ELSE 'unpaid' END,
           updated_at = NOW()
         WHERE id = $3`,
        [newTotal, newPaid, id]
      );

      if (item.product_id) {
        const isFullyPaid = guardTotal > 0 && guardPaid >= guardTotal - 0.01;
        if (!isFullyPaid) {
          // Not fully settled: the goods come back, so the linked sale line is
          // removed and the stock returns to the shop.
          if (debtor.sale_id) {
            await pool.query(
              `DELETE FROM sale_items WHERE sale_id = $1 AND product_id = $2 AND product_name = $3`,
              [debtor.sale_id, item.product_id, item.product_name]
            );
          }
          await pool.query('UPDATE products SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2', [parseFloat(item.quantity) || 1, item.product_id]);
        }
        // Fully paid lines: the customer took the goods and paid for them, so
        // deleting the debt line is only a ledger correction — the stock must
        // NOT be returned and the sale line is kept so the inventory movement
        // still matches the sales records.
      }

      await pool.query('COMMIT');

      cache.invalidateByPrefix('debtors:');
      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('stats:');
  cache.invalidateByPrefix('reports:');
      cache.invalidateByPrefix('products:shop');

      return c.json({ success: true, message: 'Item deleted successfully' });
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Delete Debt Item] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.post('/:id/items/:itemId/pay', authMiddleware, requirePermission('debtor:create'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const itemId = c.req.param('itemId');
    const shopIds = c.get('shopIds') as string[];
    const body = await c.req.json();
    const { amount, paymentMethod, notes, discount, date } = body;
    const userId = c.get('userId');

    const debtorResult = await pool.query(
      'SELECT * FROM debtors WHERE id = $1 AND shop_id = ANY($2)',
      [id, shopIds]
    );
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    const debtor = debtorResult.rows[0];

    const itemResult = await pool.query('SELECT * FROM debt_items WHERE id = $1 AND debtor_id = $2', [itemId, id]);
    if (itemResult.rows.length === 0) {
      return c.json({ success: false, error: 'Item not found' }, 404);
    }
    const item = itemResult.rows[0];

    const itemTotal = parseFloat(item.total_price) || 0;
    const itemPaid = parseFloat(item.paid_amount) || 0;
    const effectiveDiscount = Math.max(0, parseFloat(discount || 0));
    // Cash received + forgiven discount both settle this product's balance,
    // capped at what's still owed on the item.
    const credited = Math.min(Math.max(0, itemTotal - itemPaid), Math.max(0, parseFloat(amount) || 0) + effectiveDiscount);
    const newItemPaid = itemPaid + credited;

    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE debt_items SET paid_amount = $1 WHERE id = $2`,
        [newItemPaid, itemId]
      );

      await pool.query(
        `INSERT INTO debt_payments (debtor_id, item_id, amount, payment_method, discount, date, notes, received_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, itemId, amount, paymentMethod || 'cash', effectiveDiscount, date || null, notes || null, userId]
      );

      const totalDebt = parseFloat(debtor.total_amount) || 0;
      const currentPaid = parseFloat(debtor.paid_amount) || 0;
      const newPaidAmount = Math.min(Math.max(0, totalDebt), currentPaid + credited);
      const isPaidOff = newPaidAmount >= totalDebt - 0.01;
      const newStatus = isPaidOff ? 'paid' : (newPaidAmount > 0 ? 'partial' : 'unpaid');

      await pool.query(
        `UPDATE debtors SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newPaidAmount, newStatus, id]
      );

      if (debtor.sale_id) {
        await pool.query(
          `UPDATE sales SET payment_status = $1, amount_paid = $2, updated_at = NOW() WHERE id = $3`,
          [newStatus, newPaidAmount, debtor.sale_id]
        );
      }

      await pool.query('COMMIT');

      cache.invalidateByPrefix('debtors:');
      cache.invalidateByPrefix('sale:');
      cache.invalidateByPrefix('stats:');
  cache.invalidateByPrefix('reports:');
      cache.invalidateByPrefix('products:shop');

      const user = c.get('user') as any;
      logActivity({
        userId,
        userName: user?.name || user?.email || 'Unknown',
        userEmail: user?.email || '',
        action: 'debt_item_payment',
        entityType: 'debtor',
        entityId: id,
        shopId: debtor.shop_id,
        details: { itemId, amount: parseFloat(amount) || 0, discount: effectiveDiscount, credited, itemName: item.product_name, customerName: debtor.customer_name }
      }).catch(() => {});

      return c.json({ success: true, message: 'Item payment recorded successfully' });
    } catch (innerError: any) {
      await pool.query('ROLLBACK');
      throw innerError;
    }
  } catch (error: any) {
    console.error('[Item Payment] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.delete('/:id', authMiddleware, requirePermission('debtor:delete'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[];
    // Fully paid debts are kept as records; deleting one is only allowed as a
    // deliberate correction via ?force=true (paid to the wrong customer).
    const force = c.req.query('force') === 'true';

    const debtorResult = await pool.query(
      'SELECT * FROM debtors WHERE id = $1 AND shop_id = ANY($2)',
      [id, shopIds]
    );
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    const debtor = debtorResult.rows[0];
    const guardTotal = parseFloat(debtor.total_amount) || 0;
    const guardPaid = parseFloat(debtor.paid_amount) || 0;
    if (guardTotal > 0 && guardPaid >= guardTotal - 0.01 && !force) {
      return c.json({
        success: false,
        code: 'PAID_DEBT',
        error: 'Deni hili limelipwa kikamilifu. Rekodi zilizolipwa hazifutwi kwa bahati mbaya — futa kwenye kichupo cha Zimelipwa ukiwa na uhakika.'
      }, 409);
    }

    await pool.query('DELETE FROM debtors WHERE id = $1 AND shop_id = ANY($2)', [id, shopIds]);

    
    const user = c.get('user') as any;
    const userId = c.get('userId');
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'debt_deleted',
      entityType: 'debtor',
      entityId: id,
      shopId: shopIds?.[0],
      details: { deletedDebtorId: id }
    }).catch(() => {});
    
    return c.json({ success: true, message: 'Debtor record deleted' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.get('/:id/payments', authMiddleware, async (c: any) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[];
    
    // Verify debtor belongs to user's shops
    const debtorResult = await pool.query(
      'SELECT id FROM debtors WHERE id = $1 AND shop_id = ANY($2)',
      [id, shopIds]
    );
    
    if (debtorResult.rows.length === 0) {
      return c.json({ success: false, error: 'Debtor not found' }, 404);
    }
    
    const paymentsResult = await pool.query(
      `SELECT dp.*,
              COALESCE(NULLIF(u.name, ''), NULLIF(TRIM(u.first_name || ' ' || COALESCE(u.last_name, '')), ''), u.email) as received_by_name
       FROM debt_payments dp
       LEFT JOIN "user" u ON dp.received_by = u.id
       WHERE dp.debtor_id = $1
       ORDER BY dp.created_at DESC`,
      [id]
    );
    
    const payments = paymentsResult.rows.map((row: any) => ({
      id: row.id,
      itemId: row.item_id || null,
      amount: parseFloat(row.amount),
      discount: parseFloat(row.discount || 0),
      paymentMethod: row.payment_method,
      notes: row.notes,
      date: row.date,
      receivedBy: row.received_by_name || 'Unknown',
      createdAt: row.created_at
    }));
    
    return c.json({ success: true, data: { payments } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
