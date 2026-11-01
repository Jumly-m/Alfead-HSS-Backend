// =====================================================
// STORE / BACK OFFICE (GHALA) MODULE
// =====================================================
// A store (shops.type='store') is the warehouse that receives goods from
// suppliers and issues them to the tenant's shops. The full flow:
//
//   supplier -> store (receive) -> shop request -> store issues
//     -> stock enters the destination shop automatically at issue time
//     -> shop confirms receipt (record only) -> selling continues
//
// Everything is recorded: receipts, stock movements, requests, issued lines.
// Permissions:
//   store:read     - view the store, its stock, requests and reports
//   store:manage   - receive stock / issue / reject (store staff + owners)
//   store:request  - a shop (seller) may request goods from the store
// =====================================================

import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { db as readDb } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission, requireAnyPermission } from '../../middleware/rbac.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { cache } from '../../utils/cache.js';
import { logActivity } from '../../utils/activity-logger.js';
import { sendEmail } from '../../services/email.service.js';

const router = new Hono();

// products.sku is NOT NULL with a unique (shop_id, sku) index, so every
// product the store creates needs a SKU. Timestamp+random (same pattern as
// bulk import) stays unique across multiple new lines in one receipt.
function generateProductSku(): string {
  return `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// Multi-word product search: every word must appear in the name, barcode or
// SKU, so typing a partial name (or "pampas 100") always finds the product.
// Used by the store stock list and the shop catalog picker.
function buildProductSearchFilter(params: any[], search: string): string {
  const words = search.split(/\s+/).map((w) => w.trim()).filter(Boolean).slice(0, 5);
  const clauses: string[] = [];
  for (const word of words) {
    params.push(`%${word}%`);
    const i = params.length;
    clauses.push(`(name ILIKE $${i} OR COALESCE(barcode,'') ILIKE $${i} OR COALESCE(sku,'') ILIKE $${i})`);
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

const fmtMoney = (n: any) => `TSh ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n) || 0)}`;

// The store the caller is allowed to act on: must be a store of their tenant
// (or one of their memberships). Returns null when out of reach.
async function getStore(c: any, storeId: string) {
  if (!storeId) return null;
  const userRole = c.get('userRole') as string;
  const shopIds = (c.get('shopIds') as string[]) || [];
  const tenantId = c.get('tenantId') as string;
  const res = await readDb.read(`SELECT * FROM shops WHERE id = $1 AND type = 'store'`, [storeId]);
  if (res.rows.length === 0) return null;
  const store = res.rows[0];
  if (userRole === 'developer') return store;
  const isMember = shopIds.includes(storeId);
  const sameTenant = tenantId && store.tenant_id && String(store.tenant_id) === String(tenantId);
  if (!isMember && !sameTenant) return null;
  return store;
}

// People who should hear about store activity: the store/their shop team plus
// the tenant's owners/admins. Deduplicated by user id.
async function getRecipients(shopId: string, tenantId: string | null) {
  const result = await readDb.read(
    `SELECT DISTINCT u.id, u.email, u.name
       FROM "user" u
      WHERE u.id IN (SELECT user_id FROM user_shops WHERE shop_id = $1)
         OR ($2::text IS NOT NULL AND u.tenant_id = $2::text AND u.role IN ('admin', 'owner'))`,
    [shopId, tenantId]
  );
  return result.rows as { id: string; email: string; name: string }[];
}

async function notifyUsers(recipients: { id: string; email: string; name: string }[], opts: {
  tenantId: string | null;
  title: string;
  message: string;
  actionUrl: string;
  emailSubject: string;
  emailHtml: string;
  createdBy?: string | null;
}) {
  const seen = new Set<string>();
  for (const r of recipients) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    try {
      await pool.query(
        `INSERT INTO notifications (tenant_id, user_id, title, message, type, action_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [opts.tenantId, r.id, opts.title, opts.message, 'store', opts.actionUrl, opts.createdBy || null]
      );
    } catch (e: any) {
      console.error('[Store] notification insert failed:', e.message);
    }
    if (r.email) {
      sendEmail({ to: r.email, subject: opts.emailSubject, html: opts.emailHtml, name: r.name || undefined, templateKey: 'store_notification' })
        .catch((e: any) => console.error('[Store] email failed:', e.message));
    }
  }
}

function emailShell(title: string, rows: string, footer: string) {
  return `
  <div style="font-family:Arial,sans-serif;background:#f4f7f5;padding:20px">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:linear-gradient(120deg,#064e3b,#0d9488);padding:18px 22px">
        <h2 style="color:#fff;margin:0;font-size:17px">${title}</h2>
      </div>
      <div style="padding:18px 22px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>
        <p style="color:#64748b;font-size:12px;margin-top:18px">${footer}</p>
      </div>
      <div style="background:#f8fafc;padding:10px 22px;color:#94a3b8;font-size:11px">ALFEAN ENTERPRISES — Store / Ghala</div>
    </div>
  </div>`;
}

// Adds issued quantities straight into the destination shop's stock ("auto
// receive"). Products are matched to the shop's catalog by barcode first, then
// by name; a product the shop does not carry yet is created from the store
// line so it is sellable at once. Must run inside the caller's transaction.
// Returns the number of lines applied.
async function applyIssuedStockToShop(request: any, items: any[], userId: string, label = 'Store receipt') {
  let appliedLines = 0;

  for (const item of items) {
    const qty = parseFloat(item.issued_qty) || 0;
    if (qty <= 0) continue;

    let shopProduct: any = null;
    if (item.barcode) {
      const byBarcode = await pool.query(
        `SELECT * FROM products WHERE shop_id = $1 AND barcode = $2 AND is_active = true ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [request.shop_id, item.barcode]
      );
      if (byBarcode.rows.length > 0) shopProduct = byBarcode.rows[0];
    }
    if (!shopProduct) {
      const byName = await pool.query(
        `SELECT * FROM products WHERE shop_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [request.shop_id, item.product_name]
      );
      if (byName.rows.length > 0) shopProduct = byName.rows[0];
    }

    const unitCost = parseFloat(item.unit_cost) || 0;

    if (shopProduct) {
      const prev = parseFloat(shopProduct.current_stock) || 0;
      const next = prev + qty;
      await pool.query(
        `UPDATE products SET current_stock = $1,
           expiry_date = CASE
             WHEN $3::date IS NULL THEN expiry_date
             WHEN expiry_date IS NULL OR expiry_date::date < CURRENT_DATE THEN $3::date
             WHEN $3::date < expiry_date::date THEN $3::date
             ELSE expiry_date END,
           updated_at = NOW()
         WHERE id = $2`,
        [next, shopProduct.id, item.expiry_date || null]
      );
      // stock_adjustments uses integer columns — log the rounded movement and
      // keep the exact quantity in the note.
      await pool.query(
        `INSERT INTO stock_adjustments (product_id, shop_id, previous_quantity, new_quantity, difference, adjustment_type, reference_id, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, 'store_receipt', $6, $7, $8)`,
        [shopProduct.id, request.shop_id, Math.round(prev), Math.round(next), Math.round(qty), request.id, `${label} ${request.request_number} (auto +${qty})`, userId]
      );
    } else {
      // The shop doesn't carry this product yet — create it from the store
      // line so it is immediately sellable.
      let sellingPrice = unitCost;
      if (item.product_id) {
        const storeProduct = await pool.query(`SELECT selling_price FROM products WHERE id = $1`, [item.product_id]);
        const sp = parseFloat(storeProduct.rows[0]?.selling_price) || 0;
        if (sp > 0) sellingPrice = sp;
      }
      const created = await pool.query(
        `INSERT INTO products (shop_id, name, sku, barcode, unit_type, buying_price, selling_price, current_stock, low_stock_threshold, expiry_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10) RETURNING id`,
        [request.shop_id, item.product_name, generateProductSku(), item.barcode || null, item.unit_type || 'PCS', unitCost, sellingPrice, qty, item.expiry_date || null, userId]
      );
      await pool.query(
        `INSERT INTO stock_adjustments (product_id, shop_id, previous_quantity, new_quantity, difference, adjustment_type, reference_id, notes, created_by)
         VALUES ($1, $2, 0, $3, $3, 'store_receipt', $4, $5, $6)`,
        [created.rows[0].id, request.shop_id, Math.round(qty), request.id, `${label} ${request.request_number} (auto +${qty})`, userId]
      );
    }

    appliedLines++;
  }

  return appliedLines;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

// GET /api/store/stores -> the tenant's stores (for pickers).
router.get('/stores', authMiddleware, requireAnyPermission('store:read', 'store:request'), async (c: any) => {
  try {
    const userRole = c.get('userRole') as string;
    const tenantId = c.get('tenantId') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];

    let result;
    if (userRole === 'developer') {
      result = await readDb.read(
        `SELECT id, name, branch_name, phone, address, tenant_id FROM shops WHERE type = 'store' ORDER BY created_at ASC`
      );
    } else if (tenantId) {
      result = await readDb.read(
        `SELECT id, name, branch_name, phone, address, tenant_id FROM shops
          WHERE type = 'store' AND (tenant_id = $1 OR id = ANY($2)) ORDER BY created_at ASC`,
        [tenantId, shopIds]
      );
    } else {
      result = await readDb.read(
        `SELECT id, name, branch_name, phone, address, tenant_id FROM shops
          WHERE type = 'store' AND id = ANY($1) ORDER BY created_at ASC`,
        [shopIds]
      );
    }
    return c.json({ success: true, data: { stores: result.rows } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/store/create -> create a store for the caller's business.
router.post('/create', authMiddleware, requirePermission('shop:create'), requireActiveSubscription, async (c: any) => {
  try {
    const body = await c.req.json();
    const { name, branchName, phone, email, address } = body;
    const tenantId = c.get('tenantId') as string;
    const userId = c.get('userId') as string;

    if (!name || !String(name).trim()) return c.json({ success: false, error: 'Store name is required' }, 400);
    if (!tenantId) return c.json({ success: false, error: 'No tenant assigned to your account' }, 400);

    const code = 'STORE-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16) + '-' + Math.random().toString(36).slice(2, 6);
    const result = await pool.query(
      `INSERT INTO shops (name, code, description, address, phone, email, business_name, branch_name, tenant_id, type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'store')
       RETURNING *`,
      [String(name).trim(), code, 'Store / ghala', address || null, phone || null, email || null, name || null, branchName || null, tenantId]
    );
    const store = result.rows[0];

    // Link the creator to the store without touching their default shop or
    // role — creating a store must not move the admin anywhere.
    await pool.query(
      `INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (user_id, shop_id) DO NOTHING`,
      [userId, store.id]
    );

    cache.invalidateByPrefix('shops');

    const user = c.get('user') as any;
    logActivity({
      userId,
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'store_created',
      entityType: 'shop',
      entityId: store.id,
      shopId: store.id,
      details: { name: store.name, type: 'store' }
    }).catch(() => {});

    return c.json({ success: true, data: { store } }, 201);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Summary / stock
// ---------------------------------------------------------------------------

router.get('/summary', authMiddleware, requirePermission('store:read'), async (c: any) => {
  try {
    const store = await getStore(c, c.req.query('storeId') || '');
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);

    const [stockRes, pendingRes, monthRes, shopCountRes, expiringRes] = await Promise.all([
      readDb.read(
        `SELECT COUNT(*) as products,
                COALESCE(SUM(current_stock * buying_price), 0) as stock_value,
                COALESCE(SUM(current_stock * selling_price), 0) as retail_value
           FROM products WHERE shop_id = $1 AND is_active = true`,
        [store.id]
      ),
      readDb.read(`SELECT COUNT(*) as count FROM store_requests WHERE store_shop_id = $1 AND status = 'pending'`, [store.id]),
      readDb.read(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'receive' THEN total_cost ELSE 0 END), 0) as received_value,
           COALESCE(SUM(CASE WHEN type = 'issue' THEN total_cost ELSE 0 END), 0) as issued_value
         FROM store_stock_movements
         WHERE store_shop_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
        [store.id]
      ),
      readDb.read(
        `SELECT COUNT(*) as count FROM shops
          WHERE tenant_id = $1 AND type = 'shop' AND (is_super_admin IS NOT TRUE OR is_super_admin = FALSE)`,
        [store.tenant_id]
      ),
      readDb.read(
        `SELECT COUNT(*) as count FROM products
          WHERE shop_id = $1 AND is_active = true AND current_stock > 0
            AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + INTERVAL '30 days'`,
        [store.id]
      ),
    ]);

    const [movements, requests] = await Promise.all([
      readDb.read(
        `SELECT id, product_name, type, quantity, unit_cost, total_cost, supplier_name, created_by_name, created_at
           FROM store_stock_movements WHERE store_shop_id = $1 ORDER BY created_at DESC LIMIT 8`,
        [store.id]
      ),
      readDb.read(
        `SELECT r.id, r.request_number, r.status, r.total_cost, r.created_at, s.name as shop_name
           FROM store_requests r JOIN shops s ON s.id = r.shop_id
          WHERE r.store_shop_id = $1 ORDER BY r.created_at DESC LIMIT 5`,
        [store.id]
      ),
    ]);

    return c.json({
      success: true,
      data: {
        store: { id: store.id, name: store.name, branch_name: store.branch_name, phone: store.phone, address: store.address },
        stats: {
          products: parseInt(stockRes.rows[0].products) || 0,
          stockValue: parseFloat(stockRes.rows[0].stock_value) || 0,
          retailValue: parseFloat(stockRes.rows[0].retail_value) || 0,
          pendingRequests: parseInt(pendingRes.rows[0].count) || 0,
          receivedThisMonth: parseFloat(monthRes.rows[0].received_value) || 0,
          issuedThisMonth: parseFloat(monthRes.rows[0].issued_value) || 0,
          shopsServed: parseInt(shopCountRes.rows[0].count) || 0,
          expiringSoon: parseInt(expiringRes.rows[0].count) || 0,
        },
        recentMovements: movements.rows,
        recentRequests: requests.rows,
      }
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.get('/stock', authMiddleware, requirePermission('store:read'), async (c: any) => {
  try {
    const store = await getStore(c, c.req.query('storeId') || '');
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);

    const search = (c.req.query('search') || '').trim();
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '100')));
    const offset = (page - 1) * limit;

    const params: any[] = [store.id];
    let where = `shop_id = $1 AND is_active = true`;
    if (search) where += buildProductSearchFilter(params, search);

    const [listRes, countRes, totalsRes] = await Promise.all([
      readDb.read(
        `SELECT id, name, barcode, unit_type, current_stock, low_stock_threshold, buying_price, selling_price, expiry_date,
                (current_stock * buying_price) as stock_value, (current_stock * selling_price) as retail_value
           FROM products WHERE ${where}
          ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      readDb.read(`SELECT COUNT(*) as count FROM products WHERE ${where}`, params),
      readDb.read(
        `SELECT COALESCE(SUM(current_stock * buying_price), 0) as stock_value,
                COALESCE(SUM(current_stock * selling_price), 0) as retail_value,
                COALESCE(SUM(current_stock), 0) as total_units
           FROM products WHERE shop_id = $1 AND is_active = true`,
        [store.id]
      ),
    ]);

    return c.json({
      success: true,
      data: {
        products: listRes.rows.map((p: any) => ({
          id: p.id,
          name: p.name,
          barcode: p.barcode,
          unitType: p.unit_type,
          currentStock: parseFloat(p.current_stock) || 0,
          lowStockThreshold: parseFloat(p.low_stock_threshold) || 0,
          buyingPrice: parseFloat(p.buying_price) || 0,
          sellingPrice: parseFloat(p.selling_price) || 0,
          expiryDate: p.expiry_date || null,
          stockValue: parseFloat(p.stock_value) || 0,
          retailValue: parseFloat(p.retail_value) || 0,
        })),
        total: parseInt(countRes.rows[0].count) || 0,
        page,
        limit,
        totals: {
          stockValue: parseFloat(totalsRes.rows[0].stock_value) || 0,
          retailValue: parseFloat(totalsRes.rows[0].retail_value) || 0,
          totalUnits: parseFloat(totalsRes.rows[0].total_units) || 0,
        },
      }
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/store/catalog -> products a shop may request (with availability).
router.get('/catalog', authMiddleware, requireAnyPermission('store:read', 'store:request'), async (c: any) => {
  try {
    const store = await getStore(c, c.req.query('storeId') || '');
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);

    const search = (c.req.query('search') || '').trim();
    const params: any[] = [store.id];
    let where = `shop_id = $1 AND is_active = true`;
    if (search) where += buildProductSearchFilter(params, search);

    const result = await readDb.read(
      `SELECT id, name, barcode, unit_type, current_stock, selling_price
         FROM products WHERE ${where} ORDER BY name ASC LIMIT 50`,
      params
    );

    return c.json({
      success: true,
      data: {
        store: { id: store.id, name: store.name },
        products: result.rows.map((p: any) => ({
          id: p.id,
          name: p.name,
          barcode: p.barcode,
          unitType: p.unit_type,
          available: parseFloat(p.current_stock) || 0,
          sellingPrice: parseFloat(p.selling_price) || 0,
        })),
      }
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Receiving stock (from a supplier or anywhere else)
// ---------------------------------------------------------------------------

router.post('/receive', authMiddleware, requirePermission('store:manage'), requireActiveSubscription, async (c: any) => {
  let inTransaction = false;
  try {
    const body = await c.req.json();
    const { storeId, supplierId, supplierName, notes, items, paymentStatus, amountPaid, dueDate } = body;
    const store = await getStore(c, storeId);
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);
    // A store may only receive goods from its OWN suppliers. Reject a supplier
    // id that belongs to another shop/store (cross-shop data separation).
    if (supplierId) {
      const supCheck = await pool.query(
        `SELECT id FROM suppliers WHERE id = $1 AND shop_id = $2`,
        [supplierId, store.id]
      );
      if (supCheck.rows.length === 0) {
        return c.json({ success: false, error: 'Supplier not found in this store' }, 400);
      }
    }
    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: 'Add at least one product to receive' }, 400);
    }

    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Store';
    const receiptNumber = `RCV-${Date.now().toString(36).toUpperCase()}`;

    let totalCost = 0;
    const normalized = items.map((it: any) => {
      const qty = parseFloat(it.quantity) || 0;
      const unitCost = parseFloat(it.unitCost) || 0;
      const lineTotal = parseFloat(it.totalCost) || qty * unitCost;
      totalCost += lineTotal;
      return {
        productId: it.productId || null,
        productName: String(it.productName || it.name || 'Item').trim(),
        barcode: it.barcode || null,
        unitType: it.unitType || 'PCS',
        sellingPrice: it.sellingPrice !== undefined && it.sellingPrice !== null && it.sellingPrice !== '' ? parseFloat(it.sellingPrice) : null,
        expiryDate: it.expiryDate || null,
        quantity: qty,
        unitCost,
        totalCost: lineTotal,
      };
    }).filter((it: any) => it.quantity > 0);

    if (normalized.length === 0) {
      return c.json({ success: false, error: 'Each item needs a quantity greater than 0' }, 400);
    }

    // How the goods were paid for: cash (paid) or supplier credit (deni).
    // amount_paid defaults to what was actually paid today.
    const payRaw = String(paymentStatus || 'paid').toLowerCase();
    const payStatus = ['paid', 'partial', 'credit'].includes(payRaw) ? payRaw : (payRaw === 'cash' ? 'paid' : 'paid');
    const paidToday = amountPaid !== undefined && amountPaid !== null && amountPaid !== '' ? parseFloat(amountPaid) || 0 : (payStatus === 'paid' ? totalCost : 0);
    const creditDue = payStatus === 'paid' ? null : (dueDate || null);

    await pool.query('BEGIN');
    inTransaction = true;

    const receiptResult = await pool.query(
      `INSERT INTO store_receipts (store_shop_id, tenant_id, supplier_id, supplier_name, receipt_number, total_cost, notes, received_by, received_by_name, payment_status, amount_paid, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [store.id, store.tenant_id || null, supplierId || null, supplierName || null, receiptNumber, totalCost, notes || null, userId, userName, payStatus, paidToday, creditDue]
    );
    const receipt = receiptResult.rows[0];

    for (const it of normalized) {
      let productId = it.productId;

      if (productId) {
        const check = await pool.query(`SELECT id FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE`, [productId, store.id]);
        if (check.rows.length === 0) throw new Error(`Product not found in this store: ${it.productName}`);
        await pool.query(
          `UPDATE products SET current_stock = current_stock + $1::numeric,
             buying_price = CASE WHEN $2::numeric > 0 THEN $2::numeric ELSE buying_price END,
             selling_price = CASE WHEN $3::numeric IS NOT NULL AND $3::numeric > 0 THEN $3::numeric ELSE selling_price END,
             expiry_date = CASE
               WHEN $4::date IS NULL THEN expiry_date
               WHEN expiry_date IS NULL OR expiry_date::date < CURRENT_DATE THEN $4::date
               WHEN $4::date < expiry_date::date THEN $4::date
               ELSE expiry_date END,
             updated_at = NOW()
           WHERE id = $5`,
          [it.quantity, it.unitCost, it.sellingPrice, it.expiryDate, productId]
        );
      } else {
        // Brand-new product straight into the store's catalog.
        const created = await pool.query(
          `INSERT INTO products (shop_id, name, sku, barcode, unit_type, buying_price, selling_price, current_stock, low_stock_threshold, expiry_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10) RETURNING id`,
          [store.id, it.productName, generateProductSku(), it.barcode, it.unitType, it.unitCost, it.sellingPrice ?? it.unitCost, it.quantity, it.expiryDate, userId]
        );
        productId = created.rows[0].id;
      }

      await pool.query(
        `INSERT INTO store_receipt_items (receipt_id, product_id, product_name, quantity, unit_cost, total_cost, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [receipt.id, productId, it.productName, it.quantity, it.unitCost, it.totalCost, it.expiryDate]
      );

      await pool.query(
        `INSERT INTO store_stock_movements (store_shop_id, product_id, product_name, type, quantity, unit_cost, total_cost, reference_type, reference_id, supplier_name, notes, created_by, created_by_name)
         VALUES ($1, $2, $3, 'receive', $4, $5, $6, 'store_receipt', $7, $8, $9, $10, $11)`,
        [store.id, productId, it.productName, it.quantity, it.unitCost, it.totalCost, receipt.id, supplierName || null, notes || null, userId, userName]
      );
    }

    await pool.query('COMMIT');
    inTransaction = false;

    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');

    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: 'store_stock_received',
      entityType: 'store_receipt',
      entityId: receipt.id,
      shopId: store.id,
      details: { receiptNumber, totalCost, itemCount: normalized.length, supplierName: supplierName || null, paymentStatus: payStatus, amountPaid: paidToday }
    }).catch(() => {});

    return c.json({ success: true, data: { receipt: { ...receipt, total_cost: totalCost }, itemCount: normalized.length } }, 201);
  } catch (error: any) {
    if (inTransaction) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    console.error('[Store Receive] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Manual stock adjustment (damage, loss, expired goods, count corrections...)
// ---------------------------------------------------------------------------
// The store manager corrects a product's stock. Nothing is ever silent — every
// correction is written to three ledgers:
//   - store_stock_movements (type 'adjustment') -> store movement / report log
//   - stock_adjustments                        -> owner monitor + audit trail
//   - activity_logs (store_stock_adjusted)     -> the "Kumbukumbu" audit tab
router.post('/adjust', authMiddleware, requirePermission('store:manage'), requireActiveSubscription, async (c: any) => {
  let inTransaction = false;
  try {
    const body = await c.req.json();
    const { storeId, productId, mode, quantity, reason } = body;
    const store = await getStore(c, storeId);
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);
    if (!productId) return c.json({ success: false, error: 'Choose a product to adjust' }, 400);

    const adjMode = ['add', 'remove', 'set'].includes(String(mode)) ? String(mode) : 'set';
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || qty < 0 || (adjMode !== 'set' && qty <= 0)) {
      return c.json({ success: false, error: 'Enter a valid quantity' }, 400);
    }

    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Store';
    const cleanReason = String(reason || '').trim().slice(0, 500);
    const reference = `ADJ-${Date.now().toString(36).toUpperCase()}`;

    await pool.query('BEGIN');
    inTransaction = true;

    const productRes = await pool.query(
      `SELECT id, name, current_stock, buying_price FROM products
        WHERE id = $1 AND shop_id = $2 AND is_active = true FOR UPDATE`,
      [productId, store.id]
    );
    if (productRes.rows.length === 0) throw new Error('Product not found in this store');
    const product = productRes.rows[0];

    const previous = parseFloat(product.current_stock) || 0;
    const next = adjMode === 'add' ? previous + qty : adjMode === 'remove' ? Math.max(previous - qty, 0) : qty;
    const difference = Math.round((next - previous) * 10000) / 10000;

    if (difference === 0) {
      await pool.query('ROLLBACK');
      inTransaction = false;
      return c.json({ success: false, error: 'Stock is already at that level' }, 400);
    }

    await pool.query(`UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2`, [next, productId]);

    const unitCost = parseFloat(product.buying_price) || 0;
    const note = `${reference}${cleanReason ? `: ${cleanReason}` : ''} (${adjMode} ${qty})`;

    // 1. Store stock ledger (movement + report).
    await pool.query(
      `INSERT INTO store_stock_movements (store_shop_id, product_id, product_name, type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_by, created_by_name)
       VALUES ($1, $2, $3, 'adjustment', $4, $5, $6, 'manual_adjustment', NULL, $7, $8, $9)`,
      [store.id, productId, product.name, Math.abs(difference), unitCost, Math.abs(difference) * unitCost, note, userId, userName]
    );

    // 2. Adjustment ledger — stock_adjustments uses integer columns, so the
    // rounded figures are logged and the exact change stays in the note.
    await pool.query(
      `INSERT INTO stock_adjustments (product_id, shop_id, previous_quantity, new_quantity, difference, adjustment_type, reference_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, 'manual_adjustment', NULL, $6, $7)`,
      [productId, store.id, Math.round(previous), Math.round(next), Math.round(next - previous), note, userId]
    );

    await pool.query('COMMIT');
    inTransaction = false;

    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');

    // 3. Activity log — the admin sees this in "Kumbukumbu" and the activity page.
    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: 'store_stock_adjusted',
      entityType: 'store_product',
      entityId: productId,
      shopId: store.id,
      details: { reference, productName: product.name, mode: adjMode, quantity: qty, previousQuantity: previous, newQuantity: next, difference, reason: cleanReason || null }
    }).catch(() => {});

    return c.json({
      success: true,
      data: { productId, productName: product.name, previous, new: next, difference, reference }
    });
  } catch (error: any) {
    if (inTransaction) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    console.error('[Store Adjust] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Transfer: shop -> store (admin pushes goods from a shop into the store)
// ---------------------------------------------------------------------------
// mode 'all'   — one command that moves every active product's full stock;
//                the shop's rows drop to 0 and the store shows them all with
//                their details/stock.
// mode 'items' — partial quantities (e.g. 400 of 500): the store receives 400
//                and the shop keeps 100.
// The store side is recorded as a paid receipt + a 'receive' movement
// (reference_type 'shop_transfer') so all existing store report metrics stay
// correct; the shop side is a stock deduction logged in stock_adjustments.
// Sellers then request goods back slowly via the existing store_requests flow.
router.post('/transfer', authMiddleware, requirePermission('store:manage'), requireActiveSubscription, async (c: any) => {
  let inTransaction = false;
  try {
    const body = await c.req.json();
    const { storeId, shopId, mode, items, notes } = body;
    const store = await getStore(c, storeId);
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);
    if (!shopId) return c.json({ success: false, error: 'shopId is required' }, 400);

    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Admin';
    const userRole = c.get('userRole') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];
    const tenantId = c.get('tenantId') as string;

    const shopRes = await readDb.read(`SELECT id, name, type, tenant_id FROM shops WHERE id = $1`, [shopId]);
    if (shopRes.rows.length === 0) return c.json({ success: false, error: 'Shop not found' }, 404);
    const shop = shopRes.rows[0];
    if (shop.type === 'store') return c.json({ success: false, error: 'Chagua duka (si ghala) kama chanzo' }, 400);
    const sameTenant = tenantId && shop.tenant_id && String(shop.tenant_id) === String(tenantId);
    if (userRole !== 'developer' && !shopIds.includes(shopId) && !sameTenant) {
      return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
    }

    const moveAll = String(mode || 'all') === 'all';
    let requestedItems: any[] = [];
    if (moveAll) {
      const all = await readDb.read(
        `SELECT id FROM products WHERE shop_id = $1 AND is_active = true AND current_stock > 0`,
        [shopId]
      );
      requestedItems = all.rows.map((r: any) => ({ productId: r.id }));
    } else {
      if (!Array.isArray(items) || items.length === 0) {
        return c.json({ success: false, error: 'Add at least one product to transfer' }, 400);
      }
      requestedItems = items
        .map((it: any) => ({ productId: it.productId, quantity: parseFloat(it.quantity) || 0 }))
        .filter((it: any) => it.productId && it.quantity > 0);
      if (requestedItems.length === 0) {
        return c.json({ success: false, error: 'Each item needs a quantity greater than 0' }, 400);
      }
    }

    await pool.query('BEGIN');
    inTransaction = true;

    const receiptNumber = `TRF-${Date.now().toString(36).toUpperCase()}`;
    const receiptResult = await pool.query(
      `INSERT INTO store_receipts (store_shop_id, tenant_id, supplier_id, supplier_name, receipt_number, total_cost, notes, received_by, received_by_name, payment_status, amount_paid, due_date)
       VALUES ($1, $2, NULL, $3, $4, 0, $5, $6, $7, 'paid', 0, NULL) RETURNING *`,
      [store.id, store.tenant_id || null, `Hamisha kutoka ${shop.name}`, receiptNumber, notes || null, userId, userName]
    );
    const receipt = receiptResult.rows[0];

    const transferred: any[] = [];
    let totalCost = 0;
    let totalUnits = 0;

    for (const requested of requestedItems) {
      // Lock the SHOP's row: concurrent sales/adjustments must not race the
      // deduction, and this is where we read the authoritative stock.
      const lock = await pool.query(
        `SELECT id, name, barcode, unit_type, buying_price, selling_price, current_stock, expiry_date, low_stock_threshold
           FROM products WHERE id = $1 AND shop_id = $2 AND is_active = true FOR UPDATE`,
        [requested.productId, shop.id]
      );
      if (lock.rows.length === 0) throw new Error(`Product not found in shop: ${requested.productName || requested.productId}`);
      const p = lock.rows[0];
      const available = parseFloat(p.current_stock) || 0;
      // 'all' takes everything still available; 'items' clamps to stock so a
      // partial transfer (400 of 500) never overdraws the shop.
      const qty = moveAll ? available : Math.min(requested.quantity, available);
      if (!(qty > 0)) continue;

      const prev = available;
      const next = available - qty;
      await pool.query(
        `UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2`,
        [next, p.id]
      );
      // stock_adjustments uses integer columns — log the rounded movement and
      // keep the exact quantity in the note.
      await pool.query(
        `INSERT INTO stock_adjustments (product_id, shop_id, previous_quantity, new_quantity, difference, adjustment_type, reference_id, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, 'store_transfer', $6, $7, $8)`,
        [p.id, shop.id, Math.round(prev), Math.round(next), -Math.round(qty), receipt.id, `Transfer ${receiptNumber} → ${store.name} (${qty})`, userId]
      );

      // Find the store's copy of this product: barcode first, then name —
      // same matching the store uses when issuing stock to shops.
      let storeProduct: any = null;
      if (p.barcode) {
        const byBarcode = await pool.query(
          `SELECT * FROM products WHERE shop_id = $1 AND barcode = $2 AND is_active = true ORDER BY created_at LIMIT 1 FOR UPDATE`,
          [store.id, p.barcode]
        );
        if (byBarcode.rows.length > 0) storeProduct = byBarcode.rows[0];
      }
      if (!storeProduct) {
        const byName = await pool.query(
          `SELECT * FROM products WHERE shop_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true ORDER BY created_at LIMIT 1 FOR UPDATE`,
          [store.id, p.name]
        );
        if (byName.rows.length > 0) storeProduct = byName.rows[0];
      }

      let storeProductId: string;
      if (storeProduct) {
        storeProductId = storeProduct.id;
        await pool.query(
          `UPDATE products SET
             current_stock = current_stock + $1,
             barcode = COALESCE(NULLIF(barcode, ''), $2),
             buying_price = CASE WHEN buying_price IS NULL OR buying_price = 0 THEN $3 ELSE buying_price END,
             selling_price = CASE WHEN selling_price IS NULL OR selling_price = 0 THEN $4 ELSE selling_price END,
             low_stock_threshold = CASE WHEN low_stock_threshold IS NULL OR low_stock_threshold = 0 THEN $5 ELSE low_stock_threshold END,
             expiry_date = CASE
               WHEN $6::date IS NULL THEN expiry_date
               WHEN expiry_date IS NULL OR expiry_date::date < CURRENT_DATE THEN $6::date
               WHEN $6::date < expiry_date::date THEN $6::date
               ELSE expiry_date END,
             updated_at = NOW()
           WHERE id = $7`,
          [qty, p.barcode || null, parseFloat(p.buying_price) || 0, parseFloat(p.selling_price) || 0,
           p.low_stock_threshold || 0, p.expiry_date || null, storeProductId]
        );
      } else {
        // First time this product enters the store — create it with all details.
        const created = await pool.query(
          `INSERT INTO products (shop_id, name, sku, barcode, unit_type, buying_price, selling_price, current_stock, low_stock_threshold, expiry_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [store.id, p.name, generateProductSku(), p.barcode || null, p.unit_type || 'PCS',
           parseFloat(p.buying_price) || 0, parseFloat(p.selling_price) || 0, qty,
           p.low_stock_threshold || 0, p.expiry_date || null, userId]
        );
        storeProductId = created.rows[0].id;
      }

      const unitCost = parseFloat(p.buying_price) || 0;
      const lineTotal = qty * unitCost;
      totalCost += lineTotal;
      totalUnits += qty;

      await pool.query(
        `INSERT INTO store_receipt_items (receipt_id, product_id, product_name, quantity, unit_cost, total_cost, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [receipt.id, storeProductId, p.name, qty, unitCost, lineTotal, p.expiry_date || null]
      );
      await pool.query(
        `INSERT INTO store_stock_movements (store_shop_id, product_id, product_name, type, quantity, unit_cost, total_cost, reference_type, reference_id, supplier_name, notes, created_by, created_by_name)
         VALUES ($1, $2, $3, 'receive', $4, $5, $6, 'shop_transfer', $7, $8, $9, $10, $11)`,
        [store.id, storeProductId, p.name, qty, unitCost, lineTotal, receipt.id, `Hamisha kutoka ${shop.name}`, notes || null, userId, userName]
      );

      transferred.push({ productId: storeProductId, productName: p.name, quantity: qty, keptInShop: next });
    }

    if (transferred.length === 0) throw new Error('Hakuna bidhaa za kuhamisha (stock ni sifuri au zilishahamishwa).');

    await pool.query(`UPDATE store_receipts SET total_cost = $1 WHERE id = $2`, [totalCost, receipt.id]);

    await pool.query('COMMIT');
    inTransaction = false;

    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
    cache.invalidateByPrefix('store:');

    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: 'store_transferred',
      entityType: 'store_receipt',
      entityId: receipt.id,
      shopId: store.id,
      details: { receiptNumber, fromShop: shop.name, toStore: store.name, mode: moveAll ? 'all' : 'items', itemCount: transferred.length, totalUnits, totalCost }
    }).catch(() => {});

    return c.json({
      success: true,
      data: { receiptNumber, shopName: shop.name, storeName: store.name, itemCount: transferred.length, totalUnits, totalCost, items: transferred }
    }, 201);
  } catch (error: any) {
    if (inTransaction) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    console.error('[Store Transfer] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/store/dispatch -> the store pushes stock straight to a shop (bulk).
// This is the store-side counterpart of /transfer: the store picks products and
// quantities (or everything), the store's stock is deducted and the shop's
// stock is topped up immediately (same auto-receive as issuing a request).
router.post('/dispatch', authMiddleware, requirePermission('store:manage'), requireActiveSubscription, async (c: any) => {
  let inTransaction = false;
  try {
    const body = await c.req.json();
    const { shopId, mode, items, notes } = body;
    const store = await getStore(c, body.storeId);
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);
    if (!shopId) return c.json({ success: false, error: 'Chagua duka lengo' }, 400);

    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Store';
    const userRole = c.get('userRole') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];
    const tenantId = c.get('tenantId') as string;

    const shopRes = await readDb.read(`SELECT id, name, type, tenant_id FROM shops WHERE id = $1`, [shopId]);
    if (shopRes.rows.length === 0) return c.json({ success: false, error: 'Shop not found' }, 404);
    const shop = shopRes.rows[0];
    if (shop.type === 'store') return c.json({ success: false, error: 'Chagua duka (si ghala) kama lengo' }, 400);
    const sameTenant = tenantId && shop.tenant_id && String(shop.tenant_id) === String(tenantId);
    if (userRole !== 'developer' && !shopIds.includes(shopId) && !sameTenant) {
      return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
    }

    const moveAll = String(mode || 'items') === 'all';
    let requestedItems: any[] = [];
    if (moveAll) {
      const all = await readDb.read(
        `SELECT id FROM products WHERE shop_id = $1 AND is_active = true AND current_stock > 0`,
        [store.id]
      );
      requestedItems = all.rows.map((r: any) => ({ productId: r.id }));
    } else {
      if (!Array.isArray(items) || items.length === 0) {
        return c.json({ success: false, error: 'Chagua angalau bidhaa moja' }, 400);
      }
      requestedItems = items
        .map((it: any) => ({ productId: it.productId, quantity: parseFloat(it.quantity) || 0 }))
        .filter((it: any) => it.productId && it.quantity > 0);
      if (requestedItems.length === 0) {
        return c.json({ success: false, error: 'Kila bidhaa inahitaji idadi zaidi ya 0' }, 400);
      }
    }

    await pool.query('BEGIN');
    inTransaction = true;

    const reference = `SHP-${Date.now().toString(36).toUpperCase()}`;
    const dispatchId = randomUUID();
    const dispatchItems: any[] = [];
    let totalUnits = 0;
    let totalCost = 0;

    for (const requested of requestedItems) {
      // Lock the STORE row: concurrent issues/dispatches must not race the
      // deduction, and this is where the authoritative stock is read.
      const lock = await pool.query(
        `SELECT id, name, barcode, unit_type, buying_price, selling_price, current_stock, expiry_date
           FROM products WHERE id = $1 AND shop_id = $2 AND is_active = true FOR UPDATE`,
        [requested.productId, store.id]
      );
      if (lock.rows.length === 0) throw new Error(`Bidhaa haipatikani ghalani: ${requested.productId}`);
      const p = lock.rows[0];
      const available = parseFloat(p.current_stock) || 0;
      // 'all' takes everything left; 'items' clamps to stock so a partial
      // dispatch never overdraws the store.
      const qty = moveAll ? available : Math.min(requested.quantity, available);
      if (!(qty > 0)) continue;

      await pool.query(
        `UPDATE products SET current_stock = current_stock - $1, updated_at = NOW() WHERE id = $2`,
        [qty, p.id]
      );

      const unitCost = parseFloat(p.buying_price) || 0;
      totalUnits += qty;
      totalCost += unitCost * qty;

      await pool.query(
        `INSERT INTO store_stock_movements (store_shop_id, product_id, product_name, type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_by, created_by_name)
         VALUES ($1, $2, $3, 'issue', $4, $5, $6, 'shop_dispatch', $7, $8, $9, $10)`,
        [store.id, p.id, p.name, -qty, unitCost, unitCost * qty, dispatchId,
         `Kwenda ${shop.name} (${reference})${notes ? ` — ${notes}` : ''}`, userId, userName]
      );

      dispatchItems.push({
        issued_qty: qty,
        product_id: p.id,
        product_name: p.name,
        barcode: p.barcode,
        unit_type: p.unit_type,
        unit_cost: unitCost,
        expiry_date: p.expiry_date,
      });
    }

    if (dispatchItems.length === 0) throw new Error('Hakuna bidhaa za kutuma (stock ni sifuri).');

    // Land the goods in the destination shop immediately (auto-receive).
    await applyIssuedStockToShop(
      { shop_id: shop.id, tenant_id: shop.tenant_id || null, id: dispatchId, request_number: reference },
      dispatchItems,
      userId,
      'Store dispatch'
    );

    await pool.query('COMMIT');
    inTransaction = false;

    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('reports:');
    cache.invalidateByPrefix('store:');

    // Tell the destination shop that the goods are on the way and their stock
    // was already topped up.
    const recipients = await getRecipients(shop.id, shop.tenant_id || null);
    notifyUsers(recipients, {
      tenantId: shop.tenant_id || null,
      title: `Mzigo umetumwa — ${store.name}`,
      message: `Bidhaa ${dispatchItems.length} zimetumwa kutoka ghala ${store.name} (${reference}). Stock yako imeongezwa kiotomatiki — angalia Bidhaa.`,
      actionUrl: '/products',
      emailSubject: `[ALFEAN ENTERPRISES] Mzigo umetumwa kutoka ${store.name}`,
      emailHtml: emailShell(
        `Mzigo umetumwa: ${reference}`,
        `<tr><td style="padding:6px 4px">Ghala</td><td style="padding:6px 4px;text-align:right">${store.name}</td></tr>
         <tr><td style="padding:6px 4px">Bidhaa</td><td style="padding:6px 4px;text-align:right">${dispatchItems.length}</td></tr>
         <tr><td style="padding:6px 4px">Jumla ya units</td><td style="padding:6px 4px;text-align:right"><strong>${totalUnits}</strong></td></tr>`,
        `Stock imeongezwa kwenye duka lako kiotomatiki. Ingia ALFEAN ENTERPRISES &rarr; Bidhaa kuona mzigo.`
      ),
      createdBy: userId,
    }).catch(() => {});

    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: 'store_dispatched',
      entityType: 'shop',
      entityId: shop.id,
      shopId: store.id,
      details: { reference, fromStore: store.name, toShop: shop.name, mode: moveAll ? 'all' : 'items', itemCount: dispatchItems.length, totalUnits, totalCost }
    }).catch(() => {});

    return c.json({
      success: true,
      data: {
        reference,
        shopName: shop.name,
        storeName: store.name,
        itemCount: dispatchItems.length,
        totalUnits,
        totalCost,
        items: dispatchItems.map((it) => ({ productName: it.product_name, quantity: it.issued_qty })),
      }
    }, 201);
  } catch (error: any) {
    if (inTransaction) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    console.error('[Store Dispatch] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

router.get('/receipts', authMiddleware, requirePermission('store:read'), async (c: any) => {
  try {
    const store = await getStore(c, c.req.query('storeId') || '');
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);

    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '30')));
    const receipts = await readDb.read(
      `SELECT r.*, COALESCE(json_agg(json_build_object(
                'productName', ri.product_name,
                'quantity', ri.quantity,
                'unitCost', ri.unit_cost,
                'totalCost', ri.total_cost,
                'expiryDate', ri.expiry_date
              ) ORDER BY ri.created_at) FILTER (WHERE ri.id IS NOT NULL), '[]') as items
         FROM store_receipts r
         LEFT JOIN store_receipt_items ri ON ri.receipt_id = r.id
        WHERE r.store_shop_id = $1
        GROUP BY r.id
        ORDER BY r.created_at DESC
        LIMIT ${limit}`,
      [store.id]
    );

    return c.json({ success: true, data: { receipts: receipts.rows } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Requests: shop asks the store, store issues, shop confirms receipt
// ---------------------------------------------------------------------------

// POST /api/store/requests  (shop side)
router.post('/requests', authMiddleware, requirePermission('store:request'), requireActiveSubscription, async (c: any) => {
  let inTransaction = false;
  try {
    const body = await c.req.json();
    const { shopId, storeId, notes, items } = body;
    const userRole = c.get('userRole') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: 'Add at least one product to request' }, 400);
    }
    if (!shopId) return c.json({ success: false, error: 'shopId is required' }, 400);
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
    }

    const store = await getStore(c, storeId);
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);

    const shopRes = await readDb.read(`SELECT id, name, tenant_id FROM shops WHERE id = $1`, [shopId]);
    if (shopRes.rows.length === 0) return c.json({ success: false, error: 'Shop not found' }, 404);
    const shop = shopRes.rows[0];

    // Validate every line against live store stock: nobody may request more
    // than the store actually holds.
    const normalized: any[] = [];
    let totalCost = 0;
    for (const it of items) {
      const qty = parseFloat(it.quantity) || 0;
      if (qty <= 0) continue;
      const productRes = await readDb.read(
        `SELECT id, name, barcode, unit_type, current_stock, buying_price, expiry_date
           FROM products WHERE id = $1 AND shop_id = $2 AND is_active = true`,
        [it.productId, store.id]
      );
      if (productRes.rows.length === 0) {
        return c.json({ success: false, error: `Product not found in store: ${it.productName || it.productId}` }, 400);
      }
      const p = productRes.rows[0];
      const available = parseFloat(p.current_stock) || 0;
      if (qty > available) {
        return c.json({ success: false, error: `"${p.name}" ina ${available} tu kwenye ghala — huwezi kuomba ${qty}.` }, 400);
      }
      const unitCost = parseFloat(p.buying_price) || 0;
      totalCost += unitCost * qty;
      normalized.push({
        productId: p.id,
        productName: p.name,
        barcode: p.barcode,
        unitType: p.unit_type || 'PCS',
        requestedQty: qty,
        availableAtRequest: available,
        unitCost,
        totalCost: unitCost * qty,
        expiryDate: p.expiry_date || null,
      });
    }

    if (normalized.length === 0) return c.json({ success: false, error: 'Add at least one product to request' }, 400);

    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Shop';
    const requestNumber = `REQ-${Date.now().toString(36).toUpperCase()}`;

    await pool.query('BEGIN');
    inTransaction = true;

    const requestResult = await pool.query(
      `INSERT INTO store_requests (tenant_id, store_shop_id, shop_id, request_number, status, total_cost, notes, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8) RETURNING *`,
      [store.tenant_id || shop.tenant_id || null, store.id, shopId, requestNumber, totalCost, notes || null, userId, userName]
    );
    const request = requestResult.rows[0];

    for (const it of normalized) {
      await pool.query(
        `INSERT INTO store_request_items (request_id, product_id, product_name, barcode, unit_type, requested_qty, issued_qty, unit_cost, total_cost, available_at_request, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10)`,
        [request.id, it.productId, it.productName, it.barcode, it.unitType, it.requestedQty, it.unitCost, it.totalCost, it.availableAtRequest, it.expiryDate]
      );
    }

    await pool.query('COMMIT');
    inTransaction = false;

    cache.invalidateByPrefix('store:');

    // Tell the store team (in-app + email): what was requested, quantities and costs.
    const recipients = await getRecipients(store.id, store.tenant_id || null);
    const rows = `<tr>
      <td style="padding:6px 4px;font-weight:bold">Bidhaa</td>
      <td style="padding:6px 4px;font-weight:bold;text-align:right">Idadi</td>
      <td style="padding:6px 4px;font-weight:bold;text-align:right">Gharama</td>
    </tr>${normalized.map((it) => `<tr>
        <td style="padding:6px 4px;border-bottom:1px solid #eef2f7">${it.productName}</td>
        <td style="padding:6px 4px;border-bottom:1px solid #eef2f7;text-align:right">${it.requestedQty}</td>
        <td style="padding:6px 4px;border-bottom:1px solid #eef2f7;text-align:right">${fmtMoney(it.totalCost)}</td>
      </tr>`).join('')}`;
    const emailHtml = emailShell(
      `Ombi jipya la mzigo kutoka ${shop.name}`,
      rows,
      `Jumla ya gharama: <strong>${fmtMoney(totalCost)}</strong><br/>
       Namba ya ombi: <strong>${requestNumber}</strong><br/>
       Aliomba: ${userName}<br/>
       Ingia ALFEAN ENTERPRISES &rarr; Store / Ghala ili kupitia na kutoa mzigo.`
    );
    notifyUsers(recipients, {
      tenantId: store.tenant_id || null,
      title: `Ombi jipya la mzigo — ${shop.name}`,
      message: `${shop.name} imeomba bidhaa ${normalized.length} (${requestNumber}) — jumla ${fmtMoney(totalCost)}.`,
      actionUrl: '/store',
      emailSubject: `[ALFEAN ENTERPRISES] Ombi jipya la mzigo kutoka ${shop.name}`,
      emailHtml,
      createdBy: userId,
    }).catch(() => {});

    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: 'store_request_created',
      entityType: 'store_request',
      entityId: request.id,
      shopId,
      details: { requestNumber, storeId: store.id, itemCount: normalized.length, totalCost }
    }).catch(() => {});

    return c.json({ success: true, data: { request } }, 201);
  } catch (error: any) {
    if (inTransaction) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    console.error('[Store Request] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/store/requests?storeId=&status=  (store side, incoming)
router.get('/requests', authMiddleware, requirePermission('store:read'), async (c: any) => {
  try {
    const store = await getStore(c, c.req.query('storeId') || '');
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);

    const status = c.req.query('status');
    const params: any[] = [store.id];
    let where = `r.store_shop_id = $1`;
    if (status && status !== 'all') {
      params.push(status);
      where += ` AND r.status = $${params.length}`;
    }

    const result = await readDb.read(
      `SELECT r.*, s.name as shop_name, s.phone as shop_phone,
              (SELECT COALESCE(json_agg(json_build_object(
                 'id', ri.id, 'productId', ri.product_id, 'productName', ri.product_name,
                 'quantity', ri.requested_qty, 'issuedQty', ri.issued_qty,
                 'unitCost', ri.unit_cost, 'totalCost', ri.total_cost) ORDER BY ri.created_at), '[]')
               FROM store_request_items ri WHERE ri.request_id = r.id) as items
         FROM store_requests r
         JOIN shops s ON s.id = r.shop_id
        WHERE ${where}
        ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'issued' THEN 1 ELSE 2 END, r.created_at DESC
        LIMIT 200`,
      params
    );

    return c.json({ success: true, data: { requests: result.rows } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/store/my-requests?shopId=  (shop side, outgoing)
router.get('/my-requests', authMiddleware, requirePermission('store:request'), async (c: any) => {
  try {
    const shopId = c.req.query('shopId');
    const userRole = c.get('userRole') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];
    if (!shopId) return c.json({ success: false, error: 'shopId is required' }, 400);
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
    }

    const result = await readDb.read(
      `SELECT r.*, s.name as store_name,
              (SELECT COALESCE(json_agg(json_build_object(
                 'id', ri.id, 'productId', ri.product_id, 'productName', ri.product_name,
                 'quantity', ri.requested_qty, 'issuedQty', ri.issued_qty,
                 'unitCost', ri.unit_cost, 'totalCost', ri.total_cost) ORDER BY ri.created_at), '[]')
               FROM store_request_items ri WHERE ri.request_id = r.id) as items
         FROM store_requests r
         JOIN shops s ON s.id = r.store_shop_id
        WHERE r.shop_id = $1
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [shopId]
    );

    return c.json({ success: true, data: { requests: result.rows } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/store/requests/:id -> full detail (store team OR requesting shop).
router.get('/requests/:id', authMiddleware, async (c: any) => {
  try {
    const id = c.req.param('id');
    const userRole = c.get('userRole') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];

    const result = await readDb.read(
      `SELECT r.*, s.name as shop_name, s.phone as shop_phone, st.name as store_name
         FROM store_requests r
         JOIN shops s ON s.id = r.shop_id
         JOIN shops st ON st.id = r.store_shop_id
        WHERE r.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Request not found' }, 404);
    const request = result.rows[0];

    const isStoreTeam = shopIds.includes(request.store_shop_id);
    const isShop = shopIds.includes(request.shop_id);
    if (userRole !== 'developer' && !isStoreTeam && !isShop) {
      return c.json({ success: false, error: 'Request not found' }, 404);
    }

    // Items enriched with live store stock and the shop's own stock so the
    // store manager sees the full picture before issuing. For received
    // requests the shop's previous -> new stock is included from the stock
    // adjustment logged when the goods landed in the shop.
    const itemsRes = await readDb.read(
      `SELECT ri.*,
              (SELECT current_stock FROM products p WHERE p.id = ri.product_id AND p.shop_id = $2) as store_stock,
              (SELECT current_stock FROM products p2 WHERE p2.id = ri.product_id AND p2.shop_id = $3) as shop_stock,
              (SELECT sa.previous_quantity FROM stock_adjustments sa
                JOIN products spx ON spx.id = sa.product_id
                WHERE sa.reference_id = ri.request_id
                  AND ((ri.barcode IS NOT NULL AND spx.barcode = ri.barcode)
                       OR LOWER(spx.name) = LOWER(ri.product_name))
                ORDER BY sa.created_at DESC LIMIT 1) as shop_prev_stock,
              (SELECT sa.new_quantity FROM stock_adjustments sa
                JOIN products spx ON spx.id = sa.product_id
                WHERE sa.reference_id = ri.request_id
                  AND ((ri.barcode IS NOT NULL AND spx.barcode = ri.barcode)
                       OR LOWER(spx.name) = LOWER(ri.product_name))
                ORDER BY sa.created_at DESC LIMIT 1) as shop_new_stock
         FROM store_request_items ri
        WHERE ri.request_id = $1
        ORDER BY ri.created_at`,
      [id, request.store_shop_id, request.shop_id]
    );

    return c.json({ success: true, data: { request, items: itemsRes.rows } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/store/requests/:id/issue  (store releases the goods)
router.post('/requests/:id/issue', authMiddleware, requirePermission('store:manage'), requireActiveSubscription, async (c: any) => {
  let inTransaction = false;
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const overrides: Record<string, number> = {};
    if (Array.isArray(body?.items)) {
      for (const it of body.items) {
        if (it?.itemId) overrides[it.itemId] = parseFloat(it.issuedQty) || 0;
      }
    }

    const requestRes = await readDb.read(`SELECT * FROM store_requests WHERE id = $1`, [id]);
    if (requestRes.rows.length === 0) return c.json({ success: false, error: 'Request not found' }, 404);
    const request = requestRes.rows[0];

    const store = await getStore(c, request.store_shop_id);
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);
    if (request.status !== 'pending') {
      return c.json({ success: false, error: `Request is already ${request.status}` }, 400);
    }

    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Store';

    await pool.query('BEGIN');
    inTransaction = true;

    // Re-check under lock so a double click can't issue (and auto-apply) twice.
    const lockRes = await pool.query(`SELECT status FROM store_requests WHERE id = $1 FOR UPDATE`, [id]);
    if (lockRes.rows.length === 0 || lockRes.rows[0].status !== 'pending') {
      throw new Error(`Request is already ${lockRes.rows[0]?.status || 'gone'}`);
    }

    const itemsRes = await pool.query(
      `SELECT * FROM store_request_items WHERE request_id = $1 ORDER BY created_at FOR UPDATE`,
      [id]
    );
    let issuedTotal = 0;
    const appliedItems: any[] = [];

    for (const item of itemsRes.rows) {
      const requested = parseFloat(item.requested_qty) || 0;
      const issuedQty = overrides[item.id] !== undefined ? overrides[item.id] : requested;
      if (issuedQty < 0) throw new Error(`Issued quantity cannot be negative for ${item.product_name}`);
      if (issuedQty > requested) throw new Error(`Issued quantity for ${item.product_name} cannot exceed the requested ${requested}`);
      if (issuedQty === 0) {
        await pool.query(`UPDATE store_request_items SET issued_qty = 0, total_cost = 0 WHERE id = $1`, [item.id]);
        continue;
      }

      const productRes = await pool.query(`SELECT * FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE`, [item.product_id, store.id]);
      if (productRes.rows.length === 0) throw new Error(`${item.product_name} is no longer in the store`);
      const available = parseFloat(productRes.rows[0].current_stock) || 0;
      if (issuedQty > available) {
        throw new Error(`"${item.product_name}" ina ${available} tu kwenye ghala — huwezi kutoa ${issuedQty}.`);
      }

      const unitCost = parseFloat(item.unit_cost) || 0;
      const lineCost = unitCost * issuedQty;
      issuedTotal += lineCost;

      await pool.query(`UPDATE products SET current_stock = current_stock - $1, updated_at = NOW() WHERE id = $2`, [issuedQty, item.product_id]);
      await pool.query(
        `UPDATE store_request_items SET issued_qty = $1, total_cost = $2 WHERE id = $3`,
        [issuedQty, lineCost, item.id]
      );
      appliedItems.push({ ...item, issued_qty: issuedQty });
      await pool.query(
        `INSERT INTO store_stock_movements (store_shop_id, product_id, product_name, type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_by, created_by_name)
         VALUES ($1, $2, $3, 'issue', $4, $5, $6, 'store_request', $7, $8, $9, $10)`,
        [store.id, item.product_id, item.product_name, -issuedQty, unitCost, lineCost, request.id, `To ${request.shop_id}`, userId, userName]
      );
    }

    // Issued goods land in the destination shop's stock right away — the shop
    // never adjusts stock (gain) by hand. The shop's "Nimepokea" only confirms.
    const appliedLines = await applyIssuedStockToShop(request, appliedItems, userId);

    await pool.query(
      `UPDATE store_requests
          SET status = 'issued', total_cost = $1, issued_by = $2, issued_by_name = $3, issued_at = NOW(),
              stock_applied_at = COALESCE(stock_applied_at, NOW()), updated_at = NOW()
        WHERE id = $4`,
      [issuedTotal, userId, userName, id]
    );

    await pool.query('COMMIT');
    inTransaction = false;

    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('store:');

    // Tell the requesting shop that the goods are ready to pick up and that
    // their stock was already updated.
    const recipients = await getRecipients(request.shop_id, request.tenant_id || null);
    notifyUsers(recipients, {
      tenantId: request.tenant_id || null,
      title: `Mzigo wako umetolewa — ${store.name}`,
      message: `Ombi ${request.request_number} limetolewa kwenye ghala (${fmtMoney(issuedTotal)}). Bidhaa zimeongezwa kwenye stock ya duka lako kiotomatiki — thibitisha tu kuwa umepokea.`,
      actionUrl: '/store-request',
      emailSubject: `[ALFEAN ENTERPRISES] Mzigo wako umetolewa kutoka ${store.name}`,
      emailHtml: emailShell(
        `Mzigo umetolewa: ${request.request_number}`,
        `<tr><td style="padding:6px 4px">Ghala</td><td style="padding:6px 4px;text-align:right">${store.name}</td></tr>
         <tr><td style="padding:6px 4px">Jumla</td><td style="padding:6px 4px;text-align:right"><strong>${fmtMoney(issuedTotal)}</strong></td></tr>`,
        `Stock imeongezwa kwenye duka lako kiotomatiki. Ingia ALFEAN ENTERPRISES &rarr; Omba Mzigo na bonyeza "Nimepokea" kuthibitisha mapokezi.`
      ),
      createdBy: userId,
    }).catch(() => {});

    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: 'store_request_issued',
      entityType: 'store_request',
      entityId: id,
      shopId: store.id,
      details: { requestNumber: request.request_number, issuedTotal, shopId: request.shop_id, autoAppliedLines: appliedLines }
    }).catch(() => {});

    return c.json({ success: true, data: { issuedTotal, stockAppliedLines: appliedLines } });
  } catch (error: any) {
    if (inTransaction) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    console.error('[Store Issue] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/store/requests/:id/receive  (shop confirms pickup -> stock enters shop)
router.post('/requests/:id/receive', authMiddleware, requirePermission('store:request'), requireActiveSubscription, async (c: any) => {
  let inTransaction = false;
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const userRole = c.get('userRole') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];

    const requestRes = await readDb.read(`SELECT * FROM store_requests WHERE id = $1`, [id]);
    if (requestRes.rows.length === 0) return c.json({ success: false, error: 'Request not found' }, 404);
    const request = requestRes.rows[0];

    const shopId = body?.shopId || request.shop_id;
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
    }
    if (request.status === 'received') {
      return c.json({ success: false, error: 'Request already received' }, 400);
    }
    if (request.status !== 'issued') {
      return c.json({ success: false, error: 'Request has not been issued yet' }, 400);
    }

    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Shop';

    await pool.query('BEGIN');
    inTransaction = true;

    // Re-check under lock: the shop only confirms goods that the store issued.
    const lockRes = await pool.query(
      `SELECT status, stock_applied_at FROM store_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (lockRes.rows.length === 0) throw new Error('Request not found');
    if (lockRes.rows[0].status !== 'issued') throw new Error(`Request is already ${lockRes.rows[0].status}`);

    // Stock was already added when the store issued the goods — a legacy
    // request (issued before auto-apply) still gets it applied here.
    const stockAlreadyApplied = !!lockRes.rows[0].stock_applied_at;
    let appliedLines = 0;
    if (!stockAlreadyApplied) {
      const pendingItems = await pool.query(
        `SELECT * FROM store_request_items WHERE request_id = $1 AND issued_qty > 0 ORDER BY created_at FOR UPDATE`,
        [id]
      );
      appliedLines = await applyIssuedStockToShop(request, pendingItems.rows, userId);
    }

    await pool.query(
      `UPDATE store_requests
          SET status = 'received', received_by = $1, received_by_name = $2, received_at = NOW(),
              stock_applied_at = COALESCE(stock_applied_at, NOW()), updated_at = NOW()
        WHERE id = $3`,
      [userId, userName, id]
    );

    await pool.query('COMMIT');
    inTransaction = false;

    cache.invalidateByPrefix('products:shop');
    cache.invalidateByPrefix('products:');
    cache.invalidateByPrefix('stats:');
    cache.invalidateByPrefix('store:');

    // Tell the store team the shop confirmed pickup.
    const storeRes = await readDb.read(`SELECT name, tenant_id FROM shops WHERE id = $1`, [request.store_shop_id]);
    const storeName = storeRes.rows[0]?.name || 'Store';
    const recipients = await getRecipients(request.store_shop_id, storeRes.rows[0]?.tenant_id || request.tenant_id || null);
    notifyUsers(recipients, {
      tenantId: request.tenant_id || null,
      title: `Mzigo umepokelewa — ${request.request_number}`,
      message: `Duka limethibitisha kupokea mzigo kutoka ${storeName}. Stock ilikuwa imeongezwa kwenye duka wakati wa kutoa.`,
      actionUrl: '/store',
      emailSubject: `[ALFEAN ENTERPRISES] Mzigo umepokelewa (${request.request_number})`,
      emailHtml: emailShell(
        `Mzigo umepokelewa`,
        `<tr><td style="padding:6px 4px">Ombi</td><td style="padding:6px 4px;text-align:right">${request.request_number}</td></tr>
         <tr><td style="padding:6px 4px">Ghala</td><td style="padding:6px 4px;text-align:right">${storeName}</td></tr>`,
        `Rekodi imefungwa. Stock ilikuwa imeongezwa kwenye duka wakati wa kutoa.`
      ),
      createdBy: userId,
    }).catch(() => {});

    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: 'store_request_received',
      entityType: 'store_request',
      entityId: id,
      shopId: request.shop_id,
      details: { requestNumber: request.request_number, storeId: request.store_shop_id, lateAppliedLines: appliedLines }
    }).catch(() => {});

    return c.json({
      success: true,
      message: stockAlreadyApplied
        ? 'Receipt confirmed — stock was already added when the store issued the goods'
        : 'Stock received into the shop',
      data: { stockAppliedNow: !stockAlreadyApplied, appliedLines },
    });
  } catch (error: any) {
    if (inTransaction) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    console.error('[Store Receive Request] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/store/requests/:id/reject  (store says no, with a reason)
router.post('/requests/:id/reject', authMiddleware, requirePermission('store:manage'), requireActiveSubscription, async (c: any) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const requestRes = await readDb.read(`SELECT * FROM store_requests WHERE id = $1`, [id]);
    if (requestRes.rows.length === 0) return c.json({ success: false, error: 'Request not found' }, 404);
    const request = requestRes.rows[0];
    const store = await getStore(c, request.store_shop_id);
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);
    if (request.status !== 'pending') return c.json({ success: false, error: `Request is already ${request.status}` }, 400);

    await pool.query(
      `UPDATE store_requests SET status = 'rejected', reject_reason = $1, updated_at = NOW() WHERE id = $2`,
      [body?.reason || null, id]
    );

    const recipients = await getRecipients(request.shop_id, request.tenant_id || null);
    notifyUsers(recipients, {
      tenantId: request.tenant_id || null,
      title: `Ombi limekataliwa — ${request.request_number}`,
      message: `Ombi la mzigo limekataliwa na ${store.name}.${body?.reason ? ' Sababu: ' + body.reason : ''}`,
      actionUrl: '/store-request',
      emailSubject: `[ALFEAN ENTERPRISES] Ombi la mzigo limekataliwa (${request.request_number})`,
      emailHtml: emailShell(
        `Ombi limekataliwa`,
        `<tr><td style="padding:6px 4px">Ombi</td><td style="padding:6px 4px;text-align:right">${request.request_number}</td></tr>
         <tr><td style="padding:6px 4px">Sababu</td><td style="padding:6px 4px;text-align:right">${body?.reason || '-'}</td></tr>`,
        `Wasiliana na ghala kwa maelezo zaidi.`
      ),
      createdBy: c.get('userId') as string,
    }).catch(() => {});

    return c.json({ success: true, message: 'Request rejected' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/store/requests/:id/cancel  (shop cancels while still pending)
router.post('/requests/:id/cancel', authMiddleware, requirePermission('store:request'), async (c: any) => {
  try {
    const id = c.req.param('id');
    const userRole = c.get('userRole') as string;
    const shopIds = (c.get('shopIds') as string[]) || [];
    const requestRes = await readDb.read(`SELECT * FROM store_requests WHERE id = $1`, [id]);
    if (requestRes.rows.length === 0) return c.json({ success: false, error: 'Request not found' }, 404);
    const request = requestRes.rows[0];
    if (userRole !== 'developer' && !shopIds.includes(request.shop_id)) {
      return c.json({ success: false, error: 'You do not have access to this request' }, 403);
    }
    if (request.status !== 'pending') return c.json({ success: false, error: `Request is already ${request.status}` }, 400);

    await pool.query(`UPDATE store_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [id]);
    return c.json({ success: true, message: 'Request cancelled' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/store/report?storeId=&limit= -> stock value + movement records
router.get('/report', authMiddleware, requirePermission('store:read'), async (c: any) => {
  try {
    const store = await getStore(c, c.req.query('storeId') || '');
    if (!store) return c.json({ success: false, error: 'Store not found' }, 404);

    const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '100')));

    const [totalsRes, byProductRes, movementsRes] = await Promise.all([
      readDb.read(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'receive' THEN total_cost ELSE 0 END), 0) as received_value,
           COALESCE(SUM(CASE WHEN type = 'issue' THEN total_cost ELSE 0 END), 0) as issued_value,
           COUNT(CASE WHEN type = 'receive' THEN 1 END) as receive_count,
           COUNT(CASE WHEN type = 'issue' THEN 1 END) as issue_count
         FROM store_stock_movements WHERE store_shop_id = $1`,
        [store.id]
      ),
      readDb.read(
        `SELECT p.id, p.name, p.current_stock, p.buying_price, p.selling_price,
                (p.current_stock * p.buying_price) as stock_value,
                COALESCE((SELECT SUM(quantity) FROM store_stock_movements m WHERE m.product_id = p.id AND m.type = 'receive'), 0) as received_qty,
                COALESCE((SELECT SUM(-quantity) FROM store_stock_movements m WHERE m.product_id = p.id AND m.type = 'issue'), 0) as issued_qty
           FROM products p
          WHERE p.shop_id = $1 AND p.is_active = true
          ORDER BY stock_value DESC
          LIMIT 200`,
        [store.id]
      ),
      readDb.read(
        `SELECT m.*, s.name as shop_name
           FROM store_stock_movements m
           LEFT JOIN store_requests r ON r.id = m.reference_id AND m.reference_type = 'store_request'
           LEFT JOIN shops s ON s.id = r.shop_id
          WHERE m.store_shop_id = $1
          ORDER BY m.created_at DESC
          LIMIT ${limit}`,
        [store.id]
      ),
    ]);

    return c.json({
      success: true,
      data: {
        store: { id: store.id, name: store.name },
        totals: {
          receivedValue: parseFloat(totalsRes.rows[0].received_value) || 0,
          issuedValue: parseFloat(totalsRes.rows[0].issued_value) || 0,
          receiveCount: parseInt(totalsRes.rows[0].receive_count) || 0,
          issueCount: parseInt(totalsRes.rows[0].issue_count) || 0,
        },
        byProduct: byProductRes.rows.map((p: any) => ({
          id: p.id,
          name: p.name,
          currentStock: parseFloat(p.current_stock) || 0,
          buyingPrice: parseFloat(p.buying_price) || 0,
          sellingPrice: parseFloat(p.selling_price) || 0,
          stockValue: parseFloat(p.stock_value) || 0,
          receivedQty: parseFloat(p.received_qty) || 0,
          issuedQty: parseFloat(p.issued_qty) || 0,
        })),
        movements: movementsRes.rows,
      }
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ===========================================================================
// OWNER / ADMIN MONITOR — one place to see every store event across all shops
// ===========================================================================
//
// Requirement: the owner must see who requested what (and the store balance at
// request time), who issued it (store + person), who received it (shop +
// person, previous -> new stock) plus every goods-in (supplier), goods-out
// (destination shop), stock that came on credit (deni) and the physical count
// audit — all tenant-wide.
//
// GET /api/store/monitor           -> stats + unified event feed + notifications
// GET /api/store/monitor/reports   -> advanced store reports
// GET /api/store/monitor/audit     -> store activity-log audit trail
// ===========================================================================

// Every shop (and store) the caller may monitor. Tenant owners/admins get the
// whole tenant; developers get everything.
async function getMonitorScope(c: any) {
  const userRole = c.get('userRole') as string;
  const tenantId = (c.get('tenantId') as string) || null;
  const shopIds = (c.get('shopIds') as string[]) || [];

  let rows: any[] = [];
  if (userRole === 'developer') {
    rows = (await readDb.read(`SELECT id, name, type, tenant_id FROM shops ORDER BY created_at ASC`)).rows;
  } else if (tenantId) {
    rows = (await readDb.read(
      `SELECT id, name, type, tenant_id FROM shops
        WHERE tenant_id = $1 AND (is_super_admin IS NOT TRUE OR is_super_admin = FALSE)
        ORDER BY created_at ASC`,
      [tenantId]
    )).rows;
    if (rows.length === 0 && shopIds.length > 0) {
      rows = (await readDb.read(`SELECT id, name, type, tenant_id FROM shops WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC`, [shopIds])).rows;
    }
  } else if (shopIds.length > 0) {
    rows = (await readDb.read(`SELECT id, name, type, tenant_id FROM shops WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC`, [shopIds])).rows;
  }

  return {
    tenantId,
    shops: rows,
    allShopIds: rows.map((s: any) => s.id),
    storeIds: rows.filter((s: any) => s.type === 'store').map((s: any) => s.id),
    shopOnlyIds: rows.filter((s: any) => s.type !== 'store').map((s: any) => s.id),
  };
}

// Shared date window for the monitor endpoints. `to` is inclusive in the UI so
// it is expanded to the end of that day.
function monitorWindow(query: (k: string) => string | undefined) {
  const from = (query('from') || '').trim();
  const to = (query('to') || '').trim();
  return {
    fromTs: from ? `${from.slice(0, 10)} 00:00:00` : '1970-01-01 00:00:00',
    toTs: to ? `${to.slice(0, 10)} 23:59:59.999` : '9999-12-31 00:00:00',
  };
}

// The unified event feed: every store request (requested / issued / received),
// every goods-in receipt, every physical count and every stock adjustment at a
// store, normalised to one shape. $1 = store ids, $3/$4 = window, $5 = store
// filter, $6 = shop filter.
const MONITOR_UNION_SQL = `
  SELECT 'request'::text AS event_type, r.id AS event_id, r.created_at AS event_at,
         r.request_number::text AS reference, r.notes::text AS notes,
         st.id AS store_id, st.name::text AS store_name,
         sp.id AS shop_id, sp.name::text AS shop_name,
         r.created_by AS actor_id, r.created_by_name::text AS actor_name,
         (SELECT COUNT(*)::int FROM store_request_items ri WHERE ri.request_id = r.id) AS item_count,
         r.total_cost AS total_value, r.status::text AS status,
         jsonb_build_object('items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'product', ri.product_name, 'qty', ri.requested_qty, 'storeStock', ri.available_at_request,
             'issuedQty', ri.issued_qty, 'unitCost', ri.unit_cost) ORDER BY ri.created_at), '[]'::jsonb)
           FROM store_request_items ri WHERE ri.request_id = r.id)) AS detail
    FROM store_requests r
    JOIN shops st ON st.id = r.store_shop_id
    LEFT JOIN shops sp ON sp.id = r.shop_id
   WHERE r.store_shop_id = ANY($1::uuid[])
     AND r.created_at >= $3::timestamp AND r.created_at <= $4::timestamp
     AND (r.shop_id IS NULL OR r.shop_id = ANY($2::uuid[]))
     AND ($5::uuid IS NULL OR r.store_shop_id = $5::uuid)
     AND ($6::uuid IS NULL OR r.shop_id = $6::uuid)

  UNION ALL

  SELECT 'issue', r.id, r.issued_at, r.request_number,
         r.notes, st.id, st.name, sp.id, sp.name,
         r.issued_by, r.issued_by_name,
         (SELECT COUNT(*)::int FROM store_request_items ri WHERE ri.request_id = r.id AND ri.issued_qty > 0),
         r.total_cost, 'issued',
         jsonb_build_object('items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'product', ri.product_name, 'qty', ri.issued_qty, 'unitCost', ri.unit_cost) ORDER BY ri.created_at), '[]'::jsonb)
           FROM store_request_items ri WHERE ri.request_id = r.id AND ri.issued_qty > 0))
    FROM store_requests r
    JOIN shops st ON st.id = r.store_shop_id
    LEFT JOIN shops sp ON sp.id = r.shop_id
   WHERE r.store_shop_id = ANY($1::uuid[]) AND r.issued_at IS NOT NULL
     AND r.issued_at >= $3::timestamp AND r.issued_at <= $4::timestamp
     AND (r.shop_id IS NULL OR r.shop_id = ANY($2::uuid[]))
     AND ($5::uuid IS NULL OR r.store_shop_id = $5::uuid)
     AND ($6::uuid IS NULL OR r.shop_id = $6::uuid)

  UNION ALL

  SELECT 'receive', r.id, r.received_at, r.request_number,
         r.notes, st.id, st.name, sp.id, sp.name,
         r.received_by, r.received_by_name,
         (SELECT COUNT(*)::int FROM store_request_items ri WHERE ri.request_id = r.id AND ri.issued_qty > 0),
         r.total_cost, 'received',
         jsonb_build_object('items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'product', ri.product_name, 'qty', ri.issued_qty,
             'prevStock', sa.previous_quantity, 'newStock', sa.new_quantity) ORDER BY ri.created_at), '[]'::jsonb)
           FROM store_request_items ri
           LEFT JOIN LATERAL (
             SELECT x.previous_quantity, x.new_quantity
               FROM stock_adjustments x
               JOIN products px ON px.id = x.product_id
              WHERE x.reference_id = ri.request_id
                AND ((ri.barcode IS NOT NULL AND px.barcode = ri.barcode)
                     OR LOWER(px.name) = LOWER(ri.product_name))
              ORDER BY x.created_at DESC LIMIT 1
           ) sa ON TRUE
          WHERE ri.request_id = r.id AND ri.issued_qty > 0))
    FROM store_requests r
    JOIN shops st ON st.id = r.store_shop_id
    LEFT JOIN shops sp ON sp.id = r.shop_id
   WHERE r.store_shop_id = ANY($1::uuid[]) AND r.received_at IS NOT NULL
     AND r.received_at >= $3::timestamp AND r.received_at <= $4::timestamp
     AND (r.shop_id IS NULL OR r.shop_id = ANY($2::uuid[]))
     AND ($5::uuid IS NULL OR r.store_shop_id = $5::uuid)
     AND ($6::uuid IS NULL OR r.shop_id = $6::uuid)

  UNION ALL

  SELECT 'receipt', rc.id, rc.created_at, rc.receipt_number,
         rc.notes, st.id, st.name, NULL::uuid, NULL::text,
         rc.received_by, rc.received_by_name,
         (SELECT COUNT(*)::int FROM store_receipt_items rci WHERE rci.receipt_id = rc.id),
         rc.total_cost, COALESCE(rc.payment_status, 'paid'),
         jsonb_build_object('supplier', rc.supplier_name, 'paymentStatus', COALESCE(rc.payment_status, 'paid'),
             'amountPaid', COALESCE(rc.amount_paid, 0), 'dueDate', rc.due_date,
             'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'product', rci.product_name, 'qty', rci.quantity, 'unitCost', rci.unit_cost) ORDER BY rci.created_at), '[]'::jsonb)
               FROM store_receipt_items rci WHERE rci.receipt_id = rc.id))
    FROM store_receipts rc
    JOIN shops st ON st.id = rc.store_shop_id
   WHERE rc.store_shop_id = ANY($1::uuid[])
     AND rc.created_at >= $3::timestamp AND rc.created_at <= $4::timestamp
     AND ($5::uuid IS NULL OR rc.store_shop_id = $5::uuid)
     AND $6::uuid IS NULL

  UNION ALL

  SELECT 'stock_count', s.id, COALESCE(s.approved_at, s.ended_at, s.started_at), s.name,
         s.notes, st.id, st.name, NULL::uuid, NULL::text,
         s.started_by, COALESCE(NULLIF(u.name, ''), u.email),
         (SELECT COUNT(*)::int FROM stock_take_items sti WHERE sti.session_id = s.id AND COALESCE(sti.difference, 0) <> 0),
         (SELECT COALESCE(SUM(ABS(COALESCE(sti.difference, 0))), 0) FROM stock_take_items sti WHERE sti.session_id = s.id),
         s.status,
         jsonb_build_object('startedAt', s.started_at, 'endedAt', s.ended_at, 'approvedAt', s.approved_at,
             'difference', (SELECT COALESCE(SUM(sti.difference), 0) FROM stock_take_items sti WHERE sti.session_id = s.id),
             'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'product', p.name, 'system', sti.system_quantity, 'physical', sti.physical_quantity, 'difference', sti.difference)
                 ORDER BY ABS(COALESCE(sti.difference, 0)) DESC), '[]'::jsonb)
               FROM stock_take_items sti JOIN products p ON p.id = sti.product_id
              WHERE sti.session_id = s.id AND COALESCE(sti.difference, 0) <> 0))
    FROM stock_take_sessions s
    JOIN shops st ON st.id = s.shop_id
    LEFT JOIN "user" u ON u.id::text = s.started_by::text
   WHERE s.shop_id = ANY($1::uuid[])
     AND COALESCE(s.approved_at, s.ended_at, s.started_at) >= $3::timestamp
     AND COALESCE(s.approved_at, s.ended_at, s.started_at) <= $4::timestamp
     AND ($5::uuid IS NULL OR s.shop_id = $5::uuid)
     AND $6::uuid IS NULL

  UNION ALL

  SELECT 'adjustment', sa.id, sa.created_at, NULL::text,
         sa.notes, st.id, st.name, NULL::uuid, NULL::text,
         sa.created_by, COALESCE(NULLIF(u.name, ''), u.email),
         1, NULL::numeric, sa.adjustment_type::text,
         jsonb_build_object('product', p.name, 'previous', sa.previous_quantity, 'new', sa.new_quantity,
             'difference', sa.difference)
    FROM stock_adjustments sa
    JOIN shops st ON st.id = sa.shop_id
    LEFT JOIN "user" u ON u.id::text = sa.created_by::text
    LEFT JOIN products p ON p.id = sa.product_id
   WHERE sa.shop_id = ANY($1::uuid[])
     AND sa.created_at >= $3::timestamp AND sa.created_at <= $4::timestamp
     AND ($5::uuid IS NULL OR sa.shop_id = $5::uuid)
     AND $6::uuid IS NULL
`;

// GET /api/store/monitor -> owner/admin dashboard: tenant-wide stats, the
// unified event feed (who did what, where, with what stock before/after) and
// recent store notifications.
router.get('/monitor', authMiddleware, requireAnyPermission('store:read', 'report:read'), async (c: any) => {
  try {
    const scope = await getMonitorScope(c);
    const { fromTs, toTs } = monitorWindow((k) => c.req.query(k));
    const storeId = c.req.query('storeId') || null;
    const shopId = c.req.query('shopId') || null;
    const eventType = c.req.query('eventType') || null;
    const search = (c.req.query('search') || '').trim() || null;
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;

    const feedParams = [scope.storeIds, scope.allShopIds, fromTs, toTs, storeId, shopId, eventType, search];
    const whereSql = `
      WHERE ($7::text IS NULL OR ev.event_type = $7::text)
        AND ($8::text IS NULL OR
             COALESCE(ev.reference, '') ILIKE '%' || $8::text || '%' OR
             COALESCE(ev.actor_name, '') ILIKE '%' || $8::text || '%' OR
             COALESCE(ev.shop_name, '') ILIKE '%' || $8::text || '%' OR
             COALESCE(ev.store_name, '') ILIKE '%' || $8::text || '%' OR
             ev.detail::text ILIKE '%' || $8::text || '%')`;

    const [statsRes, eventsRes, countRes, notifRes] = await Promise.all([
      readDb.read(
        `SELECT
           (SELECT COUNT(*)::int FROM store_requests WHERE store_shop_id = ANY($1::uuid[]) AND status = 'pending') AS pending_requests,
           (SELECT COUNT(*)::int FROM store_requests WHERE store_shop_id = ANY($1::uuid[]) AND status = 'issued') AS awaiting_confirmation,
           (SELECT COUNT(*)::int FROM store_requests WHERE store_shop_id = ANY($1::uuid[]) AND created_at >= date_trunc('month', CURRENT_DATE)) AS requests_this_month,
           (SELECT COUNT(*)::int FROM store_requests WHERE store_shop_id = ANY($1::uuid[]) AND received_at >= date_trunc('month', CURRENT_DATE)) AS received_this_month,
           (SELECT COALESCE(SUM(total_cost), 0) FROM store_requests WHERE store_shop_id = ANY($1::uuid[]) AND issued_at >= date_trunc('month', CURRENT_DATE)) AS issued_value_month,
           (SELECT COALESCE(SUM(total_cost), 0) FROM store_receipts WHERE store_shop_id = ANY($1::uuid[]) AND created_at >= date_trunc('month', CURRENT_DATE)) AS received_value_month,
           (SELECT COALESCE(SUM(current_stock * buying_price), 0) FROM products WHERE shop_id = ANY($1::uuid[]) AND is_active = true) AS stock_value,
           (SELECT COALESCE(SUM(current_stock * selling_price), 0) FROM products WHERE shop_id = ANY($1::uuid[]) AND is_active = true) AS retail_value,
           (SELECT COUNT(*)::int FROM store_receipts WHERE store_shop_id = ANY($1::uuid[]) AND COALESCE(payment_status, 'paid') IN ('credit', 'partial')) AS credit_receipts,
           (SELECT COALESCE(SUM(GREATEST(total_cost - COALESCE(amount_paid, 0), 0)), 0) FROM store_receipts WHERE store_shop_id = ANY($1::uuid[]) AND COALESCE(payment_status, 'paid') IN ('credit', 'partial')) AS credit_receipts_value,
           (SELECT COUNT(*)::int FROM supplier_orders so WHERE so.shop_id = ANY($1::uuid[]) AND so.status <> 'cancelled' AND COALESCE(so.total_amount, 0) > COALESCE(so.paid_amount, 0)) AS supplier_credit_orders,
           (SELECT COALESCE(SUM(GREATEST(COALESCE(so.total_amount, 0) - COALESCE(so.paid_amount, 0), 0)), 0) FROM supplier_orders so WHERE so.shop_id = ANY($1::uuid[]) AND so.status <> 'cancelled') AS supplier_credit_value,
           (SELECT COUNT(*)::int FROM stock_take_sessions s WHERE s.shop_id = ANY($1::uuid[]) AND s.status IN ('in_progress', 'pending_approval')) AS active_counts`,
        [scope.storeIds]
      ),
      readDb.read(
        `SELECT * FROM (${MONITOR_UNION_SQL}) ev ${whereSql}
          ORDER BY ev.event_at DESC NULLS LAST
          LIMIT $9 OFFSET $10`,
        [...feedParams, limit, offset]
      ),
      readDb.read(`SELECT COUNT(*)::int AS total FROM (${MONITOR_UNION_SQL}) ev ${whereSql}`, feedParams),
      readDb.read(
        `SELECT n.id, n.title, n.message, n.type, n.action_url, n.is_read, n.created_at,
                COALESCE(NULLIF(u.name, ''), u.email) AS created_by_name
           FROM notifications n
           LEFT JOIN "user" u ON u.id = n.created_by
          WHERE n.type = 'store' AND ($1::uuid IS NULL OR n.tenant_id = $1::uuid)
          ORDER BY n.created_at DESC LIMIT 30`,
        [scope.tenantId]
      ),
    ]);

    const s = statsRes.rows[0] || {};
    const num = (v: any) => parseFloat(v) || 0;

    return c.json({
      success: true,
      data: {
        scope: {
          stores: scope.shops.filter((x: any) => x.type === 'store'),
          shops: scope.shops.filter((x: any) => x.type !== 'store'),
        },
        stats: {
          stores: scope.storeIds.length,
          shops: scope.shopOnlyIds.length,
          pendingRequests: parseInt(s.pending_requests) || 0,
          awaitingConfirmation: parseInt(s.awaiting_confirmation) || 0,
          requestsThisMonth: parseInt(s.requests_this_month) || 0,
          receivedThisMonth: parseInt(s.received_this_month) || 0,
          issuedValueMonth: num(s.issued_value_month),
          receivedValueMonth: num(s.received_value_month),
          stockValue: num(s.stock_value),
          retailValue: num(s.retail_value),
          creditReceipts: parseInt(s.credit_receipts) || 0,
          creditReceiptsValue: num(s.credit_receipts_value),
          supplierCreditOrders: parseInt(s.supplier_credit_orders) || 0,
          supplierCreditValue: num(s.supplier_credit_value),
          activeCounts: parseInt(s.active_counts) || 0,
        },
        events: eventsRes.rows,
        total: parseInt(countRes.rows[0]?.total) || 0,
        page,
        limit,
        notifications: notifRes.rows,
      },
    });
  } catch (error: any) {
    console.error('[Store Monitor] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/store/monitor/reports -> advanced store reports: goods in (and from
// which supplier), goods out (and to which shop), stock that came on credit
// (deni), stock value by store and the physical-count history.
router.get('/monitor/reports', authMiddleware, requireAnyPermission('store:read', 'report:read'), async (c: any) => {
  try {
    const scope = await getMonitorScope(c);
    const { fromTs, toTs } = monitorWindow((k) => c.req.query(k));
    const storeId = c.req.query('storeId') || null;
    const shopId = c.req.query('shopId') || null;
    const params = [scope.storeIds, fromTs, toTs, storeId, shopId];

    const [totalsRes, goodsInRes, goodsOutRes, byShopRes, bySupplierRes, creditRes, creditOrdersRes, countsRes, byStoreRes, adjustmentsRes] = await Promise.all([
      readDb.read(
        `SELECT
           (SELECT COALESCE(SUM(total_cost), 0) FROM store_receipts
             WHERE store_shop_id = ANY($1::uuid[]) AND created_at >= $2::timestamp AND created_at <= $3::timestamp
               AND ($4::uuid IS NULL OR store_shop_id = $4::uuid)) AS received_value,
           (SELECT COUNT(*)::int FROM store_receipts
             WHERE store_shop_id = ANY($1::uuid[]) AND created_at >= $2::timestamp AND created_at <= $3::timestamp
               AND ($4::uuid IS NULL OR store_shop_id = $4::uuid)) AS receipt_count,
           (SELECT COALESCE(SUM(total_cost), 0) FROM store_requests
             WHERE store_shop_id = ANY($1::uuid[]) AND issued_at >= $2::timestamp AND issued_at <= $3::timestamp
               AND ($4::uuid IS NULL OR store_shop_id = $4::uuid) AND ($5::uuid IS NULL OR shop_id = $5::uuid)) AS issued_value,
           (SELECT COUNT(*)::int FROM store_requests
             WHERE store_shop_id = ANY($1::uuid[]) AND issued_at >= $2::timestamp AND issued_at <= $3::timestamp
               AND ($4::uuid IS NULL OR store_shop_id = $4::uuid) AND ($5::uuid IS NULL OR shop_id = $5::uuid)) AS issue_count,
           (SELECT COALESCE(SUM(GREATEST(total_cost - COALESCE(amount_paid, 0), 0)), 0) FROM store_receipts
             WHERE store_shop_id = ANY($1::uuid[]) AND COALESCE(payment_status, 'paid') IN ('credit', 'partial')
               AND created_at >= $2::timestamp AND created_at <= $3::timestamp
               AND ($4::uuid IS NULL OR store_shop_id = $4::uuid)) AS credit_balance,
           (SELECT COUNT(*)::int FROM store_requests
             WHERE store_shop_id = ANY($1::uuid[]) AND status = 'pending') AS pending_requests,
           (SELECT COUNT(*)::int FROM store_requests
             WHERE store_shop_id = ANY($1::uuid[]) AND status = 'issued') AS awaiting_confirmation`,
        params
      ),
      readDb.read(
        `SELECT rc.id, rc.receipt_number, rc.created_at, rc.supplier_name, rc.received_by_name, rc.total_cost,
                COALESCE(rc.payment_status, 'paid') AS payment_status, COALESCE(rc.amount_paid, 0) AS amount_paid,
                GREATEST(rc.total_cost - COALESCE(rc.amount_paid, 0), 0) AS balance, rc.due_date, rc.notes,
                st.id AS store_id, st.name AS store_name,
                COALESCE(json_agg(json_build_object('product', rci.product_name, 'qty', rci.quantity,
                  'unitCost', rci.unit_cost, 'totalCost', rci.total_cost) ORDER BY rci.created_at)
                  FILTER (WHERE rci.id IS NOT NULL), '[]') AS items
           FROM store_receipts rc
           JOIN shops st ON st.id = rc.store_shop_id
           LEFT JOIN store_receipt_items rci ON rci.receipt_id = rc.id
          WHERE rc.store_shop_id = ANY($1::uuid[]) AND rc.created_at >= $2::timestamp AND rc.created_at <= $3::timestamp
            AND ($4::uuid IS NULL OR rc.store_shop_id = $4::uuid)
          GROUP BY rc.id, st.id
          ORDER BY rc.created_at DESC LIMIT 200`,
        [scope.storeIds, fromTs, toTs, storeId]
      ),
      readDb.read(
        `SELECT m.id, m.created_at, m.product_name, m.quantity, m.unit_cost, m.total_cost, m.created_by_name,
                st.id AS store_id, st.name AS store_name, sh.id AS shop_id, sh.name AS shop_name, r.request_number
           FROM store_stock_movements m
           JOIN shops st ON st.id = m.store_shop_id
           LEFT JOIN store_requests r ON r.id = m.reference_id AND m.reference_type = 'store_request'
           LEFT JOIN shops sh ON sh.id = r.shop_id
          WHERE m.type = 'issue' AND m.store_shop_id = ANY($1::uuid[])
            AND m.created_at >= $2::timestamp AND m.created_at <= $3::timestamp
            AND ($4::uuid IS NULL OR m.store_shop_id = $4::uuid)
            AND ($5::uuid IS NULL OR sh.id = $5::uuid)
          ORDER BY m.created_at DESC LIMIT 500`,
        params
      ),
      readDb.read(
        `SELECT sh.id, sh.name, COUNT(DISTINCT r.id)::int AS issues,
                COALESCE(SUM(-m.quantity), 0) AS qty, COALESCE(SUM(m.total_cost), 0) AS value,
                MAX(m.created_at) AS last_issue_at
           FROM store_stock_movements m
           JOIN store_requests r ON r.id = m.reference_id AND m.reference_type = 'store_request'
           JOIN shops sh ON sh.id = r.shop_id
          WHERE m.type = 'issue' AND m.store_shop_id = ANY($1::uuid[])
            AND m.created_at >= $2::timestamp AND m.created_at <= $3::timestamp
            AND ($4::uuid IS NULL OR m.store_shop_id = $4::uuid)
          GROUP BY sh.id, sh.name
          ORDER BY value DESC`,
        [scope.storeIds, fromTs, toTs, storeId]
      ),
      readDb.read(
        `SELECT COALESCE(rc.supplier_name, '—') AS supplier,
                COUNT(*)::int AS receipts, COALESCE(SUM(rc.total_cost), 0) AS value,
                COALESCE(SUM(CASE WHEN COALESCE(rc.payment_status, 'paid') IN ('credit', 'partial')
                  THEN GREATEST(rc.total_cost - COALESCE(rc.amount_paid, 0), 0) ELSE 0 END), 0) AS balance,
                MAX(rc.created_at) AS last_receipt_at
           FROM store_receipts rc
          WHERE rc.store_shop_id = ANY($1::uuid[]) AND rc.created_at >= $2::timestamp AND rc.created_at <= $3::timestamp
            AND ($4::uuid IS NULL OR rc.store_shop_id = $4::uuid)
          GROUP BY COALESCE(rc.supplier_name, '—')
          ORDER BY value DESC`,
        [scope.storeIds, fromTs, toTs, storeId]
      ),
      readDb.read(
        `SELECT rc.id, rc.receipt_number, rc.created_at, rc.supplier_name, rc.total_cost,
                COALESCE(rc.amount_paid, 0) AS amount_paid,
                GREATEST(rc.total_cost - COALESCE(rc.amount_paid, 0), 0) AS balance,
                rc.due_date, COALESCE(rc.payment_status, 'paid') AS payment_status, rc.notes,
                st.id AS store_id, st.name AS store_name, rc.received_by_name
           FROM store_receipts rc
           JOIN shops st ON st.id = rc.store_shop_id
          WHERE rc.store_shop_id = ANY($1::uuid[]) AND COALESCE(rc.payment_status, 'paid') IN ('credit', 'partial')
            AND rc.created_at >= $2::timestamp AND rc.created_at <= $3::timestamp
            AND ($4::uuid IS NULL OR rc.store_shop_id = $4::uuid)
          ORDER BY rc.created_at DESC LIMIT 200`,
        [scope.storeIds, fromTs, toTs, storeId]
      ),
      readDb.read(
        `SELECT so.id, so.order_number, so.status, so.total_amount, so.paid_amount,
                GREATEST(COALESCE(so.total_amount, 0) - COALESCE(so.paid_amount, 0), 0) AS balance,
                so.due_date, so.order_date, s.name AS supplier_name, st.id AS store_id, st.name AS store_name
           FROM supplier_orders so
           JOIN suppliers s ON s.id = so.supplier_id
           JOIN shops st ON st.id = so.shop_id
          WHERE so.shop_id = ANY($1::uuid[]) AND so.status <> 'cancelled'
            AND COALESCE(so.total_amount, 0) > COALESCE(so.paid_amount, 0)
          ORDER BY so.due_date NULLS LAST, so.order_date DESC LIMIT 200`,
        [scope.storeIds]
      ),
      readDb.read(
        `SELECT s.id, s.name, s.status, s.started_at, s.ended_at, s.approved_at,
                COALESCE(NULLIF(u.name, ''), u.email) AS started_by_name,
                st.id AS store_id, st.name AS store_name,
                (SELECT COUNT(*)::int FROM stock_take_items sti WHERE sti.session_id = s.id) AS item_count,
                (SELECT COUNT(*)::int FROM stock_take_items sti WHERE sti.session_id = s.id AND COALESCE(sti.difference, 0) <> 0) AS diff_count,
                (SELECT COALESCE(SUM(sti.difference), 0) FROM stock_take_items sti WHERE sti.session_id = s.id) AS net_difference
           FROM stock_take_sessions s
           JOIN shops st ON st.id = s.shop_id
           LEFT JOIN "user" u ON u.id::text = s.started_by::text
          WHERE s.shop_id = ANY($1::uuid[])
            AND COALESCE(s.approved_at, s.ended_at, s.started_at) >= $2::timestamp
            AND COALESCE(s.approved_at, s.ended_at, s.started_at) <= $3::timestamp
            AND ($4::uuid IS NULL OR s.shop_id = $4::uuid)
          ORDER BY COALESCE(s.approved_at, s.ended_at, s.started_at) DESC LIMIT 100`,
        [scope.storeIds, fromTs, toTs, storeId]
      ),
      readDb.read(
        `SELECT st.id, st.name, COUNT(p.id)::int AS products,
                COALESCE(SUM(p.current_stock * p.buying_price), 0) AS stock_value,
                COALESCE(SUM(p.current_stock * p.selling_price), 0) AS retail_value,
                COALESCE(SUM(p.current_stock), 0) AS units
           FROM shops st
           LEFT JOIN products p ON p.shop_id = st.id AND p.is_active = true
          WHERE st.id = ANY($1::uuid[])
          GROUP BY st.id, st.name
          ORDER BY stock_value DESC`,
        [scope.storeIds]
      ),
      readDb.read(
        `SELECT sa.id, sa.created_at, sa.adjustment_type, sa.previous_quantity, sa.new_quantity,
                sa.difference, sa.notes, COALESCE(NULLIF(u.name, ''), u.email) AS created_by_name,
                p.name AS product_name, st.name AS store_name
           FROM stock_adjustments sa
           JOIN shops st ON st.id = sa.shop_id
           LEFT JOIN products p ON p.id = sa.product_id
           LEFT JOIN "user" u ON u.id::text = sa.created_by::text
          WHERE sa.shop_id = ANY($1::uuid[])
            AND sa.created_at >= $2::timestamp AND sa.created_at <= $3::timestamp
            AND ($4::uuid IS NULL OR sa.shop_id = $4::uuid)
          ORDER BY sa.created_at DESC LIMIT 200`,
        [scope.storeIds, fromTs, toTs, storeId]
      ),
    ]);

    const t = totalsRes.rows[0] || {};
    const num = (v: any) => parseFloat(v) || 0;

    return c.json({
      success: true,
      data: {
        window: { from: fromTs, to: toTs },
        totals: {
          receivedValue: num(t.received_value),
          receiptCount: parseInt(t.receipt_count) || 0,
          issuedValue: num(t.issued_value),
          issueCount: parseInt(t.issue_count) || 0,
          creditBalance: num(t.credit_balance),
          pendingRequests: parseInt(t.pending_requests) || 0,
          awaitingConfirmation: parseInt(t.awaiting_confirmation) || 0,
        },
        goodsIn: goodsInRes.rows,
        goodsOut: goodsOutRes.rows,
        byShop: byShopRes.rows,
        bySupplier: bySupplierRes.rows,
        creditReceipts: creditRes.rows,
        creditOrders: creditOrdersRes.rows,
        counts: countsRes.rows,
        byStore: byStoreRes.rows,
        adjustments: adjustmentsRes.rows,
      },
    });
  } catch (error: any) {
    console.error('[Store Monitor Reports] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/store/monitor/audit -> the store module's activity-log trail for the
// whole tenant (who did what, from which shop).
router.get('/monitor/audit', authMiddleware, requireAnyPermission('store:read', 'report:read'), async (c: any) => {
  try {
    const scope = await getMonitorScope(c);
    const action = c.req.query('action') || null;
    const search = (c.req.query('search') || '').trim() || null;
    const storeId = c.req.query('storeId') || null;
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;
    const { fromTs, toTs } = monitorWindow((k) => c.req.query(k));

    const whereSql = `
      WHERE al.shop_id = ANY($1::uuid[])
        AND (al.action LIKE 'store%' OR al.action LIKE 'stock_take%' OR al.action LIKE 'supplier%')
        AND ($2::text IS NULL OR al.action = $2::text)
        AND ($6::uuid IS NULL OR al.shop_id = $6::uuid)
        AND ($3::text IS NULL OR al.user_name ILIKE '%' || $3::text || '%' OR al.user_email ILIKE '%' || $3::text || '%'
             OR al.action ILIKE '%' || $3::text || '%' OR al.details::text ILIKE '%' || $3::text || '%')
        AND al.created_at >= $4::timestamp AND al.created_at <= $5::timestamp`;
    const params = [scope.allShopIds, action, search, fromTs, toTs, storeId];

    const [rowsRes, countRes, actionsRes] = await Promise.all([
      readDb.read(
        `SELECT al.id, al.action, al.entity_type, al.entity_id, al.details, al.user_id, al.user_name,
                al.user_email, al.shop_id, al.created_at,
                s.name AS shop_name, s.type AS shop_type
           FROM activity_logs al
           LEFT JOIN shops s ON s.id = al.shop_id
           ${whereSql}
          ORDER BY al.created_at DESC
          LIMIT $7 OFFSET $8`,
        [...params, limit, offset]
      ),
      readDb.read(
        `SELECT COUNT(*)::int AS total FROM activity_logs al ${whereSql}`,
        params
      ),
      readDb.read(
        `SELECT DISTINCT action FROM activity_logs
          WHERE shop_id = ANY($1::uuid[])
            AND (action LIKE 'store%' OR action LIKE 'stock_take%' OR action LIKE 'supplier%')
          ORDER BY action`,
        [scope.allShopIds]
      ),
    ]);

    return c.json({
      success: true,
      data: {
        logs: rowsRes.rows,
        total: parseInt(countRes.rows[0]?.total) || 0,
        page,
        limit,
        actions: actionsRes.rows.map((r: any) => r.action),
      },
    });
  } catch (error: any) {
    console.error('[Store Monitor Audit] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
