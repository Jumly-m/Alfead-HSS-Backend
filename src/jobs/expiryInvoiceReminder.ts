/**
 * Invoice-style expiry reminders.
 *
 * 5 days before a free trial OR a paid package expires, the owner receives:
 *   • a short Swahili SMS, and
 *   • a professional "invoice" email (amount due, expiry date, payment steps).
 *
 * Runs once daily at 10:30. The 4–5 day window means each tenant is reminded
 * exactly once per expiry cycle (a kept trial/subscription gets fresh reminders
 * for the new period).
 */
import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import { sendEmail } from '../services/email.service.js';
import { sendSms } from '../services/ehub-sms-adapter.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';
const SUPPORT_WHATSAPP = (process.env.WHATSAPP_NUMBER || '255775699545').replace(/\D/g, '');
const LIPA_NUMBER = '163227935';
const LIPA_NAME = 'JM TECH';
const LIPA_PROVIDER = 'Mixx by Yas';

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTZS = (n: number) => `TZS ${Number(n || 0).toLocaleString()}`;

// ─── SMS (short, warm Swahili) ───────────────────────────────────────────────

const buildSms = (name: string, amount: number, endDate: Date) =>
  `Habari ${name}! Package yako ya ALFEAN ENTERPRISES inaisha ${fmtDate(endDate)} (siku 5 zijazo). ` +
  `Lipia ${fmtTZS(amount)} kabla ya tarehe hiyo ili usipoteze access ya mfumo, hesabu zako na ripoti. ` +
  `Lipa: ${LIPA_PROVIDER} Lipa Namba ${LIPA_NUMBER} (${LIPA_NAME}) au ${APP_URL}/subscription - ALFEAN ENTERPRISES`;

// ─── Email (professional invoice card) ───────────────────────────────────────

const buildInvoiceHtml = (opts: { name: string; planName: string; amount: number; endDate: Date; daysLeft: number; isTrial: boolean }) => {
  const { name, planName, amount, endDate, daysLeft, isTrial } = opts;
  return `
  <div style="margin:0;padding:0;background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:24px 12px;">
      <div style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e9f0;">
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#047857,#10b981);padding:22px 24px;">
          <p style="margin:0;color:#ffffff;font-size:20px;font-weight:bold;">ALFEAN ENTERPRISES</p>
          <p style="margin:4px 0 0;color:#d1fae5;font-size:12px;">Mfumo wa Mauzo &amp; Usimamizi wa Duka</p>
        </div>
        <!-- Title -->
        <div style="padding:22px 24px 6px;">
          <p style="margin:0;font-size:16px;font-weight:bold;color:#0f172a;">${isTrial ? 'Notisi ya Malipo — Jaribio Lako Linaisha' : 'Notisi ya Malipo — Package Yako Inaisha'}</p>
          <p style="margin:8px 0 0;font-size:13px;color:#475569;line-height:1.6;">
            Habari <strong>${name}</strong>, tunakukumbusha kulipia kabla package haijaisha tarehe
            <strong>${fmtDate(endDate)}</strong> (siku <strong>${daysLeft}</strong> zijazo) ili usipoteze access
            ya mfumo, hesabu zako na ripoti.
          </p>
        </div>
        <!-- Invoice rows -->
        <div style="padding:14px 24px;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr>
              <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e4e9f0;color:#64748b;">Mpango</td>
              <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e4e9f0;color:#0f172a;font-weight:bold;">${planName}</td>
            </tr>
            <tr>
              <td style="padding:10px 12px;border:1px solid #e4e9f0;color:#64748b;">Kiasi cha Kulipa</td>
              <td style="padding:10px 12px;border:1px solid #e4e9f0;color:#047857;font-weight:bold;font-size:15px;">${fmtTZS(amount)}</td>
            </tr>
            <tr>
              <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e4e9f0;color:#64748b;">Tarehe ya Kuisha</td>
              <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e4e9f0;color:#dc2626;font-weight:bold;">${fmtDate(endDate)}</td>
            </tr>
          </table>
        </div>
        <!-- Payment -->
        <div style="padding:0 24px 8px;">
          <div style="border:1px solid #fde68a;background:#fffbeb;border-radius:12px;padding:14px 16px;">
            <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#b45309;">JINSI YA KULIPA</p>
            <p style="margin:0;font-size:13px;color:#475569;line-height:1.7;">
              <strong>${LIPA_PROVIDER} — Lipa Namba</strong><br/>
              <span style="font-size:20px;font-weight:bold;color:#047857;letter-spacing:2px;">${LIPA_NUMBER}</span><br/>
              Jina: <strong>${LIPA_NAME}</strong><br/>
              Weka kiasi <strong>${fmtTZS(amount)}</strong>, kisha tuma risiti kwa simu
              <strong>+${SUPPORT_WHATSAPP}</strong> ili package yako iwashwe haraka.
            </p>
          </div>
        </div>
        <!-- CTA -->
        <div style="padding:8px 24px 4px;text-align:center;">
          <a href="${APP_URL}/subscription" style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:13px 28px;border-radius:12px;">Lipia Sasa</a>
        </div>
        <div style="padding:14px 24px 22px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">
            Una swali? Piga <strong>+${SUPPORT_WHATSAPP}</strong>
          </p>
          <p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;">ALFEAN ENTERPRISES — Mfumo wa Mauzo Tanzania</p>
        </div>
      </div>
    </div>
  </div>`;
};

// ─── Job ─────────────────────────────────────────────────────────────────────

export async function sendExpiryInvoiceReminders() {
  let smsSent = 0;
  let emailsSent = 0;
  let total = 0;

  // Cheapest active plan = the upgrade offer for trial users.
  let fallbackPlan = { name: 'Basic/Mwezi mmoja', price_tzs: 7500 };
  try {
    const planRes = await pool.query(
      `SELECT name, price_tzs FROM subscription_plans WHERE is_active = true ORDER BY price_tzs ASC LIMIT 1`
    );
    if (planRes.rows.length > 0) fallbackPlan = planRes.rows[0];
  } catch { /* keep default */ }

  const recipients: Array<{
    tenantId: string; name: string; email: string | null; phone: string | null;
    planName: string; amount: number; endDate: Date; isTrial: boolean;
  }> = [];

  // 1) Free trials expiring in 4–5 days (no active paid subscription)
  try {
    const trials = await pool.query(`
      SELECT t.id, t.name, t.email, t.phone, t.trial_end,
        (SELECT u.phone FROM "user" u
          WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner') AND u.phone IS NOT NULL
          LIMIT 1) as user_phone
      FROM tenants t
      WHERE t.trial_activated = true
        AND t.trial_end IS NOT NULL
        AND t.trial_end > NOW() + INTERVAL '4 days'
        AND t.trial_end <= NOW() + INTERVAL '5 days'
        AND NOT EXISTS (
          SELECT 1 FROM tenant_subscriptions ts
          WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()
        )
    `);
    for (const row of trials.rows) {
      recipients.push({
        tenantId: row.id,
        name: row.name || 'Mteja',
        email: row.email || null,
        phone: row.user_phone || row.phone || null,
        planName: fallbackPlan.name,
        amount: Number(fallbackPlan.price_tzs) || 0,
        endDate: new Date(row.trial_end),
        isTrial: true,
      });
    }
  } catch (e: any) {
    console.error('[ExpiryInvoice] trial query error:', e.message);
  }

  // 2) Active paid subscriptions expiring in 4–5 days (renewal reminder)
  try {
    const subs = await pool.query(`
      SELECT ts.id, ts.current_period_end, t.id as tenant_id, t.name, t.email, t.phone,
        sp.name as plan_name, sp.price_tzs,
        (SELECT u.phone FROM "user" u
          WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner') AND u.phone IS NOT NULL
          LIMIT 1) as user_phone
      FROM tenant_subscriptions ts
      JOIN tenants t ON t.id = ts.tenant_id
      JOIN subscription_plans sp ON sp.id = ts.plan_id
      WHERE ts.status = 'active'
        AND ts.current_period_end > NOW() + INTERVAL '4 days'
        AND ts.current_period_end <= NOW() + INTERVAL '5 days'
    `);
    for (const row of subs.rows) {
      recipients.push({
        tenantId: row.tenant_id,
        name: row.name || 'Mteja',
        email: row.email || null,
        phone: row.user_phone || row.phone || null,
        planName: row.plan_name || fallbackPlan.name,
        amount: Number(row.price_tzs) || Number(fallbackPlan.price_tzs) || 0,
        endDate: new Date(row.current_period_end),
        isTrial: false,
      });
    }
  } catch (e: any) {
    console.error('[ExpiryInvoice] subscription query error:', e.message);
  }

  total = recipients.length;
  if (total === 0) {
    console.log('[ExpiryInvoice] No packages expiring in 5 days');
    return { smsSent: 0, emailsSent: 0, total: 0 };
  }

  for (const r of recipients) {
    const daysLeft = Math.max(1, Math.ceil((r.endDate.getTime() - Date.now()) / 86400000));

    // SMS (short Swahili)
    if (r.phone) {
      try {
        const sms = buildSms(r.name, r.amount, r.endDate);
        const result = await sendSms(r.phone, sms, r.tenantId);
        if (result?.success) smsSent++;
      } catch (e: any) {
        console.error(`[ExpiryInvoice] SMS failed for ${r.tenantId}:`, e.message);
      }
    }

    // Email (invoice card)
    if (r.email) {
      try {
        const subject = r.isTrial
          ? `🗓️ Jaribio lako la ALFEAN ENTERPRISES linaisha ${fmtDate(r.endDate)} — lipia ${fmtTZS(r.amount)}`
          : `🧾 Notisi ya Malipo: package yako ya ALFEAN ENTERPRISES inaisha ${fmtDate(r.endDate)}`;
        const result = await sendEmail({
          to: r.email,
          subject,
          html: buildInvoiceHtml({
            name: r.name,
            planName: r.planName,
            amount: r.amount,
            endDate: r.endDate,
            daysLeft,
            isTrial: r.isTrial,
          }),
          name: r.name,
          templateKey: 'expiry_invoice_reminder',
        });
        if (result?.success) emailsSent++;
      } catch (e: any) {
        console.error(`[ExpiryInvoice] Email failed for ${r.tenantId}:`, e.message);
      }
    }
  }

  return { smsSent, emailsSent, total };
}

export function startExpiryInvoiceReminderCron() {
  // Daily at 10:30 — after the 9:00 expiry sweep, before the 11–13h reminders.
  cron.schedule('30 10 * * *', async () => {
    if (!(await isSmsAutomationEnabled('expiry_invoice'))) {
      console.log('[cron] Expiry invoice reminders paused by developer — skipped');
      return;
    }
    console.log('[cron] Sending 5-day expiry invoice reminders...');
    try {
      const result = await sendExpiryInvoiceReminders();
      console.log(`[cron] Expiry invoice reminders: ${result.emailsSent} email(s), ${result.smsSent} SMS (${result.total} due)`);
    } catch (e: any) {
      console.error('[cron] Expiry invoice reminder error:', e.message);
    }
  });
  console.log('[cron] Expiry invoice reminder job registered (5 days before, SMS + email)');
}
