/**
 * 5-Day Win-Back Promo Blast
 *
 * Every day, tenants who are NOT on an active paid subscription get one
 * promo email + SMS for 5 consecutive days:
 *   • active free trial
 *   • expired free trial
 *   • expired package
 *
 * Every send, open and click is recorded in `promo_events` so the developer
 * dashboard can report engagement per day (day 1 … day 5).
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

const PROMO_DAYS = 5;

export async function ensurePromoTables(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_campaign_state (
        tenant_id UUID PRIMARY KEY,
        day_no INTEGER NOT NULL DEFAULT 0,
        last_sent_on DATE,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        channel VARCHAR(10) NOT NULL,
        kind VARCHAR(10) NOT NULL,
        day_no INTEGER,
        meta JSONB DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS promo_events_created_idx ON promo_events(created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS promo_events_tenant_idx ON promo_events(tenant_id)`);
    console.log('✅ Promo tracking tables ready');
  } catch (e: any) {
    console.log('⚠️  Promo tables check:', e.message);
  }
}

const logPromoEvent = async (tenantId: string, channel: string, kind: string, dayNo: number | null, meta: any = {}) => {
  try {
    await pool.query(
      `INSERT INTO promo_events (tenant_id, channel, kind, day_no, meta) VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, channel, kind, dayNo, JSON.stringify(meta)]
    );
  } catch { /* non-fatal */ }
};

const fmtTZS = (n: number) => `TZS ${Number(n || 0).toLocaleString()}`;

// ─── Email (the green 50% promo, per-day personalisation) ────────────────────

const DAY_LINES: Record<number, string> = {
  1: 'Ofa hii ni kwa siku 5 tu — anza leo!',
  2: 'Siku 2 zimepita. Usikose nafasi hii!',
  3: 'Tunakukumbusha: siku 3 pekee zimebaki!',
  4: '⚠️ Siku 4 zimepita. Ofa inakaribia kuisha!',
  5: '🔔 SIKU YA MWISHO! Lipia leo kabla ofa kuisha.',
};

const buildPromoEmail = (opts: {
  name: string; day: number; offerPrice: number; regularPrice: number;
  clickUrl: string; openPixel: string;
}) => {
  const { name, day, offerPrice, regularPrice, clickUrl, openPixel } = opts;
  const dayLine = DAY_LINES[day] || DAY_LINES[1];
  return `<!DOCTYPE html>
<html lang="sw">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ALFEAN ENTERPRISES — Punguzo la 50%</title></head>
<body style="margin:0;padding:0;background-color:#eef1f8;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Punguzo la 50% — ${fmtTZS(regularPrice)} hadi ${fmtTZS(offerPrice)} pekee. ${dayLine}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1f8;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="height:6px;background:#16a34a;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="background:#16a34a;padding:36px 24px 52px;text-align:center;">
  <div style="display:inline-block;background:rgba(255,255,255,0.18);color:#f0fdf4;font-size:12px;letter-spacing:1px;font-weight:bold;padding:6px 14px;border-radius:999px;margin-bottom:14px;">OFA MAALUM · SIKU ${day}/5</div>
  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:800;">Karibu Tena${name ? ', ' + name : ''}! 🎉</h1>
  <p style="margin:10px 0 0;color:#dcfce7;font-size:14px;">Tumekuandalia ofa maalum ya kurudi kwenye mfumo wa <strong>ALFEAN ENTERPRISES POS</strong></p>
</td></tr>
<tr><td style="padding:0 24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;margin-top:-30px;border:1px solid #dcfce7;">
    <tr><td style="padding:22px 16px;text-align:center;">
      <p style="margin:0 0 6px;font-size:12.5px;letter-spacing:1px;color:#16a34a;font-weight:bold;">PUNGUZO LA ASILIMIA 50%</p>
      <p style="margin:0;">
        <span style="font-size:17px;color:#b0b4c0;text-decoration:line-through;">${fmtTZS(regularPrice)}</span>
        <span style="font-size:32px;color:#16a34a;font-weight:900;margin-left:8px;">${fmtTZS(offerPrice)}</span>
      </p>
      <p style="margin:8px 0 0;font-size:12.5px;color:#9ca3af;">⏰ ${dayLine}</p>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:26px 36px 8px;text-align:center;">
  <p style="margin:0;font-size:14.5px;color:#4b5563;line-height:1.7;">Kwa gharama hii ndogo, utapata huduma <strong>ZOTE</strong> bila kupunguziwa chochote — usimamizi kamili wa biashara yako mahali pamoja.</p>
</td></tr>
<tr><td style="padding:14px 20px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td width="50%" style="padding:6px;vertical-align:top;"><table role="presentation" width="100%" style="background:#f0fdf4;border-radius:10px;"><tr><td style="padding:14px;">
        <div style="font-size:20px;">📊</div><p style="margin:6px 0 2px;font-size:14px;font-weight:bold;color:#1f2937;">Ripoti za Mauzo</p><p style="margin:0;font-size:12.5px;color:#6b7280;">Fuatilia mauzo na faida kwa urahisi</p>
      </td></tr></table></td>
      <td width="50%" style="padding:6px;vertical-align:top;"><table role="presentation" width="100%" style="background:#f0fdf4;border-radius:10px;"><tr><td style="padding:14px;">
        <div style="font-size:20px;">🤖</div><p style="margin:6px 0 2px;font-size:14px;font-weight:bold;color:#1f2937;">AI Msaidizi</p><p style="margin:0;font-size:12.5px;color:#6b7280;">Msaada wa akili bandia wakati wowote</p>
      </td></tr></table></td>
    </tr>
    <tr>
      <td width="50%" style="padding:6px;vertical-align:top;"><table role="presentation" width="100%" style="background:#f0fdf4;border-radius:10px;"><tr><td style="padding:14px;">
        <div style="font-size:20px;">📒</div><p style="margin:6px 0 2px;font-size:14px;font-weight:bold;color:#1f2937;">Madeni</p><p style="margin:0;font-size:12.5px;color:#6b7280;">Kumbukumbu sahihi za deni na madai</p>
      </td></tr></table></td>
      <td width="50%" style="padding:6px;vertical-align:top;"><table role="presentation" width="100%" style="background:#f0fdf4;border-radius:10px;"><tr><td style="padding:14px;">
        <div style="font-size:20px;">👥</div><p style="margin:6px 0 2px;font-size:14px;font-weight:bold;color:#1f2937;">Wateja</p><p style="margin:0;font-size:12.5px;color:#6b7280;">Hifadhi taarifa za wateja wako wote</p>
      </td></tr></table></td>
    </tr>
    <tr>
      <td width="50%" style="padding:6px;vertical-align:top;"><table role="presentation" width="100%" style="background:#f0fdf4;border-radius:10px;"><tr><td style="padding:14px;">
        <div style="font-size:20px;">📩</div><p style="margin:6px 0 2px;font-size:14px;font-weight:bold;color:#1f2937;">Bulk SMS</p><p style="margin:0;font-size:12.5px;color:#6b7280;">Kumbusha wateja madeni au bidhaa mpya</p>
      </td></tr></table></td>
      <td width="50%" style="padding:6px;vertical-align:top;"><table role="presentation" width="100%" style="background:#f0fdf4;border-radius:10px;"><tr><td style="padding:14px;">
        <div style="font-size:20px;">🔗</div><p style="margin:6px 0 2px;font-size:14px;font-weight:bold;color:#1f2937;">Unganisha Biashara</p><p style="margin:0;font-size:12.5px;color:#6b7280;">Dashboard moja kwa biashara zote</p>
      </td></tr></table></td>
    </tr>
  </table>
</td></tr>
<tr><td style="padding:20px 24px 36px;text-align:center;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;width:100%;max-width:300px;">
    <tr><td style="background:#16a34a;border-radius:999px;text-align:center;">
      <a href="${clickUrl}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;padding:16px 10px;display:block;">JIUNGE SASA →</a>
    </td></tr>
  </table>
  <p style="margin:18px 0 0;font-size:12.5px;color:#9ca3af;">⏰ ${dayLine}</p>
</td></tr>
<tr><td style="background-color:#f9fafb;padding:22px 24px;text-align:center;border-top:1px solid #eee;">
  <p style="margin:0;font-size:12.5px;color:#9ca3af;">Karibu tena,<br><strong style="color:#6b7280;">Admin — ALFEAN ENTERPRISES POS</strong></p>
  <p style="margin:8px 0 0;font-size:11px;color:#cbd5e1;">simu: +${SUPPORT_WHATSAPP} · Lipa Namba: ${LIPA_NUMBER} (${LIPA_NAME})</p>
</td></tr>
</table>
</td></tr>
</table>
<img src="${openPixel}" width="1" height="1" alt="" style="display:block;" />
</body>
</html>`;
};

const buildPromoSms = (name: string, day: number, offerPrice: number, regularPrice: number, tenantId: string) =>
  `${name}, punguzo la 50%! ALFEAN ENTERPRISES POS sasa ${fmtTZS(offerPrice)} (badala ya ${fmtTZS(regularPrice)}) — siku ${day}/5. ` +
  `Lipia: Lipa Namba ${LIPA_NUMBER} (${LIPA_NAME}) au bonyeza: ${APP_URL}/r/s/${tenantId}/${day} - ALFEAN ENTERPRISES`;

// ─── The daily blast ─────────────────────────────────────────────────────────

export async function sendPromo5DayBlast() {
  await ensurePromoTables();

  // Cheapest active plan = the 50% offer price; regular = double.
  let offerPrice = 7500;
  try {
    const planRes = await pool.query(
      `SELECT price_tzs FROM subscription_plans WHERE is_active = true ORDER BY price_tzs ASC LIMIT 1`
    );
    if (planRes.rows.length > 0) offerPrice = Number(planRes.rows[0].price_tzs) || offerPrice;
  } catch { /* default */ }
  const regularPrice = offerPrice * 2;

  const audience = await pool.query(`
    SELECT t.id, t.name, t.email, t.phone, t.trial_end,
      (SELECT u.phone FROM "user" u
        WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner') AND u.phone IS NOT NULL
        LIMIT 1) as user_phone,
      EXISTS (
        SELECT 1 FROM tenant_subscriptions ts
        WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()
      ) as has_active
    FROM tenants t
    WHERE t.email IS NOT NULL AND t.email <> ''
  `);

  const states = await pool.query(`SELECT tenant_id, day_no, last_sent_on, completed_at FROM promo_campaign_state`);
  const stateMap = new Map<string, any>(states.rows.map((r: any) => [r.tenant_id, r]));

  const todayStr = new Date().toISOString().slice(0, 10);
  let emailsSent = 0;
  let smsSent = 0;
  let skipped = 0;

  for (const t of audience.rows) {
    if (t.has_active) { skipped++; continue; } // never promo active subscribers

    const st = stateMap.get(t.id);
    if (st?.completed_at) { skipped++; continue; }
    if (st?.last_sent_on && String(st.last_sent_on).slice(0, 10) === todayStr) { skipped++; continue; }

    const nextDay = (st?.day_no || 0) + 1;
    if (nextDay > PROMO_DAYS) {
      await pool.query(`UPDATE promo_campaign_state SET completed_at = NOW() WHERE tenant_id = $1`, [t.id]).catch(() => {});
      skipped++;
      continue;
    }

    const clickUrl = `${APP_URL}/r/e/${t.id}/${nextDay}`;
    const openPixel = `${APP_URL}/t/o/${t.id}/${nextDay}`;

    // Email
    try {
      await sendEmail({
        to: t.email,
        subject: nextDay >= 5
          ? `🔔 Siku ya mwisho! Punguzo 50% la ALFEAN ENTERPRISES linaisha leo`
          : `🎉 ${nextDay}/5: Punguzo la 50% kwa ALFEAN ENTERPRISES POS — ${fmtTZS(offerPrice)} pekee`,
        html: buildPromoEmail({ name: t.name || '', day: nextDay, offerPrice, regularPrice, clickUrl, openPixel }),
        name: t.name || 'Mteja',
        templateKey: 'promo_5day',
      });
      await logPromoEvent(t.id, 'email', 'sent', nextDay, { price: offerPrice });
      emailsSent++;
    } catch (e: any) {
      console.error(`[Promo5Day] email failed for ${t.email}:`, e.message);
    }

    // SMS
    const phone = t.user_phone || t.phone;
    if (phone) {
      try {
        const result = await sendSms(phone, buildPromoSms(t.name || 'Mteja', nextDay, offerPrice, regularPrice, t.id), t.id);
        if (result?.success) {
          await logPromoEvent(t.id, 'sms', 'sent', nextDay, { phone });
          smsSent++;
        }
      } catch (e: any) {
        console.error(`[Promo5Day] sms failed for ${phone}:`, e.message);
      }
    }

    // Advance campaign state
    await pool.query(
      `INSERT INTO promo_campaign_state (tenant_id, day_no, last_sent_on, completed_at)
       VALUES ($1, $2, CURRENT_DATE, CASE WHEN $2 >= $3 THEN NOW() ELSE NULL END)
       ON CONFLICT (tenant_id) DO UPDATE SET
         day_no = $2, last_sent_on = CURRENT_DATE,
         completed_at = CASE WHEN $2 >= $3 THEN NOW() ELSE NULL END`,
      [t.id, nextDay, PROMO_DAYS]
    ).catch((e: any) => console.error('[Promo5Day] state save failed:', e.message));
  }

  return { emailsSent, smsSent, skipped, audience: audience.rows.length };
}

export function startPromo5DayCron() {
  // Daily at 09:30 — one promo day per run, 5 days per tenant.
  cron.schedule('30 9 * * *', async () => {
    if (!(await isSmsAutomationEnabled('promo_5day'))) {
      console.log('[cron] Promo blast paused by developer — skipped');
      return;
    }
    console.log('[cron] Sending 5-day promo blast...');
    try {
      const r = await sendPromo5DayBlast();
      console.log(`[cron] Promo blast: ${r.emailsSent} email(s), ${r.smsSent} SMS, ${r.skipped} skipped (${r.audience} audience)`);
    } catch (e: any) {
      console.error('[cron] Promo blast error:', e.message);
    }
  });
  console.log('[cron] 5-day promo blast job registered (daily, email + SMS)');
}
