import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { logActivity } from '../../utils/activity-logger.js';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    shopIds: string[];
  }
}>();

// Test endpoint
router.get('/test', async (c) => {
  return c.json({ success: true, message: 'Stock take route working!' });
});

router.post('/save', authMiddleware, requirePermission('stock_take:create'), requireActiveSubscription, async (c) => {
  try {
    const userId = c.get('userId');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    const body = await c.req.json().catch(() => ({}));
    const { shopId, items, sessionName } = body;
    
    if (!shopId || !items || !Array.isArray(items)) {
      return c.json({ success: false, error: 'Shop ID and items are required' }, 400);
    }
    
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Access denied to this shop' }, 403);
    }
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      let sessionId = null;
      const existingSession = await client.query(
        `SELECT id FROM stock_take_sessions WHERE shop_id::text = $1 AND status = 'in_progress'`,
        [shopId]
      );
      
      if (existingSession.rows.length > 0) {
        sessionId = existingSession.rows[0].id;
      } else {
        const newSession = await client.query(
          `INSERT INTO stock_take_sessions (shop_id, name, started_by, notes, status)
           VALUES ($1, $2, $3, $4, 'in_progress')
           RETURNING id`,
          [shopId, sessionName || `Stock Take ${new Date().toLocaleDateString()}`, userId, null]
        );
        sessionId = newSession.rows[0].id;
        
        const products = await client.query(
          `SELECT id, current_stock FROM products WHERE shop_id::text = $1 AND is_active = true`,
          [shopId]
        );
        
        for (const product of products.rows) {
          await client.query(
            `INSERT INTO stock_take_items (session_id, product_id, system_quantity, physical_quantity, difference)
             VALUES ($1, $2, $3, $3, 0)`,
            [sessionId, product.id, product.current_stock]
          );
        }
      }
      
      for (const item of items) {
        const { productId, systemStock, physicalStock, difference } = item;
        
        await client.query(
          `UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id::text = $2`,
          [physicalStock, productId]
        );
        
        await client.query(
          `INSERT INTO stock_adjustments (product_id, shop_id, previous_quantity, new_quantity, difference, adjustment_type, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'stock_take', $6)`,
          [productId, shopId, systemStock, physicalStock, difference, userId]
        );
        
        await client.query(
          `INSERT INTO stock_take_items (session_id, product_id, system_quantity, physical_quantity, difference, counted_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (session_id, product_id) 
           DO UPDATE SET physical_quantity = $4, difference = $5, counted_at = NOW()`,
          [sessionId, productId, systemStock, physicalStock, difference]
        );
      }
      
      await client.query('COMMIT');
      return c.json({ success: true, sessionId, message: `Updated ${items.length} products` });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Stock take save error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

router.post('/start', authMiddleware, requirePermission('stock_take:create'), requireActiveSubscription, async (c) => {
  try {
    const userId = c.get('userId');
    const shopIds = c.get('shopIds') as string[] || [];
    const body = await c.req.json().catch(() => ({}));
    const { name, shopId, notes } = body;
    
    if (!name || !shopId) {
      return c.json({ success: false, error: 'Name and shop ID are required' }, 400);
    }
    
    // Check if user has access to this shop (allow if shopIds includes the shop OR if user is super_admin)
    const userRole = c.get('userRole');
    if (userRole !== 'developer' && shopIds.length > 0 && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Access denied to this shop' }, 403);
    }
    
    // Check if there's already an in-progress session for this shop
    const existingSession = await pool.query(
      `SELECT id FROM stock_take_sessions WHERE shop_id::text = $1 AND status = 'in_progress'`,
      [shopId]
    );
    
    if (existingSession.rows.length > 0) {
      return c.json({ success: false, error: 'There is already an active stock take session for this shop' }, 400);
    }
    
    // Create new session
    const result = await pool.query(
      `INSERT INTO stock_take_sessions (shop_id, name, started_by, notes, status)
       VALUES ($1, $2, $3, $4, 'in_progress')
       RETURNING *`,
      [shopId, name, userId, notes || null]
    );
    
    const session = result.rows[0];
    
    // Get all products for this shop and create initial items with system quantities
    const products = await pool.query(
      `SELECT id, current_stock FROM products WHERE shop_id::text = $1 AND is_active = true`,
      [shopId]
    );
    
    // Insert system quantities
    for (const product of products.rows) {
      await pool.query(
        `INSERT INTO stock_take_items (session_id, product_id, system_quantity, physical_quantity, difference)
         VALUES ($1, $2, $3, $3, 0)`,
        [session.id, product.id, product.current_stock]
      );
    }
    
    return c.json({
      success: true,
      data: { session, productsCount: products.rows.length }
    }, 201);
  } catch (error: any) {
    console.error('Start stock take error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get all stock take sessions
router.get('/', authMiddleware, requirePermission('stock_take:read'), async (c) => {
  try {
    const shopId = c.req.query('shopId');
    const status = c.req.query('status');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole') || 'seller';
    const userId = c.get('userId');
    
    console.log('[STOCK-TAKE-LIST] Request received. shopId:', shopId, 'userRole:', userRole, 'userId:', userId);
    
    let query = `
      SELECT s.*, 
             u.name as started_by_name,
             a.name as approved_by_name,
             sh.name as shop_name
      FROM stock_take_sessions s
      LEFT JOIN "user" u ON s.started_by::text = u.id::text
      LEFT JOIN "user" a ON s.approved_by::text = a.id::text
      LEFT JOIN shops sh ON s.shop_id::text = sh.id::text
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;
    
    if (shopId) {
      // Validate shopId format
      if (!/^[0-9a-f-]{36}$/i.test(shopId)) {
        console.log('[STOCK-TAKE-LIST] Invalid shopId format:', shopId);
        return c.json({ success: false, error: 'Invalid shop ID format' }, 400);
      }
      
      // Check if user has access to this shop
      if (userRole !== 'developer' && !shopIds.includes(shopId)) {
        console.log('[STOCK-TAKE-LIST] Access denied to shop:', shopId);
        return c.json({ success: false, error: 'Access denied to this shop' }, 403);
      }
      
      console.log('[STOCK-TAKE-LIST] Using shopId filter:', shopId);
      query += ` AND s.shop_id::text = $${paramIndex}`;
      params.push(shopId);
      paramIndex++;
    } else if (userRole !== 'developer') {
      if (shopIds.length > 0) {
        query += ` AND s.shop_id::text = ANY($${paramIndex})`;
        params.push(shopIds);
        paramIndex++;
      } else {
        console.log('[STOCK-TAKE-LIST] No shops for user, returning empty');
        return c.json({ success: true, data: [] });
      }
    }
    
    if (status) {
      query += ` AND s.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    query += ` ORDER BY s.created_at DESC`;
    
    console.log('[STOCK-TAKE-LIST] Executing query with params:', params);
    
    const result = await pool.query(query, params);
    console.log('[STOCK-TAKE-LIST] Success, rows:', result.rows.length);
    
    return c.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('[STOCK-TAKE-LIST] Error:', error.message, error.stack);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get stock take session details
router.get('/:id', authMiddleware, requirePermission('stock_take:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    // Get session
    const sessionResult = await pool.query(
      `SELECT s.*, u.name as started_by_name, a.name as approved_by_name, sh.name as shop_name
       FROM stock_take_sessions s
       LEFT JOIN "user" u ON s.started_by::text = u.id::text
       LEFT JOIN "user" a ON s.approved_by::text = a.id::text
       LEFT JOIN shops sh ON s.shop_id::text = sh.id::text
       WHERE s.id::text = $1`,
      [id]
    );
    
    if (sessionResult.rows.length === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    
    const session = sessionResult.rows[0];
    
    // Check access - super_admin can access all
    if (userRole !== 'developer' && !shopIds.includes(session.shop_id)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    // Get items
    const itemsResult = await pool.query(
      `SELECT si.*, p.name as product_name, p.sku, p.buying_price, p.selling_price, p.barcode
       FROM stock_take_items si
       JOIN products p ON si.product_id::text = p.id::text
       WHERE si.session_id::text = $1
       ORDER BY p.name`,
      [id]
    );
    
    // Calculate summary
    const summary = {
      totalProducts: itemsResult.rows.length,
      counted: itemsResult.rows.filter(i => i.physical_quantity !== null).length,
      pending: itemsResult.rows.filter(i => i.physical_quantity === null).length,
      withDifference: itemsResult.rows.filter(i => i.difference !== 0).length,
      totalShortage: itemsResult.rows.filter(i => i.difference < 0).reduce((sum, i) => sum + Math.abs(i.difference), 0),
      totalExcess: itemsResult.rows.filter(i => i.difference > 0).reduce((sum, i) => sum + i.difference, 0),
      shortageValue: itemsResult.rows.filter(i => i.difference < 0).reduce((sum, i) => sum + (Math.abs(i.difference) * parseFloat(i.buying_price || 0)), 0),
      excessValue: itemsResult.rows.filter(i => i.difference > 0).reduce((sum, i) => sum + (i.difference * parseFloat(i.buying_price || 0)), 0),
    };
    
    return c.json({
      success: true,
      data: { session, items: itemsResult.rows, summary }
    });
  } catch (error: any) {
    console.error('Get stock take error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Update item physical quantity
router.put('/items/:itemId', authMiddleware, requirePermission('stock_take:update'), requireActiveSubscription, async (c) => {
  try {
    const itemId = c.req.param('itemId');
    const { physicalQuantity, notes } = await c.req.json();
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    // Get item with session info
    const itemResult = await pool.query(
      `SELECT si.*, s.shop_id, s.status FROM stock_take_items si
       JOIN stock_take_sessions s ON si.session_id::text = s.id::text
       WHERE si.id::text = $1`,
      [itemId]
    );
    
    if (itemResult.rows.length === 0) {
      return c.json({ success: false, error: 'Item not found' }, 404);
    }
    
    const item = itemResult.rows[0];
    
    // Check access
    if (userRole !== 'developer' && !shopIds.includes(item.shop_id)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    // Check session status
    if (item.status !== 'in_progress') {
      return c.json({ success: false, error: 'Cannot update items in a completed session' }, 400);
    }
    
    // Calculate difference
    const difference = physicalQuantity - item.system_quantity;
    
    // Update item
    await pool.query(
      `UPDATE stock_take_items 
       SET physical_quantity = $1, difference = $2, notes = $3, counted_at = NOW()
       WHERE id = $4`,
      [physicalQuantity, difference, notes, itemId]
    );
    
    return c.json({ success: true, data: { difference } });
  } catch (error: any) {
    console.error('Update item error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Bulk update items (for barcode scanning or import)
router.post('/:id/items/bulk', authMiddleware, requirePermission('stock_take:update'), requireActiveSubscription, async (c) => {
  try {
    const sessionId = c.req.param('id');
    const { items } = await c.req.json(); // Array of { productId, physicalQuantity }
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    // Get session info
    const sessionResult = await pool.query(
      `SELECT s.* FROM stock_take_sessions s WHERE s.id::text = $1`,
      [sessionId]
    );
    
    if (sessionResult.rows.length === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    
    const session = sessionResult.rows[0];
    
    // Check access
    if (userRole !== 'developer' && !shopIds.includes(session.shop_id)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    // Check session status
    if (session.status !== 'in_progress') {
      return c.json({ success: false, error: 'Cannot update items in a completed session' }, 400);
    }
    
    // Update items
    let updatedCount = 0;
    for (const item of items) {
      const result = await pool.query(
        `UPDATE stock_take_items 
         SET physical_quantity = $1, difference = $1 - system_quantity, counted_at = NOW()
         WHERE session_id::text = $2 AND product_id::text = $3
         RETURNING id`,
        [item.physicalQuantity, sessionId, item.productId]
      );
      if (result.rows.length > 0) updatedCount++;
    }
    
    return c.json({ success: true, data: { updatedCount } });
  } catch (error: any) {
    console.error('Bulk update error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Complete stock take session
router.post('/:id/complete', authMiddleware, requirePermission('stock_take:complete'), requireActiveSubscription, async (c) => {
  try {
    const id = c.req.param('id');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    // Get session
    const sessionResult = await pool.query(
      `SELECT * FROM stock_take_sessions WHERE id = $1`,
      [id]
    );
    
    if (sessionResult.rows.length === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    
    const session = sessionResult.rows[0];
    
    // Check access
    if (userRole !== 'developer' && !shopIds.includes(session.shop_id)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    // Check status
    if (session.status !== 'in_progress') {
      return c.json({ success: false, error: 'Session is not in progress' }, 400);
    }
    
    // Check if all items are counted
    const pendingResult = await pool.query(
      `SELECT COUNT(*) as count FROM stock_take_items WHERE session_id::text = $1 AND physical_quantity IS NULL`,
      [id]
    );
    
    if (parseInt(pendingResult.rows[0].count) > 0) {
      return c.json({ 
        success: false, 
        error: `There are ${pendingResult.rows[0].count} products still pending counting` 
      }, 400);
    }
    
    // Update session status
    await pool.query(
      `UPDATE stock_take_sessions SET status = 'pending_approval', ended_at = NOW() WHERE id = $1`,
      [id]
    );
    
    const user = c.get('user') as any;
    const userId = c.get('userId');
    await logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'stock_take_completed',
      entityType: 'stock_take',
      entityId: id,
      shopId: session.shop_id,
      details: { sessionName: session.name }
    });
    
    return c.json({ success: true, message: 'Stock take completed and awaiting approval' });
  } catch (error: any) {
    console.error('Complete stock take error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Approve stock take and apply adjustments
router.post('/:id/approve', authMiddleware, requirePermission('stock_take:approve'), requireActiveSubscription, async (c) => {
  try {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    // Get session with items
    const sessionResult = await pool.query(
      `SELECT * FROM stock_take_sessions WHERE id = $1`,
      [id]
    );
    
    if (sessionResult.rows.length === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    
    const session = sessionResult.rows[0];
    
    // Check access
    if (userRole !== 'developer' && !shopIds.includes(session.shop_id)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    // Check status
    if (session.status !== 'pending_approval') {
      return c.json({ success: false, error: 'Session is not pending approval' }, 400);
    }
    
    // Get items with differences
    const itemsResult = await pool.query(
      `SELECT * FROM stock_take_items WHERE session_id::text = $1 AND difference != 0`,
      [id]
    );
    
    // Apply adjustments and create audit log
    for (const item of itemsResult.rows) {
      // Update product quantity
      await pool.query(
        `UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2`,
        [item.physical_quantity, item.product_id]
      );
      
      // Create adjustment history
        await pool.query(
          `INSERT INTO stock_adjustments 
           (product_id, shop_id, previous_quantity, new_quantity, difference, adjustment_type, reference_id, approved_by, created_by)
           VALUES ($1, $2, $3, $4, $5, 'stock_take', $6, $7, $8)`,
          [item.product_id, session.shop_id, item.system_quantity, item.physical_quantity, item.difference, id, userId, userId]
        );
    }
    
    // Update session status
    await pool.query(
      `UPDATE stock_take_sessions 
       SET status = 'approved', approved_by = $1, approved_at = NOW() 
       WHERE id = $2`,
      [userId, id]
    );
    
    const user = c.get('user') as any;
    await logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'stock_take_approved',
      entityType: 'stock_take',
      entityId: id,
      shopId: session.shop_id,
      details: { 
        sessionName: session.name,
        adjustmentsApplied: itemsResult.rows.length
      }
    });
    
    return c.json({ 
      success: true, 
      data: { 
        adjustmentsApplied: itemsResult.rows.length,
        totalShortage: itemsResult.rows.filter(i => i.difference < 0).reduce((sum, i) => sum + Math.abs(i.difference), 0),
        totalExcess: itemsResult.rows.filter(i => i.difference > 0).reduce((sum, i) => sum + i.difference, 0),
      }
    });
  } catch (error: any) {
    console.error('Approve stock take error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Reject stock take
router.post('/:id/reject', authMiddleware, requirePermission('stock_take:approve'), requireActiveSubscription, async (c) => {
  try {
    const id = c.req.param('id');
    const { reason } = await c.req.json();
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    // Get session
    const sessionResult = await pool.query(
      `SELECT * FROM stock_take_sessions WHERE id = $1`,
      [id]
    );
    
    if (sessionResult.rows.length === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    
    const session = sessionResult.rows[0];
    
    // Check access
    if (userRole !== 'developer' && !shopIds.includes(session.shop_id)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    // Check status
    if (session.status !== 'pending_approval') {
      return c.json({ success: false, error: 'Session is not pending approval' }, 400);
    }
    
    // Update session status to rejected
    await pool.query(
      `UPDATE stock_take_sessions 
       SET status = 'rejected', notes = COALESCE(notes || ', ', '') || $1
       WHERE id = $2`,
      [reason || 'Rejected by admin', id]
    );
    
    return c.json({ success: true, message: 'Stock take rejected' });
  } catch (error: any) {
    console.error('Reject stock take error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get adjustment history
router.get('/adjustments/history', authMiddleware, requirePermission('stock_take:read'), async (c) => {
  try {
    const shopId = c.req.query('shopId');
    const productId = c.req.query('productId');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    let query = `
      SELECT sa.*, p.name as product_name, p.sku, u.name as approved_by_name
      FROM stock_adjustments sa
      JOIN products p ON sa.product_id::text = p.id::text
      LEFT JOIN "user" u ON sa.approved_by::text = u.id::text
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;
    
    if (shopId) {
      query += ` AND sa.shop_id::text = $${paramIndex}`;
      params.push(shopId);
      paramIndex++;
    } else if (shopIds.length > 0 && userRole !== 'developer') {
      query += ` AND sa.shop_id::text = ANY($${paramIndex})`;
      params.push(shopIds);
      paramIndex++;
    }
    // super_admin gets all adjustments - no filter
    
    if (productId) {
      query += ` AND sa.product_id::text = $${paramIndex}`;
      params.push(productId);
      paramIndex++;
    }
    
    query += ` ORDER BY sa.created_at DESC LIMIT 100`;
    
    const result = await pool.query(query, params);
    
    return c.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Get adjustments error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Check if there's an active stock take for a shop
router.get('/active/:shopId', authMiddleware, async (c) => {
  try {
    const shopId = c.req.param('shopId');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    const result = await pool.query(
      `SELECT id, name, started_at FROM stock_take_sessions 
       WHERE shop_id::text = $1 AND status = 'in_progress'`,
      [shopId]
    );
    
    return c.json({ success: true, data: result.rows[0] || null });
  } catch (error: any) {
    console.error('Check active error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Export stock take session to CSV
router.get('/:id/export', authMiddleware, requirePermission('stock_take:read'), async (c) => {
  try {
    const id = c.req.param('id');
    const format = c.req.query('format') || 'csv';
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    const sessionResult = await pool.query(
      `SELECT s.*, u.name as started_by_name, sh.name as shop_name
       FROM stock_take_sessions s
       LEFT JOIN "user" u ON s.started_by::text = u.id::text
       LEFT JOIN shops sh ON s.shop_id::text = sh.id::text
       WHERE s.id::text = $1`,
      [id]
    );
    
    if (sessionResult.rows.length === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    
    const session = sessionResult.rows[0];
    
    if (userRole !== 'developer' && !shopIds.includes(session.shop_id)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    const itemsResult = await pool.query(
      `SELECT si.*, p.name as product_name, p.sku, p.barcode, p.buying_price, p.selling_price
       FROM stock_take_items si
       JOIN products p ON si.product_id::text = p.id::text
       WHERE si.session_id::text = $1
       ORDER BY p.name`,
      [id]
    );
    
    const items = itemsResult.rows;
    
    if (format === 'json') {
      return c.json({
        success: true,
        data: {
          session,
          items,
          summary: {
            totalProducts: items.length,
            counted: items.filter(i => i.physical_quantity !== null).length,
            withDifference: items.filter(i => i.difference !== 0).length,
            totalShortage: items.filter(i => i.difference < 0).reduce((sum, i) => sum + Math.abs(i.difference), 0),
            totalExcess: items.filter(i => i.difference > 0).reduce((sum, i) => sum + i.difference, 0),
          }
        }
      });
    }
    
    const headers = ['Product Name', 'SKU', 'Barcode', 'System Qty', 'Physical Qty', 'Difference', 'Unit Cost', 'Value Impact', 'Counted At', 'Notes'];
    const csvRows = [headers.join(',')];
    
    for (const item of items) {
      const valueImpact = item.difference * parseFloat(item.buying_price || 0);
      const row = [
        `"${(item.product_name || '').replace(/"/g, '""')}"`,
        `"${item.sku || ''}"`,
        `"${item.barcode || ''}"`,
        item.system_quantity,
        item.physical_quantity || '',
        item.difference,
        item.buying_price || 0,
        valueImpact.toFixed(2),
        item.counted_at ? new Date(item.counted_at).toLocaleString() : '',
        `"${(item.notes || '').replace(/"/g, '""')}"`
      ];
      csvRows.push(row.join(','));
    }
    
    const summary = {
      totalProducts: items.length,
      counted: items.filter(i => i.physical_quantity !== null).length,
      withDifference: items.filter(i => i.difference !== 0).length,
      totalShortage: items.filter(i => i.difference < 0).reduce((sum, i) => sum + Math.abs(i.difference), 0),
      totalExcess: items.filter(i => i.difference > 0).reduce((sum, i) => sum + i.difference, 0),
      shortageValue: items.filter(i => i.difference < 0).reduce((sum, i) => sum + (Math.abs(i.difference) * parseFloat(i.buying_price || 0)), 0),
      excessValue: items.filter(i => i.difference > 0).reduce((sum, i) => sum + (i.difference * parseFloat(i.buying_price || 0)), 0),
    };
    
    csvRows.push('');
    csvRows.push(`"SUMMARY"`);
    csvRows.push(`"Total Products",${summary.totalProducts}`);
    csvRows.push(`"Counted",${summary.counted}`);
    csvRows.push(`"With Difference",${summary.withDifference}`);
    csvRows.push(`"Total Shortage",${summary.totalShortage}`);
    csvRows.push(`"Total Excess",${summary.totalExcess}`);
    csvRows.push(`"Shortage Value",${summary.shortageValue.toFixed(2)}`);
    csvRows.push(`"Excess Value",${summary.excessValue.toFixed(2)}`);
    csvRows.push(`"Session Name","${session.name}"`);
    csvRows.push(`"Shop","${session.shop_name}"`);
    csvRows.push(`"Started By","${session.started_by_name}"`);
    csvRows.push(`"Started At",${new Date(session.started_at).toLocaleString()}`);
    csvRows.push(`"Status","${session.status}"`);
    
    const csv = csvRows.join('\n');
    
    const filename = `stock-take-${session.name.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().split('T')[0]}.csv`;
    
    return c.body(csv, 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
  } catch (error: any) {
    console.error('Export error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get last stock take for a shop
router.get('/last/:shopId', authMiddleware, async (c) => {
  try {
    const shopId = c.req.param('shopId');
    const shopIds = c.get('shopIds') as string[] || [];
    const userRole = c.get('userRole');
    
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    
    const result = await pool.query(
      `SELECT s.id, s.name, s.started_at, s.status, u.name as started_by_name, sh.name as shop_name,
              (SELECT COUNT(*)::int FROM stock_take_items WHERE session_id::text = s.id::text) as total_items,
              (SELECT COUNT(*)::int FROM stock_take_items WHERE session_id::text = s.id::text AND physical_quantity IS NOT NULL) as counted_items,
              (SELECT COUNT(*)::int FROM stock_take_items WHERE session_id::text = s.id::text AND difference != 0) as diff_items
       FROM stock_take_sessions s
       LEFT JOIN "user" u ON s.started_by::text = u.id::text
       LEFT JOIN shops sh ON s.shop_id::text = sh.id::text
       WHERE s.shop_id::text = $1 AND s.status IN ('completed', 'approved', 'pending_approval')
       ORDER BY s.started_at DESC
       LIMIT 1`,
      [shopId]
    );
    
    if (result.rows.length === 0) {
      return c.json({ success: true, data: null });
    }
    
    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Get last stock take error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
