/**
 * Near-expiry alerts — every morning at 08:00 Tanzania time each shop (and
 * store) owner/admin receives an email + SMS listing products that expire
 * within 30 days (or are already expired) while still in stock. The same list
 * is dropped into in-app notifications so it also shows on the dashboard.
 */
import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import { sendEmail } from '../services/email.service.js';
import { sendSms } from '../services/ehub-sms-adapter.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

const WINDOW_DAYS = 30;
const fmtDate = (d: any) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const fmtNum = (n: any) => Number(n) || 0;

function normalizePhone(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('0')) return '255' + digits.slice(1);
  if (digits.startsWith('255')) return digits;
  return digits;
}

function buildEmail(name: string, shopName: string, items: any[]) {
  const rows = items
    .map(
      (p) => `<tr>
        <td style="padding:8px 6px;border-bottom:1px solid #eef2f7">${p.name}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eef2f7;text-align:right">${fmtNum(p.current_stock)}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eef2f7;text-align:right">${fmtDate(p.expiry_date)}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:bold;color:${Number(p.days_left) < 0 ? '#dc2626' : Number(p.days_left) <= 7 ? '#d97706' : '#0d9488'}">
          ${Number(p.days_left) < 0 ? 'Imeisha' : `${p.days_left} siku`}
        </td>
      </tr>`
    )
    .join('');
  return `
  <div style="font-family:Arial,sans-serif;background:#f4f7f5;padding:20px">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:linear-gradient(120deg,#b45309,#d97706);padding:18px 22px">
        <h2 style="color:#fff;margin:0;font-size:17px">Bidhaa zinazokaribia kuisha muda — ${shopName}</h2>
      </div>
      <div style="padding:18px 22px">
        <p style="font-size:13px;color:#334155">Habari ${name || ''}, bidhaa zifuatazo zinakaribia (au zimekwisha) muda lakini bado zipo stock. Ziuze kwanza:</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr>
            <th style="text-align:left;padding:6px;color:#64748b">Bidhaa</th>
            <th style="text-align:right;padding:6px;color:#64748b">Stock</th>
            <th style="text-align:right;padding:6px;color:#64748b">Tarehe ya Kuisha</th>
            <th style="text-align:right;padding:6px;color:#64748b">Muda Uliobaki</th>
          </tr>
          ${rows}
        </table>
        <p style="color:#64748b;font-size:12px;margin-top:16px">Ingia ALFEAN ENTERPRISES kuona orodha kamili na kuchukua hatua.</p>
      </div>
      <div style="background:#f8fafc;padding:10px 22px;color:#94a3b8;font-size:11px">ALFEAN ENTERPRISES — Expiry Alerts</div>
    </div>
  </div>`;
}

function buildSms(shopName: string, items: any[]) {
  const top = items.slice(0, 3).map((p) => `${p.name} (${Number(p.days_left) < 0 ? 'imeisha' : `${p.days_left}d`})`).join(', ');
  const extra = items.length > 3 ? ` na ${items.length - 3} nyingine` : '';
  return `ALFEAN ENTERPRISES: ${shopName} ina bidhaa ${items.length} zinazokaribia kuisha muda: ${top}${extra}. Ziuze kwanza!`;
}

export async function runExpiryReminders(options: { skipSms?: boolean; skipEmail?: boolean; shopIds?: string[] } = {}) {
  const res = await pool.query(
    `SELECT p.id, p.name, p.current_stock, p.expiry_date,
            (p.expiry_date::date - CURRENT_DATE) AS days_left,
            s.id AS shop_id, s.name AS shop_name, s.phone AS shop_phone, s.email AS shop_email,
            s.tenant_id, s.type AS shop_type,
            t.email AS tenant_email, t.name AS tenant_name,
            u.phone AS owner_phone, COALESCE(u.name, t.name) AS owner_name
       FROM products p
       JOIN shops s ON s.id = p.shop_id
       LEFT JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN LATERAL (
         SELECT phone, name FROM "user"
          WHERE tenant_id = s.tenant_id::text AND role IN ('admin','owner') AND phone IS NOT NULL AND phone <> ''
          ORDER BY created_at ASC LIMIT 1
       ) u ON true
      WHERE p.is_active = true AND p.current_stock > 0
        AND p.expiry_date IS NOT NULL
        AND p.expiry_date <= CURRENT_DATE + ($1 || ' days')::interval
      ORDER BY s.name ASC, p.expiry_date ASC`,
    [WINDOW_DAYS]
  );

  const byShop = new Map<string, { shop: any; items: any[] }>();
  for (const row of res.rows) {
    if (options.shopIds && options.shopIds.length > 0 && !options.shopIds.includes(row.shop_id)) continue;
    if (!byShop.has(row.shop_id)) byShop.set(row.shop_id, { shop: row, items: [] });
    byShop.get(row.shop_id)!.items.push(row);
  }

  let smsSent = 0;
  let emailsSent = 0;

  for (const { shop, items } of byShop.values()) {
    const title = `Bidhaa ${items.length} zinakaribia kuisha muda`;
    const message = buildSms(shop.shop_name, items);

    // In-app notification for the shop/store team + tenant owners.
    try {
      const recipients = await pool.query(
        `SELECT DISTINCT u.id FROM "user" u
          WHERE u.id IN (SELECT user_id FROM user_shops WHERE shop_id = $1)
             OR ($2::text IS NOT NULL AND u.tenant_id = $2::text AND u.role IN ('admin','owner'))`,
        [shop.shop_id, shop.tenant_id]
      );
      for (const r of recipients.rows) {
        await pool.query(
          `INSERT INTO notifications (tenant_id, user_id, title, message, type, action_url, created_by)
           VALUES ($1, $2, $3, $4, 'expiry', $5, NULL)`,
          [shop.tenant_id, r.id, `⚠️ ${title} — ${shop.shop_name}`, message, shop.shop_type === 'store' ? '/store' : '/products']
        );
      }
    } catch (e: any) {
      console.warn(`[ExpiryAlerts] in-app notify failed for ${shop.shop_name}:`, e.message);
    }

    // SMS to the owner phone.
    if (!options.skipSms && shop.owner_phone) {
      try {
        const to = normalizePhone(shop.owner_phone);
        const result = await sendSms(to, message, shop.tenant_id || undefined);
        if (result.success !== false) smsSent++;
      } catch (e: any) {
        console.warn(`[ExpiryAlerts] SMS failed for ${shop.shop_name}:`, e.message);
      }
    }

    // Email to the tenant email (fallback: shop email).
    const emailTo = shop.tenant_email || shop.shop_email;
    if (!options.skipEmail && emailTo) {
      try {
        await sendEmail({
          to: emailTo,
          subject: `⚠️ Bidhaa zinazokaribia kuisha muda — ${shop.shop_name}`,
          html: buildEmail(shop.owner_name || shop.tenant_name, shop.shop_name, items),
          name: shop.owner_name || shop.tenant_name,
          templateKey: 'expiry_alert',
        });
        emailsSent++;
      } catch (e: any) {
        console.warn(`[ExpiryAlerts] Email failed for ${shop.shop_name}:`, e.message);
      }
    }
  }

  return { shops: byShop.size, products: res.rows.length, smsSent, emailsSent };
}

export function startExpiryReminderCron() {
  // 08:00 Tanzania time daily.
  cron.schedule(
    '0 8 * * *',
    async () => {
      if (!(await isSmsAutomationEnabled('shop_auto_sms'))) {
        console.log('[cron] Expiry alerts paused by developer — skipped');
        return;
      }
      console.log('[cron] Running near-expiry alerts (08:00 EAT)...');
      try {
        const r = await runExpiryReminders();
        console.log(`[cron] Expiry alerts: ${r.products} product(s) across ${r.shops} shop(s) — ${r.smsSent} SMS, ${r.emailsSent} email(s)`);
      } catch (e: any) {
        console.error('[cron] Expiry alert error:', e.message);
      }
    },
    { timezone: 'Africa/Dar_es_Salaam' }
  );
  console.log('[cron] Expiry reminder job registered (08:00 EAT, email + SMS + in-app)');
}
