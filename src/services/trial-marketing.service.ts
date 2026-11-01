// =====================================================
// 7-DAY TRIAL-EXPIRED MARKETING (AI SMS + EMAIL)
// =====================================================
// Runs daily at 8:00 AM EAT. For 7 days after a tenant's free trial expires
// (and while they have no active paid subscription) it sends one AI-written
// SMS and one AI-written email per day, each focusing on a different ALFEAN ENTERPRISES
// benefit, with a clear call to action to reactivate.

import { pool } from '../config/drizzle.js';
import { sendEmail } from './email.service.js';
import { sendSystemMarketingSms } from './sms-reseller.service.js';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';
const RENEW_URL = `${APP_URL}/subscription`;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// One theme per campaign day.
const DAY_THEMES: Record<number, { title: string; focus: string }> = {
  1: { title: 'Uza kwa haraka', focus: 'POS ya haraka: barcode, risiti kwa sekunde, kazi bila mtandao (offline).' },
  2: { title: 'Jua stock yako', focus: 'Hesabu ya bidhaa kwa wakati halisi, tahadhari za stock ndogo na tarehe ya kumalizika.' },
  3: { title: 'Dhibiti madeni', focus: 'Kila deni limehifadhiwa: malipo ya sehemu, vikumbusho vya SMS na taarifa ya deni.' },
  4: { title: 'Jua faida yako', focus: 'Ripoti za mauzo, matumizi na faida halisi kwa siku/wiki/mwezi — kwa grafu rahisi.' },
  5: { title: 'Wasiliana na wateja', focus: 'Bulk SMS, auto SMS baada ya kila mauzo, vikumbusho vya malipo na kampeni za wateja.' },
  6: { title: 'Kua kwa usalama', focus: 'Maduka mengi, watumiaji na ruhusa, backup za cloud, usalama wa data na kazi kwenye simu.' },
  7: { title: 'Rudi ALFEAN ENTERPRISES leo', focus: 'Fursa ya mwisho: rudi uendelee kuuza, kufuatilia madeni na kukua. Msaada upo kwa simu.' },
};

const FALLBACK_SMS: Record<number, string> = {
  1: 'Habari {{name}}! Kipindi chako cha bure kimeisha. ALFEAN ENTERPRISES hukusaidia kuuza kwa haraka kwa barcode, risiti na kazi bila mtandao. Anzisha tena: ' + RENEW_URL,
  2: '{{name}}, jua stock yako kwa wakati halisi na upate tahadhari bidhaa zinapoisha. Endelea na ALFEAN ENTERPRISES: ' + RENEW_URL,
  3: 'Usipoteze madeni! ALFEAN ENTERPRISES hufuatilia kila deni, malipo ya sehemu na vikumbusho vya SMS. Rudia ALFEAN ENTERPRISES: ' + RENEW_URL,
  4: 'Jua faida yako kila siku. Ripoti za mauzo, matumizi na faida za ALFEAN ENTERPRISES ni rahisi kuelewa. Rudia ALFEAN ENTERPRISES: ' + RENEW_URL,
  5: 'Wasiliana na wateja wote kwa bulk SMS, auto SMS baada ya mauzo na vikumbusho. Rudi ALFEAN ENTERPRISES: ' + RENEW_URL,
  6: 'ALFEAN ENTERPRISES: maduka mengi, watumiaji na ruhusa, backup za cloud na usalama wa data. Endelea: ' + RENEW_URL,
  7: 'Fursa ya mwisho {{name}}! Rudi ALFEAN ENTERPRISES leo uendelee kuuza, kufuatilia madeni na kukua. Lipia: ' + RENEW_URL,
};

const FALLBACK_EMAIL: Record<number, { subject: string; body: string }> = {
  1: {
    subject: 'Uza kwa haraka tena na ALFEAN ENTERPRISES',
    body: '<p>Habari <strong>{{name}}</strong>,</p><p>Kipindi chako cha bure kimeisha — lakini biashara yako haiwezi kusubiri. ALFEAN ENTERPRISES inakusaidia:</p><ul><li>Kuuza kwa sekunde kwa barcode na utafutaji wa haraka</li><li>Risiti za kitaalamu kwa printer ya Bluetooth</li><li>Kazi bila mtandao (offline) — data inasawazishwa yenyewe</li></ul>',
  },
  2: {
    subject: 'Jua stock yako kila wakati',
    body: '<p>Habari <strong>{{name}}</strong>,</p><p>ALFEAN ENTERPRISES hukuonyesha hesabu halisi ya bidhaa zako:</p><ul><li>Tahadhari bidhaa zinapoisha (low stock)</li><li>Tarehe ya kumalizika kwa bidhaa</li><li>Ukaguzi wa stock (stock take) rahisi</li></ul>',
  },
  3: {
    subject: 'Usipoteze madeni yako tena',
    body: '<p>Habari <strong>{{name}}</strong>,</p><p>ALFEAN ENTERPRISES hufuatilia kila deni la mteja:</p><ul><li>Malipo ya sehemu na salio kwa wakati halisi</li><li>Vikumbusho vya SMS</li><li>Risiti na taarifa ya deni (PDF)</li></ul>',
  },
  4: {
    subject: 'Jua faida halisi ya biashara yako',
    body: '<p>Habari <strong>{{name}}</strong>,</p><p>ALFEAN ENTERPRISES hukuonyesha namba halisi za biashara yako:</p><ul><li>Mauzo, matumizi na faida halisi kwa kipindi chochote</li><li>Bidhaa zinazouza zaidi</li><li>Hamisha ripoti kwa Excel/PDF</li></ul>',
  },
  5: {
    subject: 'Wasiliana na wateja wako kwa urahisi',
    body: '<p>Habari <strong>{{name}}</strong>,</p><p>ALFEAN ENTERPRISES inakuunganisha na wateja wako:</p><ul><li>Bulk SMS na kampeni zenye ratiba</li><li>Auto SMS baada ya kila mauzo</li><li>Vikumbusho vya madeni na malipo</li></ul>',
  },
  6: {
    subject: 'Kua kwa usalama na ALFEAN ENTERPRISES',
    body: '<p>Habari <strong>{{name}}</strong>,</p><p>ALFEAN ENTERPRISES inakua pamoja na biashara yako:</p><ul><li>Maduka mengi chini ya akaunti moja</li><li>Watumiaji na ruhusa kwa kila muuzaji</li><li>Backup za cloud na usalama wa data</li></ul>',
  },
  7: {
    subject: 'Fursa ya mwisho — rudi ALFEAN ENTERPRISES leo',
    body: '<p>Habari <strong>{{name}}</strong>,</p><p>Hii ni siku ya mwisho ya kampeni yetu. Rudi ALFEAN ENTERPRISES uendelee kuuza, kufuatilia madeni na kukua. Msaada upo kwa simu na simu.</p>',
  },
};

function emailWrapper(title: string, bodyHtml: string): string {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto;">
    <div style="background: linear-gradient(135deg, #059669, #2563eb); padding: 24px 20px; border-radius: 10px 10px 0 0;">
      <h1 style="color: #fff; margin: 0; font-size: 20px;">${title}</h1>
      <p style="color: #d1fae5; margin: 6px 0 0; font-size: 13px;">ALFEAN ENTERPRISES — Mfumo wa kuendesha biashara yako</p>
    </div>
    <div style="background: #fff; padding: 22px 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px; color: #374151; font-size: 14px; line-height: 1.7;">
      ${bodyHtml}
      <p style="text-align: center; margin: 26px 0 10px;">
        <a href="${RENEW_URL}" style="display:inline-block; background:#059669; color:#fff; padding:13px 28px; border-radius:8px; text-decoration:none; font-weight:700;">Rudi ALFEAN ENTERPRISES Sasa</a>
      </p>
      <p style="font-size: 12px; color: #6b7280; text-align: center;">Au piga simu: +255 775 699 545 / +255 740 418 712</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 18px 0;" />
      <p style="font-size: 11px; color: #9ca3af;">Ulipokea barua pepe hii kwa sababu ulijiandikisha ALFEAN ENTERPRISES. Kama hutaki kupokea ujumbe huu, jibu kwa neno STOP.</p>
    </div>
  </div>`;
}

function personalise(text: string, tenantName: string): string {
  return text.replace(/\{\{name\}\}/g, tenantName || 'Mteja');
}

export async function generateTrialCampaignCopy(day: number, planSummary: string): Promise<{ sms: string; emailSubject: string; emailBody: string } | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  const theme = DAY_THEMES[day];
  if (!theme) return null;

  const prompt = `Andika ujumbe wa siku ya ${day} (kati ya 7) wa kampeni ya kumkaribisha tena mteja ambaye kipindi chake cha bure cha ALFEAN ENTERPRISES kimeisha.
Lengo la siku hii: ${theme.title} — ${theme.focus}
Mipango ya kulipia: ${planSummary}

KANUNI:
- Andika kwa KISWAHILI SANIFU, rafiki na wa heshima. Usimtishie wala kumsukuma kwa nguvu.
- SMS: herufi 140-160 kwa juu. Lazima iwe na neno ALFEAN ENTERPRISES na kiungo ${RENEW_URL}. Emoji moja (1) tu au hakuna. Tumia {{name}} kwa jina la mteja.
- Barua pepe: subject fupi yenye mvuto; body kwa HTML rahisi (p, ul, li, strong) yenye faida 3-4 za ALFEAN ENTERPRISES zinazohusiana na lengo la siku hii, kisha mwaliko wa kurudi. Tumia {{name}} kwa jina la mteja. USIWEKE <html>, <head> au <body>.
- Taja faida halisi za ALFEAN ENTERPRISES pekee: POS ya haraka, stock, madeni, ripoti/faida, SMS/bulk SMS, maduka mengi, backup, kazi bila mtandao.
- Jibu kwa JSON pekee bila maelezo mengine: {"sms":"...","emailSubject":"...","emailBody":"..."}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        messages: [
          { role: 'system', content: 'Wewe ni mtaalamu wa masoko wa ALFEAN ENTERPRISES (POS ya Tanzania). Jibu kwa JSON pekee.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 900,
        temperature: 0.6,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[TrialMarketing] AI HTTP ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (!parsed?.sms || !parsed?.emailSubject || !parsed?.emailBody) return null;
    return {
      sms: String(parsed.sms).slice(0, 320),
      emailSubject: String(parsed.emailSubject).slice(0, 160),
      emailBody: String(parsed.emailBody),
    };
  } catch (e: any) {
    console.warn('[TrialMarketing] AI generation failed:', e?.message);
    return null;
  }
}

async function ensureTrialMarketingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trial_marketing_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      day_number INTEGER NOT NULL,
      channel VARCHAR(10) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'sent',
      error TEXT,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, day_number, channel)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS trial_marketing_log_tenant_idx ON trial_marketing_log(tenant_id)`);
}

/**
 * Send the daily 7-day trial-expired campaign (AI SMS + email).
 * Safe to run more than once per day — sends are logged per tenant/day/channel.
 */
export async function sendTrialExpiredMarketing() {
  await ensureTrialMarketingTable();

  const recipients = await pool.query(`
    SELECT t.id, t.name AS tenant_name, t.email AS tenant_email, t.phone AS tenant_phone,
           t.trial_end,
           GREATEST(1, LEAST(7, CEIL(EXTRACT(EPOCH FROM (NOW() - t.trial_end)) / 86400)))::int AS day_number,
           (SELECT u.phone FROM "user" u
             WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner')
               AND u.phone IS NOT NULL AND u.phone != ''
             ORDER BY u.created_at LIMIT 1) AS owner_phone,
           (SELECT u.email FROM "user" u
             WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner')
               AND u.email IS NOT NULL AND u.email != ''
             ORDER BY u.created_at LIMIT 1) AS owner_email,
           (SELECT s.id FROM shops s WHERE s.tenant_id = t.id ORDER BY s.created_at LIMIT 1) AS shop_id
    FROM tenants t
    WHERE t.trial_activated = true
      AND t.trial_end IS NOT NULL
      AND t.trial_end < NOW()
      AND t.trial_end > NOW() - INTERVAL '8 days'
      AND COALESCE(t.is_active, true) = true
      AND NOT EXISTS (
        SELECT 1 FROM tenant_subscriptions ts
        WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()
      )
    ORDER BY t.trial_end ASC
  `);

  if (recipients.rows.length === 0) {
    console.log('[TrialMarketing] No trial-expired tenants in the 7-day window');
    return { tenants: 0, smsSent: 0, emailsSent: 0 };
  }

  // Plan summary for the AI prompt (falls back gracefully).
  let planSummary = 'Mipango ya ALFEAN ENTERPRISES inaanzia TSh 7,500/mwezi.';
  try {
    const plans = await pool.query(
      `SELECT name, price_tzs, duration_days FROM subscription_plans WHERE is_active = true ORDER BY duration_days ASC LIMIT 4`
    );
    if (plans.rows.length > 0) {
      planSummary = plans.rows.map((p: any) => `${p.name}: TZS ${Number(p.price_tzs).toLocaleString()}/${p.duration_days} siku`).join(', ');
    }
  } catch {}

  // Generate copy once per campaign day, then personalise per tenant.
  const copyCache = new Map<number, { sms: string; emailSubject: string; emailBody: string }>();
  const usedDays = [...new Set(recipients.rows.map((r: any) => r.day_number))];
  for (const day of usedDays) {
    const ai = await generateTrialCampaignCopy(day, planSummary);
    if (ai) {
      copyCache.set(day, ai);
    } else {
      const fb = FALLBACK_EMAIL[day] || FALLBACK_EMAIL[1];
      copyCache.set(day, { sms: FALLBACK_SMS[day] || FALLBACK_SMS[1], emailSubject: fb.subject, emailBody: fb.body });
    }
  }

  let smsSent = 0;
  let emailsSent = 0;

  for (const r of recipients.rows) {
    const day: number = r.day_number;
    const copy = copyCache.get(day)!;
    const name = r.tenant_name || 'Mteja';
    const phone = r.owner_phone || r.tenant_phone || null;
    const email = r.owner_email || r.tenant_email || null;

    // ── SMS ──
    if (phone) {
      const already = await pool.query(
        `SELECT 1 FROM trial_marketing_log WHERE tenant_id = $1 AND day_number = $2 AND channel = 'sms'`,
        [r.id, day]
      );
      if (already.rows.length === 0) {
        const message = personalise(copy.sms, name);
        const result = await sendSystemMarketingSms({ shopId: r.shop_id, phone, message });
        await pool.query(
          `INSERT INTO trial_marketing_log (tenant_id, day_number, channel, status, error)
           VALUES ($1, $2, 'sms', $3, $4) ON CONFLICT DO NOTHING`,
          [r.id, day, result.success ? 'sent' : 'failed', result.success ? null : (result.error || 'unknown')]
        );
        if (result.success) smsSent++;
        else console.warn(`[TrialMarketing] SMS failed for ${name}: ${result.error}`);
      }
    }

    // ── EMAIL ──
    if (email) {
      const already = await pool.query(
        `SELECT 1 FROM trial_marketing_log WHERE tenant_id = $1 AND day_number = $2 AND channel = 'email'`,
        [r.id, day]
      );
      if (already.rows.length === 0) {
        try {
          await sendEmail({
            to: email,
            subject: personalise(copy.emailSubject, name),
            html: emailWrapper(personalise(copy.emailSubject, name), personalise(copy.emailBody, name)),
            name,
            templateKey: 'trial_expired_marketing',
          });
          await pool.query(
            `INSERT INTO trial_marketing_log (tenant_id, day_number, channel, status)
             VALUES ($1, $2, 'email', 'sent') ON CONFLICT DO NOTHING`,
            [r.id, day]
          );
          emailsSent++;
        } catch (e: any) {
          await pool.query(
            `INSERT INTO trial_marketing_log (tenant_id, day_number, channel, status, error)
             VALUES ($1, $2, 'email', 'failed', $3) ON CONFLICT DO NOTHING`,
            [r.id, day, e?.message || 'unknown']
          );
          console.warn(`[TrialMarketing] Email failed for ${email}:`, e?.message);
        }
      }
    }

    // Gentle pacing for provider limits.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(`[TrialMarketing] Day-1-7 campaign: ${recipients.rows.length} tenants, ${smsSent} SMS, ${emailsSent} emails`);
  return { tenants: recipients.rows.length, smsSent, emailsSent };
}
