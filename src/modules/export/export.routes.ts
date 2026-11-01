import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();

// =====================================================
// EXPORT HELPERS
// =====================================================

function toCSV(headers: string[], rows: Record<string, any>[]): string {
  const escape = (val: any) => {
    const str = val == null ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const headerLine = headers.join(',');
  const dataLines = rows.map(row => headers.map(h => escape(row[h])).join(','));
  return [headerLine, ...dataLines].join('\n');
}

function toExcelCSV(headers: string[], rows: Record<string, any>[]): string {
  return toCSV(headers, rows);
}

function toJSON(rows: Record<string, any>[]): string {
  return JSON.stringify(rows, null, 2);
}

function getExportResponse(c: any, headers: string[], rows: Record<string, any>[], format: string, filename: string) {
  let content: string;
  let contentType: string;
  let ext: string;

  switch (format) {
    case 'csv':
      content = toCSV(headers, rows);
      contentType = 'text/csv';
      ext = 'csv';
      break;
    case 'excel':
      content = '\uFEFF' + toExcelCSV(headers, rows);
      contentType = 'application/vnd.ms-excel';
      ext = 'xls';
      break;
    case 'json':
      content = toJSON(rows);
      contentType = 'application/json';
      ext = 'json';
      break;
    default:
      return c.json({ success: false, error: 'Unsupported format. Use csv, excel, or json.' }, 400);
  }

  c.header('Content-Type', `${contentType}; charset=utf-8`);
  c.header('Content-Disposition', `attachment; filename="${filename}.${ext}"`);
  return c.body(content);
}

function getShopFilter(userRole: string, shopIds: string[], tenantId: string): { clause: string; params: any[] } {
  if (userRole === 'developer') {
    return { clause: '', params: [] };
  }
  if (shopIds && shopIds.length > 0) {
    return { clause: 'AND shop_id = ANY($1)', params: [shopIds] };
  }
  if (tenantId) {
    return { clause: 'AND tenant_id = $1', params: [tenantId] };
  }
  return { clause: '', params: [] };
}

// =====================================================
// EXPORT SALES
// =====================================================
router.get('/sales', authMiddleware, requirePermission('sale:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT s.id, s.total_amount, s.payment_method, s.amount_paid, s.change_due,
             s.discount_amount, s.customer_name, s.customer_phone,
             u.email as seller_email, s.created_at
      FROM sales s
      LEFT JOIN "user" u ON s.seller_id = u.id
      WHERE 1=1 ${shopClause}
      ORDER BY s.created_at DESC
      LIMIT 10000
    `, queryParams);

    const headers = [
      'Sale ID', 'Total Amount', 'Payment Method', 'Amount Paid',
      'Change Due', 'Discount', 'Customer Name', 'Customer Phone',
      'Seller', 'Date'
    ];

    const rows = result.rows.map(r => ({
      'Sale ID': r.id,
      'Total Amount': r.total_amount,
      'Payment Method': r.payment_method,
      'Amount Paid': r.amount_paid,
      'Change Due': r.change_due,
      'Discount': r.discount_amount,
      'Customer Name': r.customer_name || '',
      'Customer Phone': r.customer_phone || '',
      'Seller': r.seller_email || '',
      'Date': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `sales_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT PRODUCTS
// =====================================================
router.get('/products', authMiddleware, requirePermission('product:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT p.id, p.name, p.barcode, p.category_id, c.name as category_name,
             p.buying_price, p.selling_price, p.current_stock, p.low_stock_threshold,
             p.enable_fractions, p.is_active, p.created_at
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_active = true ${shopClause}
      ORDER BY p.name
      LIMIT 10000
    `, queryParams);

    const headers = [
      'Product ID', 'Name', 'Barcode', 'Category', 'Buying Price',
      'Selling Price', 'Current Stock', 'Low Stock Threshold',
      'Fractions Enabled', 'Active', 'Created At'
    ];

    const rows = result.rows.map(r => ({
      'Product ID': r.id,
      'Name': r.name,
      'Barcode': r.barcode || '',
      'Category': r.category_name || '',
      'Buying Price': r.buying_price,
      'Selling Price': r.selling_price,
      'Current Stock': r.current_stock,
      'Low Stock Threshold': r.low_stock_threshold,
      'Fractions Enabled': r.enable_fractions ? 'Yes' : 'No',
      'Active': 'Yes',
      'Created At': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `products_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT EXPENSES
// =====================================================
router.get('/expenses', authMiddleware, requirePermission('expense:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT e.id, e.description, e.amount, e.category, e.date,
             u.email as created_by, e.created_at
      FROM expenses e
      LEFT JOIN "user" u ON e.created_by = u.id
      WHERE 1=1 ${shopClause}
      ORDER BY e.date DESC
      LIMIT 10000
    `, queryParams);

    const headers = [
      'Expense ID', 'Description', 'Amount', 'Category',
      'Date', 'Created By', 'Created At'
    ];

    const rows = result.rows.map(r => ({
      'Expense ID': r.id,
      'Description': r.description,
      'Amount': r.amount,
      'Category': r.category || '',
      'Date': new Date(r.date).toLocaleDateString(),
      'Created By': r.created_by || '',
      'Created At': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `expenses_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT DEBTS
// =====================================================
router.get('/debts', authMiddleware, requirePermission('sale:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT d.id, d.customer_name as name, d.customer_phone as phone, d.total_amount, d.paid_amount,
             d.status, d.created_at
      FROM debtors d
      WHERE 1=1 ${shopClause}
      ORDER BY d.created_at DESC
      LIMIT 10000
    `, queryParams);

    const headers = [
      'Debt ID', 'Customer Name', 'Phone', 'Total Amount',
      'Paid Amount', 'Remaining', 'Status', 'Date'
    ];

    const rows = result.rows.map(r => ({
      'Debt ID': r.id,
      'Customer Name': r.name,
      'Phone': r.phone || '',
      'Total Amount': r.total_amount,
      'Paid Amount': r.paid_amount || 0,
      'Remaining': r.total_amount - (r.paid_amount || 0),
      'Status': r.status,
      'Date': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `debts_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT PRE-ORDERS
// =====================================================
router.get('/pre-orders', authMiddleware, requirePermission('sale:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT po.id, po.customer_name, po.customer_phone, po.total_amount,
             po.paid_amount, po.status, po.product_name, po.created_at
      FROM pre_orders po
      WHERE 1=1 ${shopClause}
      ORDER BY po.created_at DESC
      LIMIT 10000
    `, queryParams);

    const headers = [
      'Order ID', 'Customer Name', 'Phone', 'Total Amount',
      'Paid Amount', 'Balance', 'Status', 'Product', 'Created At'
    ];

    const rows = result.rows.map(r => ({
      'Order ID': r.id,
      'Customer Name': r.customer_name || '',
      'Phone': r.customer_phone || '',
      'Total Amount': r.total_amount,
      'Paid Amount': r.paid_amount || 0,
      'Balance': r.total_amount - (r.paid_amount || 0),
      'Status': r.status,
      'Product': r.product_name || '',
      'Created At': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `preorders_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT STOCK TAKE
// =====================================================
router.get('/stock-take', authMiddleware, requirePermission('stock_take:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND st.shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT st.id, st.name, st.status, st.started_at, st.ended_at,
             st.started_by as created_by
      FROM stock_take_sessions st
      WHERE 1=1 ${shopClause}
      ORDER BY st.started_at DESC
      LIMIT 10000
    `, queryParams);

    const headers = [
      'Session ID', 'Name', 'Status', 'Started At',
      'Ended At', 'Started By'
    ];

    const rows = result.rows.map(r => ({
      'Session ID': r.id,
      'Name': r.name,
      'Status': r.status,
      'Started At': r.started_at ? new Date(r.started_at).toLocaleString() : '',
      'Ended At': r.ended_at ? new Date(r.ended_at).toLocaleString() : '',
      'Started By': r.created_by || ''
    }));

    return getExportResponse(c, headers, rows, format, `stocktake_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT SALE ITEMS (detailed line items)
// =====================================================
router.get('/sale-items', authMiddleware, requirePermission('sale:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND s.shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT si.id, s.id as sale_id, si.product_name, si.quantity,
             si.fraction_type, si.unit_price, si.discount, si.total_price,
             si.profit, s.payment_method, s.created_at
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE 1=1 ${shopClause}
      ORDER BY s.created_at DESC
      LIMIT 50000
    `, queryParams);

    const headers = [
      'Item ID', 'Sale ID', 'Product', 'Quantity',
      'Fraction', 'Unit Price', 'Discount', 'Total',
      'Profit', 'Payment', 'Date'
    ];

    const rows = result.rows.map(r => ({
      'Item ID': r.id,
      'Sale ID': r.sale_id,
      'Product': r.product_name,
      'Quantity': r.quantity,
      'Fraction': r.fraction_type || 'whole',
      'Unit Price': r.unit_price,
      'Discount': r.discount || 0,
      'Total': r.total_price,
      'Profit': r.profit || 0,
      'Payment': r.payment_method,
      'Date': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `sale_items_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT SHOPS
// =====================================================
router.get('/shops', authMiddleware, requirePermission('shop:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';

    let result;
    if (userRole === 'developer') {
      result = await pool.query(`
        SELECT s.id, s.name, s.code, s.description, s.address, s.phone, s.email,
               t.name as tenant_name, s.is_super_admin, s.created_at
        FROM shops s
        LEFT JOIN tenants t ON s.tenant_id = t.id
        ORDER BY s.created_at DESC
      `);
    } else if (tenantId) {
      result = await pool.query(`
        SELECT s.id, s.name, s.code, s.description, s.address, s.phone, s.email,
               t.name as tenant_name, s.is_super_admin, s.created_at
        FROM shops s
        LEFT JOIN tenants t ON s.tenant_id = t.id
        WHERE s.tenant_id = $1
        ORDER BY s.created_at DESC
      `, [tenantId]);
    } else if (shopIds && shopIds.length > 0) {
      result = await pool.query(`
        SELECT s.id, s.name, s.code, s.description, s.address, s.phone, s.email,
               t.name as tenant_name, s.is_super_admin, s.created_at
        FROM shops s
        LEFT JOIN tenants t ON s.tenant_id = t.id
        WHERE s.id = ANY($1)
        ORDER BY s.created_at DESC
      `, [shopIds]);
    } else {
      return c.json({ success: false, error: 'No shops accessible' }, 403);
    }

    const headers = [
      'Shop ID', 'Name', 'Code', 'Description', 'Address',
      'Phone', 'Email', 'Tenant', 'System Shop', 'Created At'
    ];

    const rows = result.rows.map(r => ({
      'Shop ID': r.id,
      'Name': r.name,
      'Code': r.code,
      'Description': r.description || '',
      'Address': r.address || '',
      'Phone': r.phone || '',
      'Email': r.email || '',
      'Tenant': r.tenant_name || '',
      'System Shop': r.is_super_admin ? 'Yes' : 'No',
      'Created At': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `shops_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT CATEGORIES
// =====================================================
router.get('/categories', authMiddleware, requirePermission('product:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT c.id, c.name, c.description, c.color, c.created_at
      FROM categories c
      WHERE 1=1 ${shopClause}
      ORDER BY c.name
    `, queryParams);

    const headers = [
      'Category ID', 'Name', 'Description', 'Color', 'Created At'
    ];

    const rows = result.rows.map(r => ({
      'Category ID': r.id,
      'Name': r.name,
      'Description': r.description || '',
      'Color': r.color || '',
      'Created At': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `categories_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT USERS/SELLERS
// =====================================================
router.get('/users', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';

    let result;
    if (userRole === 'developer') {
      result = await pool.query(`
        SELECT u.id, u.name, u.email, u.role, u.phone,
               u.email_verified, u.banned, u.created_at
        FROM "user" u
        ORDER BY u.created_at DESC
      `);
    } else if (tenantId) {
      result = await pool.query(`
        SELECT u.id, u.name, u.email, u.role, u.phone,
               u.email_verified, u.banned, u.created_at
        FROM "user" u
        WHERE u.tenant_id = $1
        ORDER BY u.created_at DESC
      `, [tenantId]);
    } else {
      return c.json({ success: false, error: 'No tenant assigned' }, 400);
    }

    const headers = [
      'User ID', 'Name', 'Email', 'Role', 'Phone',
      'Email Verified', 'Banned', 'Created At'
    ];

    const rows = result.rows.map(r => ({
      'User ID': r.id,
      'Name': r.name || '',
      'Email': r.email,
      'Role': r.role || 'seller',
      'Phone': r.phone || '',
      'Email Verified': r.email_verified ? 'Yes' : 'No',
      'Banned': r.banned ? 'Yes' : 'No',
      'Created At': new Date(r.created_at).toLocaleString()
    }));

    return getExportResponse(c, headers, rows, format, `users_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT REPORTS (daily sales summary)
// =====================================================
router.get('/reports', authMiddleware, requirePermission('report:read'), async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'csv';
    const shopId = c.req.query('shopId');

    const { clause, params } = getShopFilter(userRole, shopIds, tenantId);
    const queryParams: any[] = [...params];
    let shopClause = clause;

    if (shopId) {
      queryParams.push(shopId);
      shopClause = `AND shop_id = $${queryParams.length}`;
    }

    const result = await pool.query(`
      SELECT DATE(created_at) as sale_date,
             COUNT(*) as total_orders,
             SUM(total_amount) as total_revenue,
             SUM(CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END) as cash_revenue,
             SUM(CASE WHEN payment_method = 'lipa_namba' THEN total_amount ELSE 0 END) as mpesa_revenue,
             SUM(CASE WHEN payment_method = 'debt' THEN total_amount ELSE 0 END) as debt_revenue,
             SUM(discount_amount) as total_discounts,
             COUNT(DISTINCT seller_id) as unique_sellers
      FROM sales
      WHERE 1=1 ${shopClause}
      GROUP BY DATE(created_at)
      ORDER BY sale_date DESC
      LIMIT 365
    `, queryParams);

    const headers = [
      'Date', 'Total Orders', 'Total Revenue', 'Cash Revenue',
      'M-Pesa Revenue', 'Debt Revenue', 'Total Discounts', 'Unique Sellers'
    ];

    const rows = result.rows.map(r => ({
      'Date': new Date(r.sale_date).toLocaleDateString(),
      'Total Orders': r.total_orders,
      'Total Revenue': r.total_revenue,
      'Cash Revenue': r.cash_revenue,
      'M-Pesa Revenue': r.mpesa_revenue,
      'Debt Revenue': r.debt_revenue,
      'Total Discounts': r.total_discounts || 0,
      'Unique Sellers': r.unique_sellers
    }));

    return getExportResponse(c, headers, rows, format, `reports_export_${Date.now()}`);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// =====================================================
// EXPORT ALL DATA (comprehensive)
// =====================================================
router.get('/all', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const shopIds = c.get('shopIds') as string[];
    const tenantId = c.get('tenantId');
    const format = c.req.query('format') || 'json';
    const shopId = c.req.query('shopId');

    const targetShopId = shopId || (shopIds?.[0]) || null;

    const shopWhere = targetShopId ? 'AND shop_id = $1' : '';
    const shopParams = targetShopId ? [targetShopId] : [];

    const [salesRes, productsRes, expensesRes, debtsRes, categoriesRes, shopsRes] = await Promise.all([
      pool.query(`
        SELECT s.id, s.total_amount, s.payment_method, s.amount_paid, s.discount_amount,
               s.customer_name, s.customer_phone, u.email as seller_email, s.created_at
        FROM sales s LEFT JOIN "user" u ON s.seller_id = u.id
        WHERE 1=1 ${shopWhere} ORDER BY s.created_at DESC LIMIT 10000
      `, shopParams),
      pool.query(`
        SELECT p.id, p.name, p.barcode, c.name as category_name,
               p.buying_price, p.selling_price, p.current_stock, p.low_stock_threshold,
               p.is_active, p.created_at
        FROM products p LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.is_active = true ${shopWhere ? shopWhere.replace('shop_id', 'p.shop_id') : ''} ORDER BY p.name LIMIT 10000
      `, shopParams),
      pool.query(`
        SELECT e.id, e.description, e.amount, e.category, e.date, e.created_at
        FROM expenses e WHERE 1=1 ${shopWhere} ORDER BY e.date DESC LIMIT 10000
      `, shopParams),
      pool.query(`
        SELECT d.id, d.customer_name as name, d.customer_phone as phone, d.total_amount, d.paid_amount, d.status, d.created_at
        FROM debtors d WHERE 1=1 ${shopWhere} ORDER BY d.created_at DESC LIMIT 10000
      `, shopParams),
      pool.query(`
        SELECT c.id, c.name, c.description, c.created_at
        FROM categories c WHERE 1=1 ${shopWhere ? shopWhere.replace('shop_id', 'c.shop_id') : ''} ORDER BY c.name
      `, shopParams),
      userRole === 'developer'
        ? pool.query(`SELECT id, name, code, created_at FROM shops ORDER BY created_at DESC`)
        : tenantId
          ? pool.query(`SELECT id, name, code, created_at FROM shops WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])
          : shopIds?.length > 0
            ? pool.query(`SELECT id, name, code, created_at FROM shops WHERE id = ANY($1) ORDER BY created_at DESC`, [shopIds])
            : { rows: [] }
    ]);

    const data = {
      exportDate: new Date().toISOString(),
      exportedBy: c.get('userId'),
      shops: shopsRes.rows,
      categories: categoriesRes.rows,
      products: productsRes.rows,
      sales: salesRes.rows,
      expenses: expensesRes.rows,
      debts: debtsRes.rows,
      summary: {
        totalSales: salesRes.rows.length,
        totalProducts: productsRes.rows.length,
        totalExpenses: expensesRes.rows.length,
        totalDebts: debtsRes.rows.length,
        totalRevenue: salesRes.rows.reduce((sum: number, r: any) => sum + parseFloat(r.total_amount || 0), 0),
        totalExpenseAmount: expensesRes.rows.reduce((sum: number, r: any) => sum + parseFloat(r.amount || 0), 0),
      }
    };

    if (format === 'json') {
      c.header('Content-Type', 'application/json; charset=utf-8');
      c.header('Content-Disposition', `attachment; filename="full_export_${Date.now()}.json"`);
      return c.body(JSON.stringify(data, null, 2));
    }

    return c.json({ success: false, error: 'Full export is only available in JSON format' }, 400);
  } catch (e: any) {
    console.error('[Export /all] Error:', e.message, e.stack);
    return c.json({ success: false, error: e.message }, 400);
  }
});

export default router;
