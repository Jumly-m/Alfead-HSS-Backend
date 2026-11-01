import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requireActiveSubscription } from '../../middleware/subscription.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { db as readDb } from '../../config/database.js';
import { pool } from '../../config/drizzle.js';
import type { Context } from 'hono';

const router = new Hono();

const createCustomerSchema = z.object({
  // Client-generated id for offline-created customers (replay-safe creates).
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  phone: z.string().optional().default(''),
  email: z.string().optional().default(''),
  company: z.string().optional().default(''),
  address: z.string().optional().default(''),
  tin: z.string().optional().default(''),
  vrn: z.string().optional().default(''),
  notes: z.string().optional().default(''),
  isReturned: z.boolean().optional().default(false),
  returnCount: z.number().int().optional().default(0),
});

const updateCustomerSchema = createCustomerSchema.partial();

let customersTableChecked = false;

const ensureCustomersTable = async (): Promise<void> => {
  if (customersTableChecked) return;
  try {
    await pool.query(`SELECT 1 FROM customers LIMIT 1`);
    customersTableChecked = true;
    return;
  } catch {
    // table missing - create it
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(255),
        company VARCHAR(255),
        address TEXT,
        tin VARCHAR(50),
        vrn VARCHAR(50),
        notes TEXT,
        is_returned BOOLEAN DEFAULT FALSE,
        return_count INTEGER DEFAULT 0,
        total_visits INTEGER DEFAULT 0,
        total_spent DECIMAL(12,2) DEFAULT 0,
        last_purchase_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS customers_shop_id_idx ON customers(shop_id)`);
    customersTableChecked = true;
  } catch (e) {
    console.error('ensureCustomersTable failed:', (e as Error).message);
  }
};

const ensureCustomersTableMiddleware = async (c: Context, next: () => Promise<void>) => {
  await ensureCustomersTable();
  await next();
};

router.use('*', ensureCustomersTableMiddleware);

function getShopId(c: Context): string {
  const shopIds = (c as any).get('shopIds') as string[];
  return shopIds?.[0] || '';
}

// Normalise a phone expression to its last 9 digits, so +255 756 995 455,
// 0756995455 and 756995455 all identify the same customer.
const phone9 = (col: string) =>
  `RIGHT(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), 9)`;

// A sale row counts as a real purchase only when it carries products. Debt
// payments are stored as sale_type = 'debt' rows WITHOUT sale_items, so this
// check keeps repayments from inflating a customer's order count.
const isPurchase = (sale: string) =>
  `(${sale}.sale_type IS DISTINCT FROM 'debt' OR EXISTS (SELECT 1 FROM sale_items sic WHERE sic.sale_id = ${sale}.id))`;

// A sale belongs to a customer when the phone (last 9 digits) or the full
// name matches — the same rule the AI advisor uses.
const saleMatchesCustomer = (sale: string, cust: string) => `(
  (LENGTH(regexp_replace(COALESCE(${cust}.phone, ''), '[^0-9]', '', 'g')) >= 9
    AND ${phone9(`${sale}.customer_phone`)} = RIGHT(regexp_replace(${cust}.phone, '[^0-9]', '', 'g'), 9))
  OR (COALESCE(${sale}.customer_name, '') <> ''
    AND LOWER(TRIM(${sale}.customer_name)) = LOWER(TRIM(${cust}.name)))
)`;

const toIsoOrNull = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// Safe to inline: the value is always produced by Date#toISOString().
const periodSql = (saleAlias: string, startIso: string | null, endIso: string | null): string => {
  let sql = '';
  if (startIso) sql += ` AND ${saleAlias}.created_at >= '${startIso}'::timestamptz`;
  if (endIso) sql += ` AND ${saleAlias}.created_at <= '${endIso}'::timestamptz`;
  return sql;
};

router.get('/',
  authMiddleware,
  requirePermission('customer:read'),
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const url = new URL(c.req.url);
      const search = url.searchParams.get('search') || '';
      const isReturned = url.searchParams.get('returned');
      const startIso = toIsoOrNull(url.searchParams.get('startDate'));
      const endIso = toIsoOrNull(url.searchParams.get('endDate'));
      const sortBy = url.searchParams.get('sortBy') || 'created_at';
      const sortOrder = url.searchParams.get('sortOrder') || 'DESC';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
      const offset = parseInt(url.searchParams.get('offset') || '0');

      const allowedSort = ['name', 'phone', 'company', 'orders_count', 'items_qty', 'total_spent', 'return_count', 'last_purchase_at', 'created_at'];
      const col = allowedSort.includes(sortBy) ? sortBy : 'created_at';
      const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';

      let where = `WHERE c.shop_id = $1`;
      const params: any[] = [shopId];
      let paramIdx = 2;

      if (search) {
        where += ` AND (c.name ILIKE $${paramIdx} OR c.phone ILIKE $${paramIdx} OR c.company ILIKE $${paramIdx} OR c.email ILIKE $${paramIdx})`;
        params.push(`%${search}%`);
        paramIdx++;
      }
      if (isReturned === 'true') {
        where += ` AND c.is_returned = TRUE`;
      }

      const countResult = await readDb.read(`SELECT COUNT(*) FROM customers c ${where}`, params);
      const total = parseInt(countResult.rows[0].count);

      // Live purchase stats per customer. The stored total_visits/total_spent
      // columns are never maintained, so everything is aggregated straight
      // from sales + sale_items for the requested period (plus lifetime and
      // 7/30-day counters for loyalty analysis).
      const result = await readDb.read(
        `SELECT
           c.id, c.shop_id, c.name, c.phone, c.email, c.company, c.address, c.tin, c.vrn, c.notes,
           c.is_returned, c.return_count, c.created_at, c.updated_at,
           COALESCE(per.orders_count, 0)::int AS orders_count,
           COALESCE(per.total_spent, 0) AS total_spent,
           COALESCE(per.items_qty, 0) AS items_qty,
           COALESCE(per.items_count, 0)::int AS items_count,
           per.last_purchase_at,
           COALESCE(life.orders_count, 0)::int AS orders_all_time,
           COALESCE(life.total_spent, 0) AS total_spent_all_time,
           COALESCE(life.orders_7d, 0)::int AS orders_7d,
           COALESCE(life.orders_30d, 0)::int AS orders_30d,
           life.last_purchase_at AS last_purchase_all_time,
           COALESCE(debt.outstanding_debt, 0) AS outstanding_debt,
           COALESCE(debt.debt_count, 0)::int AS debt_count
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*)::int AS orders_count,
             COALESCE(SUM(s.total_amount), 0) AS total_spent,
             COALESCE(SUM(COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.sale_id = s.id), 0)), 0) AS items_qty,
             COALESCE(SUM(COALESCE((SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id), 0)), 0)::int AS items_count,
             MAX(s.created_at) AS last_purchase_at
           FROM sales s
           WHERE s.shop_id = c.shop_id
             AND ${isPurchase('s')}
             ${periodSql('s', startIso, endIso)}
             AND ${saleMatchesCustomer('s', 'c')}
         ) per ON true
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*)::int AS orders_count,
             COALESCE(SUM(s.total_amount), 0) AS total_spent,
             COUNT(*) FILTER (WHERE s.created_at >= NOW() - INTERVAL '7 days')::int AS orders_7d,
             COUNT(*) FILTER (WHERE s.created_at >= NOW() - INTERVAL '30 days')::int AS orders_30d,
             MAX(s.created_at) AS last_purchase_at
           FROM sales s
           WHERE s.shop_id = c.shop_id
             AND ${isPurchase('s')}
             AND ${saleMatchesCustomer('s', 'c')}
         ) life ON true
         LEFT JOIN LATERAL (
           SELECT
             COALESCE(SUM(d.total_amount - COALESCE(d.paid_amount, 0)), 0) AS outstanding_debt,
             COUNT(*)::int AS debt_count
           FROM debtors d
           WHERE d.shop_id = c.shop_id
             AND COALESCE(d.status, 'unpaid') <> 'paid'
             AND LENGTH(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) >= 9
             AND ${phone9('d.customer_phone')} = RIGHT(regexp_replace(c.phone, '[^0-9]', '', 'g'), 9)
         ) debt ON true
         ${where}
         ORDER BY ${col} ${dir}, c.name ASC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      );

      return c.json({ data: result.rows, total, limit, offset });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

// Shop-wide customer analytics for the summary cards: how many registered
// customers, how much the registered customers actually bought in the period,
// the average order and how many of them are repeat buyers.
router.get('/analytics',
  authMiddleware,
  requirePermission('customer:read'),
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const url = new URL(c.req.url);
      const startIso = toIsoOrNull(url.searchParams.get('startDate'));
      const endIso = toIsoOrNull(url.searchParams.get('endDate'));

      const totalRes = await readDb.read(
        `SELECT COUNT(*)::int AS count FROM customers WHERE shop_id = $1`,
        [shopId]
      );

      const period = periodSql('s', startIso, endIso);

      const salesRes = await readDb.read(
        `SELECT COUNT(*)::int AS orders, COALESCE(SUM(s.total_amount), 0) AS revenue
         FROM sales s
         WHERE s.shop_id = $1 AND ${isPurchase('s')} ${period}`,
        [shopId]
      );

      const repeatRes = await readDb.read(
        `SELECT
           COUNT(*) FILTER (WHERE orders >= 2)::int AS repeat,
           COUNT(*) FILTER (WHERE orders >= 1)::int AS active
         FROM (
           SELECT c.id, COUNT(s.id)::int AS orders
           FROM customers c
           LEFT JOIN sales s ON s.shop_id = c.shop_id
             AND ${isPurchase('s')}
             ${period}
             AND ${saleMatchesCustomer('s', 'c')}
           WHERE c.shop_id = $1
           GROUP BY c.id
         ) t`,
        [shopId]
      );

      // Revenue tied to registered customers (deduped: one sale may match the
      // same customer by both phone and name).
      const custSalesRes = await readDb.read(
        `SELECT COUNT(*)::int AS orders, COALESCE(SUM(t.total_amount), 0) AS revenue
         FROM (
           SELECT DISTINCT s.id, s.total_amount
           FROM customers c
           JOIN sales s ON s.shop_id = c.shop_id
             AND ${isPurchase('s')}
             ${period}
             AND ${saleMatchesCustomer('s', 'c')}
           WHERE c.shop_id = $1
         ) t`,
        [shopId]
      );

      const orders = Number(salesRes.rows[0]?.orders || 0);
      const revenue = Number(salesRes.rows[0]?.revenue || 0);
      const custRevenue = Number(custSalesRes.rows[0]?.revenue || 0);
      const custOrders = Number(custSalesRes.rows[0]?.orders || 0);

      return c.json({
        success: true,
        data: {
          totalCustomers: Number(totalRes.rows[0]?.count || 0),
          revenue,
          orders,
          avgOrder: orders > 0 ? revenue / orders : 0,
          customerRevenue: custRevenue,
          customerOrders: custOrders,
          repeat: Number(repeatRes.rows[0]?.repeat || 0),
          activeCustomers: Number(repeatRes.rows[0]?.active || 0),
        },
      });
    } catch (e: any) {
      return c.json({ success: false, error: e.message }, 500);
    }
  }
);

// Deep-dive for one customer: orders/items/spend for the selected period,
// lifetime totals, purchase frequency (day/week/month), top products, recent
// orders and unpaid debt — everything the shop owner needs to reward loyalty.
router.get('/:id/analytics',
  authMiddleware,
  requirePermission('customer:read'),
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const id = c.req.param('id');
      const url = new URL(c.req.url);
      const startIso = toIsoOrNull(url.searchParams.get('startDate'));
      const endIso = toIsoOrNull(url.searchParams.get('endDate'));

      const custRes = await readDb.read(
        `SELECT id, shop_id, name, phone, email, company, created_at, is_returned, return_count
         FROM customers WHERE id = $1 AND shop_id = $2`,
        [id, shopId]
      );
      if (custRes.rows.length === 0) return c.json({ success: false, error: 'Customer not found' }, 404);
      const customer = custRes.rows[0];

      const phone = customer.phone || '';
      const name = customer.name || '';
      const match = `(
        (LENGTH(regexp_replace($2, '[^0-9]', '', 'g')) >= 9
          AND ${phone9('s.customer_phone')} = RIGHT(regexp_replace($2, '[^0-9]', '', 'g'), 9))
        OR (COALESCE(s.customer_name, '') <> '' AND LOWER(TRIM(s.customer_name)) = LOWER(TRIM($3)))
      )`;
      const period = periodSql('s', startIso, endIso);
      const base = `FROM sales s WHERE s.shop_id = $1 AND ${isPurchase('s')} AND ${match}`;
      const args = [shopId, phone, name];
      const debtArgs = [shopId, phone];

      const periodRes = await readDb.read(
        `SELECT
           COUNT(*)::int AS orders,
           COALESCE(SUM(s.total_amount), 0) AS spent,
           COALESCE(SUM(COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.sale_id = s.id), 0)), 0) AS items_qty,
           COALESCE(SUM(COALESCE((SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id), 0)), 0)::int AS items_count,
           MIN(s.created_at) AS first_purchase_at,
           MAX(s.created_at) AS last_purchase_at
         ${base} ${period}`,
        args
      );

      const lifeRes = await readDb.read(
        `SELECT
           COUNT(*)::int AS orders,
           COALESCE(SUM(s.total_amount), 0) AS spent,
           COUNT(*) FILTER (WHERE s.created_at >= NOW() - INTERVAL '7 days')::int AS orders_7d,
           COUNT(*) FILTER (WHERE s.created_at >= NOW() - INTERVAL '30 days')::int AS orders_30d,
           COUNT(*) FILTER (WHERE s.created_at >= NOW() - INTERVAL '90 days')::int AS orders_90d,
           MIN(s.created_at) AS first_purchase_at,
           MAX(s.created_at) AS last_purchase_at
         ${base}`,
        args
      );

      const gapRes = await readDb.read(
        `SELECT COALESCE(AVG(gap_days), 0) AS avg_days
         FROM (
           SELECT EXTRACT(EPOCH FROM (s.created_at - LAG(s.created_at) OVER (ORDER BY s.created_at))) / 86400 AS gap_days
           ${base}
         ) t
         WHERE gap_days IS NOT NULL`,
        args
      );

      // Day/week breakdowns only make sense (and stay fast) on short ranges.
      const rangeDays = startIso && endIso
        ? Math.ceil((new Date(endIso).getTime() - new Date(startIso).getTime()) / 86400000)
        : null;

      let byDay: any[] = [];
      if (rangeDays !== null && rangeDays <= 92) {
        const r = await readDb.read(
          `SELECT to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD') AS bucket,
                  COUNT(*)::int AS orders, COALESCE(SUM(s.total_amount), 0) AS spent
           ${base} ${period}
           GROUP BY 1 ORDER BY 1`,
          args
        );
        byDay = r.rows;
      }

      let byWeek: any[] = [];
      if (rangeDays !== null && rangeDays <= 400) {
        const r = await readDb.read(
          `SELECT to_char(date_trunc('week', s.created_at), 'YYYY-MM-DD') AS bucket,
                  COUNT(*)::int AS orders, COALESCE(SUM(s.total_amount), 0) AS spent
           ${base} ${period}
           GROUP BY 1 ORDER BY 1`,
          args
        );
        byWeek = r.rows;
      }

      const byMonthRes = await readDb.read(
        `SELECT to_char(date_trunc('month', s.created_at), 'YYYY-MM') AS bucket,
                COUNT(*)::int AS orders, COALESCE(SUM(s.total_amount), 0) AS spent
         ${base} AND s.created_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
         GROUP BY 1 ORDER BY 1`,
        args
      );

      const topRes = await readDb.read(
        `SELECT si.product_name,
                COALESCE(SUM(si.quantity), 0) AS qty,
                COALESCE(SUM(si.total_price), 0) AS total,
                COUNT(DISTINCT s.id)::int AS orders
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         WHERE s.shop_id = $1 AND ${isPurchase('s')} AND ${match} ${period}
         GROUP BY si.product_name
         ORDER BY total DESC NULLS LAST
         LIMIT 8`,
        args
      );

      const recentRes = await readDb.read(
        `SELECT s.id, s.created_at, s.total_amount, s.payment_method, s.payment_status, s.sale_type,
                COALESCE((SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id), 0) AS items_count,
                COALESCE((
                  SELECT string_agg(si.product_name || ' ×' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::text)), ', ' ORDER BY si.product_name)
                  FROM sale_items si WHERE si.sale_id = s.id
                ), '') AS items_summary
         ${base} ${period}
         ORDER BY s.created_at DESC
         LIMIT 10`,
        args
      );

      const debtRes = await readDb.read(
        `SELECT COALESCE(SUM(d.total_amount - COALESCE(d.paid_amount, 0)), 0) AS outstanding,
                COUNT(*)::int AS unpaid_count,
                MIN(d.due_date) AS oldest_due_date,
                MAX(d.updated_at) AS last_activity_at
         FROM debtors d
         WHERE d.shop_id = $1
           AND COALESCE(d.status, 'unpaid') <> 'paid'
           AND LENGTH(regexp_replace($2, '[^0-9]', '', 'g')) >= 9
           AND ${phone9('d.customer_phone')} = RIGHT(regexp_replace($2, '[^0-9]', '', 'g'), 9)`,
        debtArgs
      );

      const debtsRes = await readDb.read(
        `SELECT d.id, d.total_amount, COALESCE(d.paid_amount, 0) AS paid_amount,
                d.status, d.due_date, d.created_at, d.notes,
                COALESCE((
                  SELECT string_agg(di.product_name || ' ×' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM di.quantity::text)), ', ' ORDER BY di.product_name)
                  FROM debt_items di WHERE di.debtor_id = d.id
                ), '') AS items_summary
         FROM debtors d
         WHERE d.shop_id = $1
           AND COALESCE(d.status, 'unpaid') <> 'paid'
           AND LENGTH(regexp_replace($2, '[^0-9]', '', 'g')) >= 9
           AND ${phone9('d.customer_phone')} = RIGHT(regexp_replace($2, '[^0-9]', '', 'g'), 9)
         ORDER BY d.created_at DESC
         LIMIT 10`,
        debtArgs
      );

      const p = periodRes.rows[0] || {};
      const life = lifeRes.rows[0] || {};
      const periodOrders = Number(p.orders || 0);
      const periodSpent = Number(p.spent || 0);

      return c.json({
        success: true,
        data: {
          customer,
          period: { startDate: startIso, endDate: endIso },
          summary: {
            orders: periodOrders,
            spent: periodSpent,
            items_qty: Number(p.items_qty || 0),
            items_count: Number(p.items_count || 0),
            avg_order: periodOrders > 0 ? periodSpent / periodOrders : 0,
            first_purchase_at: p.first_purchase_at || null,
            last_purchase_at: p.last_purchase_at || null,
            orders_all_time: Number(life.orders || 0),
            spent_all_time: Number(life.spent || 0),
            orders_7d: Number(life.orders_7d || 0),
            orders_30d: Number(life.orders_30d || 0),
            orders_90d: Number(life.orders_90d || 0),
            first_purchase_all_time: life.first_purchase_at || null,
            last_purchase_all_time: life.last_purchase_at || null,
            avg_days_between_orders: Number(gapRes.rows[0]?.avg_days || 0),
            outstanding_debt: Number(debtRes.rows[0]?.outstanding || 0),
            unpaid_debt_count: Number(debtRes.rows[0]?.unpaid_count || 0),
            oldest_due_date: debtRes.rows[0]?.oldest_due_date || null,
          },
          byDay,
          byWeek,
          byMonth: byMonthRes.rows,
          topProducts: topRes.rows,
          recentOrders: recentRes.rows,
          debts: debtsRes.rows,
        },
      });
    } catch (e: any) {
      return c.json({ success: false, error: e.message }, 500);
    }
  }
);

// Complete chronological ledger for one customer: every purchase (with its
// line items), every debt repayment and every invoice payment, plus a running
// debt balance. This is the "full history" view — no period filter, paginated
// newest first.
router.get('/:id/ledger',
  authMiddleware,
  requirePermission('customer:read'),
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const id = c.req.param('id');
      const url = new URL(c.req.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0'));

      const custRes = await readDb.read(
        `SELECT id, name, phone FROM customers WHERE id = $1 AND shop_id = $2`,
        [id, shopId]
      );
      if (custRes.rows.length === 0) return c.json({ success: false, error: 'Customer not found' }, 404);
      const customer = custRes.rows[0];
      const phone = customer.phone || '';
      const name = customer.name || '';

      const match = `(
        (LENGTH(regexp_replace($2, '[^0-9]', '', 'g')) >= 9
          AND ${phone9('s.customer_phone')} = RIGHT(regexp_replace($2, '[^0-9]', '', 'g'), 9))
        OR (COALESCE(s.customer_name, '') <> '' AND LOWER(TRIM(s.customer_name)) = LOWER(TRIM($3)))
      )`;
      const args = [shopId, phone, name];

      // One row per transaction; debt_delta lets the window function build the
      // running balance (credit purchases +, repayments −).
      const entriesSql = `
        WITH entries AS (
          SELECT
            'purchase' AS entry_type,
            s.id::text AS entry_id,
            s.created_at AS occurred_at,
            s.total_amount AS amount,
            s.payment_method,
            s.payment_status,
            s.notes,
            s.id AS sale_id,
            CASE WHEN s.payment_method = 'debt' THEN s.total_amount ELSE 0 END AS debt_delta
          FROM sales s
          WHERE s.shop_id = $1 AND ${isPurchase('s')} AND ${match}

          UNION ALL

          SELECT
            'debt_payment', dp.id::text, dp.created_at, dp.amount, dp.payment_method,
            NULL, dp.notes, NULL::uuid, -dp.amount
          FROM debt_payments dp
          JOIN debtors d ON dp.debtor_id = d.id
          WHERE d.shop_id = $1
            AND LENGTH(regexp_replace($2, '[^0-9]', '', 'g')) >= 9
            AND ${phone9('d.customer_phone')} = RIGHT(regexp_replace($2, '[^0-9]', '', 'g'), 9)

          UNION ALL

          SELECT
            'invoice_payment', ip.id::text, ip.created_at, ip.amount, ip.payment_method,
            NULL, ip.notes, NULL::uuid, 0
          FROM invoice_payments ip
          JOIN sales s ON ip.sale_id = s.id
          WHERE s.shop_id = $1 AND ${isPurchase('s')} AND ${match}
        )
        SELECT *,
               SUM(debt_delta) OVER (ORDER BY occurred_at ASC, entry_id ASC) AS balance_after
        FROM entries
        ORDER BY occurred_at DESC, entry_id DESC
        LIMIT $4 OFFSET $5
      `;

      const totalsSql = `
        SELECT
          COUNT(*) FILTER (WHERE entry_type = 'purchase')::int AS purchases_count,
          COALESCE(SUM(amount) FILTER (WHERE entry_type = 'purchase'), 0) AS purchases_total,
          COUNT(*) FILTER (WHERE entry_type IN ('debt_payment', 'invoice_payment'))::int AS payments_count,
          COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('debt_payment', 'invoice_payment')), 0) AS payments_total
        FROM (
          SELECT 'purchase' AS entry_type, s.total_amount AS amount
          FROM sales s WHERE s.shop_id = $1 AND ${isPurchase('s')} AND ${match}
          UNION ALL
          SELECT 'debt_payment', dp.amount
          FROM debt_payments dp
          JOIN debtors d ON dp.debtor_id = d.id
          WHERE d.shop_id = $1
            AND LENGTH(regexp_replace($2, '[^0-9]', '', 'g')) >= 9
            AND ${phone9('d.customer_phone')} = RIGHT(regexp_replace($2, '[^0-9]', '', 'g'), 9)
          UNION ALL
          SELECT 'invoice_payment', ip.amount
          FROM invoice_payments ip
          JOIN sales s ON ip.sale_id = s.id
          WHERE s.shop_id = $1 AND ${isPurchase('s')} AND ${match}
        ) x
      `;

      const [entriesRes, totalsRes] = await Promise.all([
        readDb.read(entriesSql, [...args, limit, offset]),
        readDb.read(totalsSql, args),
      ]);

      // Attach the line items to purchase entries (one extra round-trip).
      const saleIds = entriesRes.rows.filter((r: any) => r.sale_id).map((r: any) => r.sale_id);
      const itemsBySale: Record<string, any[]> = {};
      if (saleIds.length > 0) {
        const itemsRes = await readDb.read(
          `SELECT sale_id, product_name, quantity, unit_price, discount, total_price
           FROM sale_items
           WHERE sale_id = ANY($1::uuid[])
           ORDER BY product_name ASC`,
          [saleIds]
        );
        for (const it of itemsRes.rows) {
          const key = it.sale_id;
          if (!itemsBySale[key]) itemsBySale[key] = [];
          itemsBySale[key].push(it);
        }
      }

      const entries = entriesRes.rows.map((r: any) => ({
        ...r,
        items: r.sale_id ? (itemsBySale[r.sale_id] || []) : [],
      }));

      const totals = totalsRes.rows[0] || {};

      return c.json({
        success: true,
        data: {
          customer,
          entries,
          limit,
          offset,
          total: Number(totals.purchases_count || 0) + Number(totals.payments_count || 0),
          totals: {
            purchases_count: Number(totals.purchases_count || 0),
            purchases_total: Number(totals.purchases_total || 0),
            payments_count: Number(totals.payments_count || 0),
            payments_total: Number(totals.payments_total || 0),
          },
        },
      });
    } catch (e: any) {
      return c.json({ success: false, error: e.message }, 500);
    }
  }
);

router.get('/all',
  authMiddleware,
  requirePermission('customer:read'),
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const url = new URL(c.req.url);
      const search = url.searchParams.get('search') || '';

      let where = `WHERE shop_id = $1`;
      const params: any[] = [shopId];

      if (search) {
        where += ` AND (name ILIKE $2 OR phone ILIKE $2 OR company ILIKE $2 OR email ILIKE $2)`;
        params.push(`%${search}%`);
      }

       const result = await readDb.read(
        `SELECT id, name, phone, email, company, tin, vrn FROM customers ${where} ORDER BY name ASC`,
        params
      );

      return c.json({ data: result.rows });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

router.post('/',
  authMiddleware,
  requirePermission('customer:create'),
  requireActiveSubscription,
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const body = await c.req.json();
      const parsed = createCustomerSchema.parse(body);

      // Idempotent replay: if this offline-created customer already exists,
      // return it instead of inserting a duplicate.
      if (parsed.id) {
        const existing = await pool.query(`SELECT * FROM customers WHERE id = $1`, [parsed.id]);
        if (existing.rows.length > 0) return c.json({ data: existing.rows[0] }, 200);
      }

      const result = await pool.query(
        `INSERT INTO customers (id, shop_id, name, phone, email, company, address, tin, vrn, notes, is_returned, return_count)
         VALUES (COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [parsed.id || null, shopId, parsed.name, parsed.phone, parsed.email, parsed.company, parsed.address, parsed.tin, parsed.vrn, parsed.notes, parsed.isReturned, parsed.returnCount]
      );

      return c.json({ data: result.rows[0] }, 201);
    } catch (e: any) {
      if (e instanceof z.ZodError) return c.json({ error: e.issues[0].message }, 400);
      return c.json({ error: e.message }, 500);
    }
  }
);

router.put('/:id',
  authMiddleware,
  requirePermission('customer:update'),
  requireActiveSubscription,
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const id = c.req.param('id');
      const body = await c.req.json();
      const parsed = updateCustomerSchema.parse(body);

      const sets: string[] = [];
      const params: any[] = [];
      let idx = 1;

      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) {
          const col = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
          sets.push(`${col} = $${idx}`);
          params.push(value);
          idx++;
        }
      }
      if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);

      sets.push(`updated_at = CURRENT_TIMESTAMP`);
      params.push(id, shopId);

      const result = await pool.query(
        `UPDATE customers SET ${sets.join(', ')} WHERE id = $${idx} AND shop_id = $${idx + 1} RETURNING *`,
        params
      );
      if (result.rows.length === 0) return c.json({ error: 'Customer not found' }, 404);

      return c.json({ data: result.rows[0] });
    } catch (e: any) {
      if (e instanceof z.ZodError) return c.json({ error: e.issues[0].message }, 400);
      return c.json({ error: e.message }, 500);
    }
  }
);

router.delete('/:id',
  authMiddleware,
  requirePermission('customer:delete'),
  requireActiveSubscription,
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const id = c.req.param('id');

      const result = await pool.query(
        `DELETE FROM customers WHERE id = $1 AND shop_id = $2 RETURNING id`,
        [id, shopId]
      );
      if (result.rows.length === 0) return c.json({ error: 'Customer not found' }, 404);

      return c.json({ success: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

router.patch('/:id/returned',
  authMiddleware,
  requirePermission('customer:update'),
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const id = c.req.param('id');
      const body = await c.req.json();
      const isReturned = body.isReturned === true;

      const result = await pool.query(
        `UPDATE customers SET is_returned = $1, return_count = CASE WHEN $1 THEN return_count + 1 ELSE return_count END, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND shop_id = $3 RETURNING *`,
        [isReturned, id, shopId]
      );
      if (result.rows.length === 0) return c.json({ error: 'Customer not found' }, 404);

      return c.json({ data: result.rows[0] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

router.post('/bulk',
  authMiddleware,
  requirePermission('customer:create'),
  requireActiveSubscription,
  async (c: Context) => {
    try {
      const shopId = getShopId(c);
      const body = await c.req.json();
      const customers = body.customers || body.data || [];

      if (!Array.isArray(customers) || customers.length === 0) {
        return c.json({ error: 'No customers provided' }, 400);
      }

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (let i = 0; i < customers.length; i++) {
        const row = customers[i];
        const name = (row.name || row.Name || row.NAME || '').toString().trim();
        if (!name) { skipped++; continue; }

        try {
          await pool.query(
            `INSERT INTO customers (shop_id, name, phone, email, company, address, tin, vrn, notes, is_returned, return_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, 0)`,
            [
              shopId, name,
              (row.phone || row.Phone || row.PHONE || '').toString().trim(),
              (row.email || row.Email || row.EMAIL || '').toString().trim(),
              (row.company || row.Company || row.COMPANY || row.business || row.Business || '').toString().trim(),
              (row.address || row.Address || row.ADDRESS || '').toString().trim(),
              (row.tin || row.TIN || row.Tin || '').toString().trim(),
              (row.vrn || row.VRN || row.Vrn || '').toString().trim(),
              (row.notes || row.Notes || row.NOTES || '').toString().trim(),
            ]
          );
          imported++;
        } catch (e: any) {
          errors.push(`Row ${i + 1} (${name}): ${e.message.slice(0, 100)}`);
          skipped++;
        }
      }

      return c.json({ imported, skipped, errors: errors.slice(0, 20) });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

export default router;
