// =====================================================
// RECEIPTS MODULE — professional thermal receipts
// =====================================================
// Every sale gets a unique receipt number (per shop + month, e.g.
// JB-202609-000125) plus a public verification token that powers the
// /r/<token> receipt page (shareable by link, no QR printed on the receipt).
// The receipt payload carries everything a thermal receipt needs: shop
// branding (header + footer), items, totals, VAT breakdown, payment details,
// the shop's printer/receipt settings and the print/reprint audit trail.
//
// GET    /api/receipts/settings?shopId=   receipt/printer settings (per shop)
// PUT    /api/receipts/settings           save receipt/printer settings
// GET    /api/receipts/:saleId            full receipt payload
// POST   /api/receipts/:saleId/printed    record a print (reprint tracking)
// =====================================================

import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import { db as readDb } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission, hasPermission, isFullAccessRole } from '../../middleware/rbac.middleware.js';
import { logActivity } from '../../utils/activity-logger.js';

const router = new Hono();

export const DEFAULT_RECEIPT_SETTINGS = {
  paperSize: '80',            // '58' | '80'
  copies: 1,
  showLogo: true,
  showBusinessName: true,
  showAddress: true,
  showPhone: true,
  showEmail: false,
  showTin: true,
  showVrn: true,
  showSerial: false,
  showCashier: true,
  showCustomer: true,
  showCustomerPhone: true,
  showDiscount: true,
  showPaymentMethod: true,
  showTax: false,
  taxRate: 18,
  showFooter: true,
  showPoweredBy: true,
  headerText: '',             // extra line under the shop header
  footerText: 'Asante kwa kununua. Karibu tena!',
  website: '',
  social: '',
};

export async function getReceiptSettings(shopId: string) {
  const r = await readDb.read(
    `SELECT value FROM settings WHERE key = 'receipt' AND shop_id = $1 LIMIT 1`,
    [shopId]
  );
  if (r.rows.length === 0) return { ...DEFAULT_RECEIPT_SETTINGS };
  const value = typeof r.rows[0].value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0].value;
  const merged = { ...DEFAULT_RECEIPT_SETTINGS, ...(value || {}) };
  merged.paperSize = merged.paperSize === '58' ? '58' : '80';
  merged.copies = Math.min(5, Math.max(1, parseInt(merged.copies) || 1));
  merged.taxRate = Math.max(0, Math.min(100, parseFloat(merged.taxRate) || 0));
  return merged;
}

export async function saveReceiptSettings(shopId: string, patch: any) {
  const current = await getReceiptSettings(shopId);
  const merged = { ...current, ...(patch || {}) };
  await pool.query(`DELETE FROM settings WHERE key = 'receipt' AND shop_id = $1`, [shopId]);
  await pool.query(
    `INSERT INTO settings (key, value, shop_id) VALUES ('receipt', $1, $2)`,
    [JSON.stringify(merged), shopId]
  );
  return merged;
}

// Resolve the shop the caller acts on (explicit shopId or their first shop).
function resolveShopId(c: any): string | null {
  const shopIds = (c.get('shopIds') as string[]) || [];
  const userRole = c.get('userRole') as string;
  let shopId = c.req.query('shopId') || null;
  if (!shopId && shopIds.length === 1) shopId = shopIds[0];
  if (!shopId) return null;
  if (userRole !== 'developer' && !shopIds.includes(shopId)) return null;
  return shopId;
}

function baseUrl() {
  const raw = process.env.APP_URL || process.env.BASE_URL || 'http://127.0.0.1:47831';
  return raw.replace(/\/+$/, '');
}

// Sellers may only touch receipts of shops they belong to; owners/admins may
// touch any sale of their tenant; developers everything.
async function canAccessSale(c: any, shopId: string): Promise<boolean> {
  const userRole = c.get('userRole') as string;
  const shopIds = (c.get('shopIds') as string[]) || [];
  const tenantId = (c.get('tenantId') as string) || null;
  if (userRole === 'developer') return true;
  if (shopIds.includes(shopId)) return true;
  if (isFullAccessRole(userRole, (c.get('user') as any)?.email) && tenantId) {
    const r = await readDb.read(`SELECT tenant_id FROM shops WHERE id = $1`, [shopId]);
    return !!r.rows[0]?.tenant_id && String(r.rows[0].tenant_id) === String(tenantId);
  }
  return false;
}

// Lazily allocate the receipt number + public token for a sale. Old sales that
// were created before the receipt engine existed get their number on first
// access; the unique index keeps everything consistent.
export async function ensureReceiptArtifacts(sale: any) {
  let receiptNumber: string | null = sale.receipt_number || null;
  let token: string | null = sale.receipt_token || null;

  if (!receiptNumber) {
    const shopRes = await readDb.read(`SELECT code, name FROM shops WHERE id = $1`, [sale.shop_id]);
    const shop = shopRes.rows[0] || {};
    const prefix = String(shop.code || shop.name || 'ALFEAN ENTERPRISES')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 14) || 'ALFEAN ENTERPRISES';
    const d = new Date(sale.created_at || Date.now());
    const period = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const counter = await pool.query(
      `INSERT INTO receipt_counters (shop_id, period, last_number, updated_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (shop_id, period)
       DO UPDATE SET last_number = receipt_counters.last_number + 1, updated_at = NOW()
       RETURNING last_number`,
      [sale.shop_id, period]
    );
    const sequence = parseInt(counter.rows[0]?.last_number) || 1;
    receiptNumber = `${prefix}-${period}-${String(sequence).padStart(6, '0')}`;
    await pool.query(
      `UPDATE sales SET receipt_number = $1 WHERE id = $2 AND receipt_number IS NULL`,
      [receiptNumber, sale.id]
    );
    // A concurrent request may have won the race — read the stored value back.
    const check = await readDb.read(`SELECT receipt_number FROM sales WHERE id = $1`, [sale.id]);
    receiptNumber = check.rows[0]?.receipt_number || receiptNumber;
  }

  if (!token) {
    token = randomBytes(12).toString('hex');
    await pool.query(
      `UPDATE sales SET receipt_token = $1 WHERE id = $2 AND receipt_token IS NULL`,
      [token, sale.id]
    );
    const check = await readDb.read(`SELECT receipt_token FROM sales WHERE id = $1`, [sale.id]);
    token = check.rows[0]?.receipt_token || token;
  }

  return { receiptNumber: receiptNumber as string, token: token as string };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// GET /api/receipts/settings?shopId= -> the shop's receipt/printer settings.
router.get('/settings', authMiddleware, async (c: any) => {
  try {
    const shopId = resolveShopId(c);
    if (!shopId) return c.json({ success: false, error: 'Select a shop first' }, 400);
    const settings = await getReceiptSettings(shopId);
    return c.json({ success: true, data: { settings } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// PUT /api/receipts/settings -> save receipt/printer settings for a shop.
router.put('/settings', authMiddleware, requirePermission('settings:update'), async (c: any) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = body?.shopId || resolveShopId(c);
    const shopIds = (c.get('shopIds') as string[]) || [];
    const userRole = c.get('userRole') as string;
    if (!shopId) return c.json({ success: false, error: 'shopId is required' }, 400);
    if (userRole !== 'developer' && !shopIds.includes(shopId)) {
      return c.json({ success: false, error: 'You do not have access to this shop' }, 403);
    }

    const settings = await saveReceiptSettings(shopId, body?.settings || {});
    const user = c.get('user') as any;
    logActivity({
      userId: c.get('userId'),
      userName: user?.name || user?.email || 'Unknown',
      userEmail: user?.email || '',
      action: 'receipt_settings_updated',
      entityType: 'shop',
      entityId: shopId,
      shopId,
      details: { paperSize: settings.paperSize, copies: settings.copies },
    }).catch(() => {});

    return c.json({ success: true, data: { settings } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Receipt payload + print tracking
// ---------------------------------------------------------------------------

// GET /api/receipts/:saleId -> everything needed to render a thermal receipt.
router.get('/:saleId', authMiddleware, async (c: any) => {
  try {
    const saleId = c.req.param('saleId');
    const userRole = c.get('userRole') as string;
    const userId = c.get('userId') as string;
    const userEmail = (c.get('user') as any)?.email;

    const saleRes = await readDb.read(
      `SELECT s.*, COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.name, u.email) AS seller_name
         FROM sales s
         LEFT JOIN "user" u ON u.id::text = s.seller_id::text
        WHERE s.id = $1`,
      [saleId]
    );
    if (saleRes.rows.length === 0) return c.json({ success: false, error: 'Sale not found' }, 404);
    const sale = saleRes.rows[0];

    // Sellers may only fetch receipts for their own shops (per-shop aware).
    if (!(await canAccessSale(c, sale.shop_id))) {
      return c.json({ success: false, error: 'You do not have access to this sale' }, 403);
    }
    if (userRole !== 'developer' && !(await hasPermission(userId, userRole, sale.shop_id, 'sale:read', userEmail))) {
      return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
    }

    const [shopRes, itemsRes, paymentsRes, settings] = await Promise.all([
      readDb.read(`SELECT * FROM shops WHERE id = $1`, [sale.shop_id]),
      readDb.read(
        `SELECT id, product_name, quantity, unit_type, unit_price, discount, total_price, dimension_label
           FROM sale_items WHERE sale_id = $1 ORDER BY created_at ASC, id ASC`,
        [saleId]
      ),
      readDb.read(
        `SELECT amount, payment_method, payment_reference, notes, created_at
           FROM invoice_payments WHERE sale_id = $1 ORDER BY created_at ASC`,
        [saleId]
      ).catch(() => ({ rows: [] })),
      getReceiptSettings(sale.shop_id),
    ]);

    const shop = shopRes.rows[0] || {};
    const { receiptNumber, token } = await ensureReceiptArtifacts(sale);

    const items = itemsRes.rows.map((it: any) => {
      const qty = parseFloat(it.quantity) || 0;
      const unitPrice = parseFloat(it.unit_price) || 0;
      return {
        name: it.product_name,
        quantity: qty,
        unitType: it.unit_type || '',
        dimensionLabel: it.dimension_label || '',
        unitPrice,
        discount: parseFloat(it.discount) || 0,
        lineGross: qty * unitPrice,
        total: parseFloat(it.total_price) || 0,
      };
    });

    const subtotal = items.reduce((sum: number, it: any) => sum + it.lineGross, 0);
    const total = parseFloat(sale.total_amount) || 0;
    const discountTotal = Math.max(0, subtotal - total);
    const amountPaid = parseFloat(sale.amount_paid) || 0;
    const balanceDue = Math.max(0, total - amountPaid);

    // VAT breakdown is display-only: prices carry VAT (TZ retail norm), so the
    // net and VAT portions are derived from the charged total.
    const taxRate = settings.showTax ? settings.taxRate || 0 : 0;
    const vatAmount = taxRate > 0 ? total - (total / (1 + taxRate / 100)) : 0;
    const netOfTax = total - vatAmount;

    const payments = paymentsRes.rows.map((p: any) => ({
      amount: parseFloat(p.amount) || 0,
      method: p.payment_method || 'cash',
      reference: p.payment_reference || '',
      notes: p.notes || '',
      createdAt: p.created_at,
    }));

    return c.json({
      success: true,
      data: {
        receipt: {
          receiptNumber,
          token,
          verificationUrl: `${baseUrl()}/r/${token}`,
          sale: {
            id: sale.id,
            createdAt: sale.created_at,
            sellerName: sale.seller_name || null,
            paymentMethod: sale.payment_method,
            paymentStatus: sale.payment_status || null,
            paymentReference: sale.payment_reference || '',
            bankName: sale.bank_name || '',
            saleType: sale.sale_type || 'normal',
            source: sale.source || 'pos',
            amountPaid,
            changeDue: parseFloat(sale.change_due) || 0,
            customerName: sale.customer_name || '',
            customerPhone: sale.customer_phone || '',
            customerEmail: sale.customer_email || '',
            customerCompany: sale.customer_company || '',
            customerAddress: sale.customer_address || '',
            customerTin: sale.customer_tin || '',
            customerVrn: sale.customer_vrn || '',
            dueDate: sale.due_date || null,
            notes: sale.notes || '',
          },
          items,
          totals: {
            subtotal,
            discount: discountTotal,
            total,
            amountPaid,
            balanceDue,
            taxRate,
            netOfTax,
            vatAmount,
          },
          payments,
          shop: {
            id: shop.id,
            name: shop.name || '',
            businessName: shop.business_name || shop.name || '',
            branchName: shop.branch_name || '',
            address: shop.address || '',
            phone: shop.phone || '',
            email: shop.email || '',
            logo: shop.logo || '',
            invoiceFooter: shop.invoice_footer || '',
            tinNumber: shop.tin_number || '',
            vrnNumber: shop.vrn_number || '',
            serialNumber: shop.serial_number || '',
          },
          settings,
          print: {
            printCount: parseInt(sale.print_count) || 0,
            printedAt: sale.printed_at || null,
            lastPrintedBy: sale.last_printed_by || null,
          },
        },
      },
    });
  } catch (error: any) {
    console.error('[Receipts] Error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/receipts/:saleId/printed -> record a print/reprint for audit.
router.post('/:saleId/printed', authMiddleware, async (c: any) => {
  try {
    const saleId = c.req.param('saleId');
    const userRole = c.get('userRole') as string;
    const userId = c.get('userId') as string;
    const user = c.get('user') as any;
    const userName = user?.name || user?.email || 'Unknown';

    const saleRes = await readDb.read(`SELECT id, shop_id, receipt_number, print_count FROM sales WHERE id = $1`, [saleId]);
    if (saleRes.rows.length === 0) return c.json({ success: false, error: 'Sale not found' }, 404);
    const sale = saleRes.rows[0];

    if (!(await canAccessSale(c, sale.shop_id))) {
      return c.json({ success: false, error: 'You do not have access to this sale' }, 403);
    }
    if (userRole !== 'developer' && !(await hasPermission(userId, userRole, sale.shop_id, 'sale:read', user?.email))) {
      return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
    }

    const result = await pool.query(
      `UPDATE sales
          SET print_count = COALESCE(print_count, 0) + 1, printed_at = NOW(), last_printed_by = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING print_count, receipt_number`,
      [userName, saleId]
    );
    const printCount = parseInt(result.rows[0]?.print_count) || 1;
    const receiptNumber = result.rows[0]?.receipt_number || sale.receipt_number;

    logActivity({
      userId,
      userName,
      userEmail: user?.email || '',
      action: printCount > 1 ? 'receipt_reprinted' : 'receipt_printed',
      entityType: 'sale',
      entityId: saleId,
      shopId: sale.shop_id,
      details: { receiptNumber, printCount },
    }).catch(() => {});

    return c.json({ success: true, data: { printCount, isReprint: printCount > 1, receiptNumber } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
