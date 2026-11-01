/**
 * Daily sales report — every night at 22:00 Tanzania time (EAT), every ACTIVE
 * PAID SUBSCRIBER receives a per-shop report by SMS and email:
 *
 *   Habari {SHOP}, mauzo ya leo ni TZS ..., faida ..., madeni ..., matumizi ...,
 *   faida baada ya kutoa matumizi ni ....
 *
 * Free-trial users are deliberately excluded: only tenants with a live PAID
 * subscription (tenant_subscriptions.status = 'active' AND not expired) get it.
 *
 * Numbers use the exact same EAT day-window + profit formulas as the dashboard
 * /api/stats route, so the report always agrees with what the owner sees in the
 * app. A per-shop/per-day log guarantees at most one report per shop per day.
 */
import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import { sendEmail } from '../services/email.service.js';
import { sendSms } from '../services/ehub-sms-adapter.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';
const fmt = (n: number) => `TZS ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

export async function ensureDailyReportTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_report_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        report_date DATE NOT NULL,
        sms_sent BOOLEAN NOT NULL DEFAULT false,
        email_sent BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (shop_id, report_date)
      )
    `);
    console.log('✅ Daily report log table ready');
  } catch (e: any) {
    console.log('⚠️  Daily report log table check:', e.message);
  }
}

function eatDayRange(): { start: Date; end: Date } {
  const eatOffsetMs = 3 * 60 * 60 * 1000; // UTC+3
  const nowEat = new Date(Date.now() + eatOffsetMs);
  const startEat = new Date(nowEat);
  startEat.setUTCHours(0, 0, 0, 0);
  const start = new Date(startEat.getTime() - eatOffsetMs);
  return { start, end: new Date(start.getTime() + 86400000) };
}

// Whether the shop merges Services (Huduma) income into sales — same setting
// the dashboard /api/stats route honours, so both always agree.
export async function getAddServicesToSales(shopId: string): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'services' AND shop_id = $1 LIMIT 1`, [shopId]);
    const value = typeof r.rows[0]?.value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0]?.value;
    return value?.add_to_sales === true;
  } catch {
    return false;
  }
}

// Same "money in" definition as the dashboard: cash/lipa/bank sales, debt
// payments, invoice payments, invoice/credit sales marked paid today, pre-order
// payments, and services (only when the shop enabled "add to sales").
export async function todayRevenue(shopId: string, start: Date, end: Date, includeServices = false): Promise<number> {
  const r = await pool.query(`
    SELECT COALESCE(SUM(total), 0) AS total FROM (
      SELECT s.total_amount AS total FROM sales s
      WHERE s.shop_id = $1 AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
        AND s.sale_type IS DISTINCT FROM 'pre_order'
        AND s.created_at >= $2 AND s.created_at < $3
      UNION ALL
      SELECT s.total_amount FROM sales s
      WHERE s.shop_id = $1
        AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank')
        AND s.payment_status = 'paid'
        AND s.sale_type IS DISTINCT FROM 'pre_order'
        AND s.updated_at >= $2 AND s.updated_at < $3
        AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.sale_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
      UNION ALL
      SELECT dp.amount FROM debt_payments dp JOIN debtors d ON dp.debtor_id = d.id
      WHERE d.shop_id = $1 AND dp.created_at >= $2 AND dp.created_at < $3
      UNION ALL
      SELECT ip.amount FROM invoice_payments ip JOIN sales s ON ip.sale_id = s.id
      WHERE s.shop_id = $1 AND ip.created_at >= $2 AND ip.created_at < $3
      UNION ALL
      SELECT pp.amount FROM pre_order_payments pp JOIN pre_orders po ON pp.pre_order_id = po.id
      WHERE po.shop_id = $1 AND pp.created_at >= $2 AND pp.created_at < $3
      ${includeServices ? `
      UNION ALL
      SELECT sr.total FROM service_records sr
      WHERE sr.shop_id = $1 AND sr.created_at >= $2 AND sr.created_at < $3` : ''}
    ) combined
  `, [shopId, start, end]);
  return Number(r.rows[0]?.total) || 0;
}

// Identical formula to /api/stats todayProfit (cash sales, paid pre-orders,
// debt payments proportional profit, invoice payments, invoice-marked-paid,
// services income = full profit only when the shop merges services into sales).
export async function todayProfit(shopId: string, start: Date, end: Date, includeServices = false): Promise<number> {
  const r = await pool.query(`
    SELECT COALESCE(SUM(profit), 0) AS total_profit FROM (
      SELECT (si.unit_price * si.quantity - COALESCE(si.discount, 0)) - (COALESCE(si.buying_price_at_sale, 0) * si.quantity) AS profit
      FROM sale_items si JOIN sales s ON si.sale_id = s.id
      WHERE s.shop_id = $1 AND s.payment_method IN ('cash', 'lipa_namba', 'bank')
        AND s.sale_type IS DISTINCT FROM 'pre_order'
        AND s.created_at >= $2 AND s.created_at < $3
      UNION ALL
      SELECT COALESCE(SUM(
        (si.unit_price * si.quantity - COALESCE(si.discount, 0)) - (COALESCE(si.buying_price_at_sale, 0) * si.quantity)
      ), 0)
      FROM sale_items si JOIN sales s ON si.sale_id = s.id JOIN pre_orders po ON po.sale_id = s.id
      WHERE po.shop_id = $1 AND s.sale_type = 'pre_order' AND s.payment_status = 'paid'
        AND s.updated_at >= $2 AND s.updated_at < $3
      UNION ALL
      SELECT COALESCE(SUM(dp.amount - (bc.total_buying * LEAST(dp.amount / NULLIF(d.total_amount, 0), 1))), 0)
      FROM debt_payments dp JOIN debtors d ON dp.debtor_id = d.id
      LEFT JOIN (SELECT debtor_id, COALESCE(SUM(buying_price * quantity), 0) AS total_buying FROM debt_items GROUP BY debtor_id) bc ON bc.debtor_id = d.id
      WHERE d.shop_id = $1 AND dp.created_at >= $2 AND dp.created_at < $3
      UNION ALL
      SELECT COALESCE(SUM(ip.amount * (COALESCE(sp.total_profit, 0) / NULLIF(s.total_amount, 0))), 0)
      FROM invoice_payments ip JOIN sales s ON ip.sale_id = s.id
      LEFT JOIN (SELECT sale_id, COALESCE(SUM((unit_price * quantity - COALESCE(discount, 0)) - (COALESCE(buying_price_at_sale, 0) * quantity)), 0) AS total_profit FROM sale_items GROUP BY sale_id) sp ON sp.sale_id = s.id
      WHERE s.shop_id = $1 AND ip.created_at >= $2 AND ip.created_at < $3
      UNION ALL
      SELECT COALESCE(SUM(COALESCE(sp.total_profit, 0)), 0)
      FROM sales s
      LEFT JOIN (SELECT sale_id, COALESCE(SUM((unit_price * quantity - COALESCE(discount, 0)) - (COALESCE(buying_price_at_sale, 0) * quantity)), 0) AS total_profit FROM sale_items GROUP BY sale_id) sp ON sp.sale_id = s.id
      WHERE s.shop_id = $1 AND s.payment_method NOT IN ('cash', 'lipa_namba', 'bank', 'debt')
        AND s.payment_status = 'paid' AND s.sale_type IS DISTINCT FROM 'pre_order'
        AND s.updated_at >= $2 AND s.updated_at < $3
        AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.sale_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM debtors d WHERE d.sale_id = s.id)
      ${includeServices ? `
      UNION ALL
      SELECT COALESCE(SUM(sr.total), 0) FROM service_records sr
      WHERE sr.shop_id = $1 AND sr.created_at >= $2 AND sr.created_at < $3` : ''}
    ) combined
  `, [shopId, start, end]);
  return Number(r.rows[0]?.total_profit) || 0;
}

export async function todayDebts(shopId: string, start: Date, end: Date): Promise<{ total: number; count: number }> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0) AS total FROM debtors
     WHERE shop_id = $1 AND created_at >= $2 AND created_at < $3`,
    [shopId, start, end]
  );
  return { total: Number(r.rows[0]?.total) || 0, count: Number(r.rows[0]?.count) || 0 };
}

export async function todayExpenses(shopId: string): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
     WHERE shop_id = $1 AND date = (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date`,
    [shopId]
  );
  return Number(r.rows[0]?.total) || 0;
}

const buildSms = (shop: string, m: { revenue: number; profit: number; debts: number; expenses: number; net: number }) =>
  `Habari ${shop}! Mauzo ya leo: ${fmt(m.revenue)}. Faida: ${fmt(m.profit)}. Madeni: ${fmt(m.debts)}. ` +
  `Matumizi: ${fmt(m.expenses)}. Faida baada ya kutoa matumizi: ${fmt(m.net)}. - ALFEAN ENTERPRISES`;

const buildEmail = (ownerName: string, dateLabel: string, shops: any[]) => {
  const rows = shops.map((s) => `
    <div style="margin:0 0 14px;border:1px solid #e4e9f0;border-radius:14px;overflow:hidden;">
      <div style="background:#f0fdf4;padding:12px 16px;border-bottom:1px solid #dcfce7;">
        <p style="margin:0;font-size:14px;font-weight:bold;color:#065f46;">${s.shop}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:9px 16px;color:#64748b;">Mauzo ya leo</td><td style="padding:9px 16px;text-align:right;font-weight:bold;color:#0f172a;">${fmt(s.revenue)}</td></tr>
        <tr><td style="padding:9px 16px;color:#64748b;border-top:1px solid #f1f5f9;">Faida</td><td style="padding:9px 16px;text-align:right;font-weight:bold;color:#059669;border-top:1px solid #f1f5f9;">${fmt(s.profit)}</td></tr>
        <tr><td style="padding:9px 16px;color:#64748b;border-top:1px solid #f1f5f9;">Madeni mapya (${s.debtCount})</td><td style="padding:9px 16px;text-align:right;font-weight:bold;color:#dc2626;border-top:1px solid #f1f5f9;">${fmt(s.debts)}</td></tr>
        <tr><td style="padding:9px 16px;color:#64748b;border-top:1px solid #f1f5f9;">Matumizi</td><td style="padding:9px 16px;text-align:right;font-weight:bold;color:#d97706;border-top:1px solid #f1f5f9;">${fmt(s.expenses)}</td></tr>
        <tr><td style="padding:9px 16px;color:#0f172a;border-top:1px solid #e4e9f0;font-weight:bold;">Faida baada ya matumizi</td><td style="padding:9px 16px;text-align:right;font-weight:bold;color:${s.net >= 0 ? '#059669' : '#dc2626'};border-top:1px solid #e4e9f0;">${fmt(s.net)}</td></tr>
      </table>
    </div>`).join('');

  return `
  <div style="margin:0;padding:0;background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:24px 12px;">
      <div style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e9f0;">
        <div style="background:linear-gradient(135deg,#047857,#10b981);padding:22px 24px;">
          <p style="margin:0;color:#ffffff;font-size:20px;font-weight:bold;">ALFEAN ENTERPRISES</p>
          <p style="margin:4px 0 0;color:#d1fae5;font-size:12px;">Ripoti ya Mauzo ya Leo — ${dateLabel}</p>
        </div>
        <div style="padding:22px 24px 6px;">
          <p style="margin:0 0 14px;font-size:14px;color:#475569;">Habari <strong>${ownerName}</strong>, hii ni ripoti ya mauzo ya duka lako leo. </p>
          ${rows}
          <div style="text-align:center;padding:8px 0 14px;">
            <a href="${APP_URL}/dashboard" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:13px 28px;border-radius:12px;">Fungua Dashboard</a>
          </div>
        </div>
        <div style="background:#f9fafb;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">ALFEAN ENTERPRISES — Mfumo wa Mauzo Tanzania · Ripoti hii inatumwa kila siku saa 10:00 usiku</p>
        </div>
      </div>
    </div>
  </div>`;
};

export interface DailyReportMetrics {
  revenue: number;
  profit: number;
  debts: number;
  debtCount: number;
  expenses: number;
  net: number;
}

export interface DailyReportPreview {
  shop_id: string;
  shop_name: string;
  tenant_id: string | null;
  tenant_name: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  include_services: boolean;
  metrics: DailyReportMetrics;
  message: string;
  date_label: string;
}

// Computes today's (EAT) report for ONE shop — used by the developer "test
// before you send" tool and by the bulk job. Pure read: sends nothing.
export async function buildDailyReportForShop(shopId: string): Promise<DailyReportPreview | null> {
  const shopRes = await pool.query(`SELECT id, name, tenant_id FROM shops WHERE id = $1`, [shopId]);
  if (shopRes.rows.length === 0) return null;
  const shop = shopRes.rows[0];

  const { start, end } = eatDayRange();
  const includeServices = await getAddServicesToSales(shop.id);
  const [revenue, profit, debts, expenses] = await Promise.all([
    todayRevenue(shop.id, start, end, includeServices),
    todayProfit(shop.id, start, end, includeServices),
    todayDebts(shop.id, start, end),
    todayExpenses(shop.id),
  ]);
  const net = profit - expenses;

  let owner: any = null;
  if (shop.tenant_id) {
    const ownerRes = await pool.query(
      `SELECT t.name AS tenant_name, t.email AS tenant_email,
              u.phone AS owner_phone, COALESCE(u.name, t.name) AS owner_name
       FROM tenants t
       LEFT JOIN LATERAL (
         SELECT phone, name FROM "user"
         WHERE tenant_id = t.id::text AND role IN ('admin','owner') AND phone IS NOT NULL AND phone <> ''
         ORDER BY created_at ASC LIMIT 1
       ) u ON true
       WHERE t.id = $1 LIMIT 1`,
      [shop.tenant_id]
    );
    owner = ownerRes.rows[0] || null;
  }

  const metrics: DailyReportMetrics = { revenue, profit, debts: debts.total, debtCount: debts.count, expenses, net };
  return {
    shop_id: shop.id,
    shop_name: shop.name,
    tenant_id: shop.tenant_id || null,
    tenant_name: owner?.tenant_name || null,
    owner_name: owner?.owner_name || null,
    owner_phone: owner?.owner_phone || null,
    include_services: includeServices,
    metrics,
    message: buildSms(shop.name, metrics),
    date_label: new Date(Date.now() + 3 * 60 * 60 * 1000).toLocaleDateString('sw-TZ', { day: '2-digit', month: 'long', year: 'numeric' }),
  };
}

function normalizeReportPhone(phone: string): string {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.startsWith('0') ? `255${digits.slice(1)}` : digits;
}

/**
 * TEST one shop's report BEFORE the automated blast goes out. Sends the exact
 * message to a single phone (defaults to the shop owner, or pass your own) and
 * NEVER writes to daily_report_log — so the real 22:00 report still goes to
 * everyone that evening.
 */
export async function sendDailyReportTest(opts: { shopId: string; phone?: string; dryRun?: boolean }) {
  const preview = await buildDailyReportForShop(opts.shopId);
  if (!preview) throw new Error('Shop not found');

  const to = opts.phone ? normalizeReportPhone(opts.phone) : null;
  if (opts.dryRun || !to) {
    return { preview, sent: false, dryRun: true, to: to || preview.owner_phone || null };
  }
  if (!/^255\d{9}$/.test(to)) {
    throw new Error('A valid Tanzanian test phone is required (e.g. 2557XXXXXXXX)');
  }
  const res = await sendSms(to, preview.message, preview.tenant_id || undefined);
  return { preview, sent: res.success !== false, dryRun: false, to, error: res.error || null };
}

/**
 * Builds and sends today's report to every active PAID subscriber.
 *
 * options.markLog (default true) writes the per-shop/per-day sent marker used by
 * the cron to guarantee one report a day. Manual/test runs pass markLog=false so
 * a morning test can never suppress the real evening report.
 * options.shopIds restricts the run to specific shops (test/debug).
 * options.overridePhone redirects every SMS to one number (test/debug).
 * options.skipEmail disables the email half (test/debug).
 */
export async function sendDailySalesReports(options: {
  markLog?: boolean;
  shopIds?: string[];
  overridePhone?: string;
  skipEmail?: boolean;
} = {}): Promise<{ tenants: number; shops: number; smsSent: number; emailsSent: number }> {
  const markLog = options.markLog !== false;
  const onlyShops = options.shopIds && options.shopIds.length > 0 ? new Set(options.shopIds) : null;
  const { start, end } = eatDayRange();
  const dateLabel = new Date(Date.now() + 3 * 60 * 60 * 1000).toLocaleDateString('sw-TZ', { day: '2-digit', month: 'long', year: 'numeric' });

  // Recipients: every tenant with at least one shop. Subscription billing is
  // switched off for this deployment, so the report is not gated on a paid plan
  // anymore — shops that enable daily reports receive them.
  const recipients = await pool.query(`
    SELECT t.id AS tenant_id, t.name AS tenant_name, t.email AS tenant_email,
           u.phone AS owner_phone, COALESCE(u.name, t.name) AS owner_name
    FROM tenants t
    LEFT JOIN LATERAL (
      SELECT phone, name FROM "user"
      WHERE tenant_id = t.id::text AND role IN ('admin','owner') AND phone IS NOT NULL AND phone <> ''
      ORDER BY created_at ASC LIMIT 1
    ) u ON true
    GROUP BY t.id, t.name, t.email, u.phone, u.name
  `);

  let smsSent = 0;
  let emailsSent = 0;
  let shopsCount = 0;

  for (const r of recipients.rows) {
    try {
      const shopsRes = await pool.query(`SELECT id, name FROM shops WHERE tenant_id = $1 ORDER BY name ASC`, [r.tenant_id]);
      if (shopsRes.rows.length === 0) continue;

      const shopReports: any[] = [];
      for (const shop of shopsRes.rows) {
        if (onlyShops && !onlyShops.has(shop.id)) continue;
        shopsCount++;

        // One report per shop per day (auto run only)
        if (markLog) {
          const dup = await pool.query(
            `SELECT 1 FROM daily_report_log WHERE shop_id = $1 AND report_date = (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date`,
            [shop.id]
          );
          if (dup.rows.length > 0) { shopReports.push(null); continue; }
        }

        const includeServices = await getAddServicesToSales(shop.id);
        const [revenue, profit, debts, expenses] = await Promise.all([
          todayRevenue(shop.id, start, end, includeServices),
          todayProfit(shop.id, start, end, includeServices),
          todayDebts(shop.id, start, end),
          todayExpenses(shop.id),
        ]);
        const net = profit - expenses;
        const metrics = { revenue, profit, debts: debts.total, debtCount: debts.count, expenses, net };

        // SMS to the shop owner (or the test override number)
        let smsOk = false;
        const targetPhone = options.overridePhone || r.owner_phone;
        if (targetPhone) {
          try {
            const normalized = normalizeReportPhone(targetPhone);
            const res = await sendSms(normalized, buildSms(shop.name, metrics), r.tenant_id);
            smsOk = res.success !== false;
            if (smsOk) smsSent++;
          } catch (e: any) {
            console.warn(`[DailyReport] SMS failed for ${shop.name}:`, e.message);
          }
        }

        shopReports.push({ shop: shop.name, shopId: shop.id, smsOk, ...metrics });
        if (markLog) {
          await pool.query(
            `INSERT INTO daily_report_log (shop_id, report_date, sms_sent) VALUES ($1, (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date, $2)
             ON CONFLICT (shop_id, report_date) DO UPDATE SET sms_sent = daily_report_log.sms_sent OR EXCLUDED.sms_sent`,
            [shop.id, smsOk]
          );
        }
      }

      // One email per tenant with every shop's numbers
      const reportShops = shopReports.filter(Boolean);
      if (!options.skipEmail && reportShops.length > 0 && r.tenant_email) {
        try {
          await sendEmail({
            to: r.tenant_email,
            subject: `📊 Ripoti ya Mauzo ya Leo — ${dateLabel}`,
            html: buildEmail(r.owner_name || r.tenant_name, dateLabel, reportShops),
            name: r.owner_name || r.tenant_name,
            templateKey: 'daily_sales_report',
          });
          emailsSent++;
          if (markLog) {
            for (const s of reportShops) {
              await pool.query(
                `UPDATE daily_report_log SET email_sent = true WHERE shop_id = $1 AND report_date = (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date`,
                [s.shopId]
              );
            }
          }
        } catch (e: any) {
          console.warn(`[DailyReport] Email failed for ${r.tenant_id}:`, e.message);
        }
      }
    } catch (e: any) {
      console.error(`[DailyReport] Tenant ${r.tenant_id} failed:`, e.message);
    }
  }

  return { tenants: recipients.rows.length, shops: shopsCount, smsSent, emailsSent };
}

export function startDailySalesReportCron() {
  // 22:00 Tanzania time every day (explicit timezone so the server's local
  // timezone — usually UTC in Docker — can never shift the send time).
  cron.schedule('0 22 * * *', async () => {
    if (!(await isSmsAutomationEnabled('daily_sales_report'))) {
      console.log('[cron] Daily sales reports paused by developer — skipped');
      return;
    }
    console.log('[cron] Sending daily sales reports (22:00 EAT)...');
    try {
      const result = await sendDailySalesReports();
      console.log(`[cron] Daily sales reports: ${result.smsSent} SMS, ${result.emailsSent} email(s) across ${result.shops} shop(s)`);
    } catch (e: any) {
      console.error('[cron] Daily sales report error:', e.message);
    }
  }, { timezone: 'Africa/Dar_es_Salaam' });
  console.log('[cron] Daily sales report job registered (22:00 EAT, SMS + email, paid subscribers only)');
}
