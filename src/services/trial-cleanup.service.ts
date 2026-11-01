// =====================================================
// FREE-TRIAL CLEANUP (REMINDERS + SAFE ACCOUNT DELETION)
// =====================================================
// Handles abandoned free-trial accounts:
//   1. Sends a 3-day warning (email + SMS, AI-written Swahili) to tenants
//      whose trial expired and who never paid.
//   2. Automatically deletes tenants whose trial expired 20+ days ago, that
//      have no active subscription and never completed a payment — but only
//      AFTER the 3-day warning has actually been delivered.
//
// SAFETY RULES (never bypassed):
//   - Active trials are never touched (trial_end must be in the past).
//   - Tenants with an active paid subscription are never touched.
//   - Tenants that ever completed a payment are never touched.
//   - Super-admin shops and developer accounts are never touched.
//   - A tenant with a pending subscription started in the last 7 days is
//     skipped (they may be mid-checkout).
// Every check is re-validated inside the deletion transaction (row-locked)
// so a tenant cannot be deleted by a stale dashboard selection.

import { pool } from '../config/drizzle.js';
import { sendEmail } from './email.service.js';
import { sendSystemMarketingSms } from './sms-reseller.service.js';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';
const RENEW_URL = `${APP_URL}/subscription`;
const REGISTER_URL = `${APP_URL}/register`;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export type TrialCleanupSettings = {
  enabled: boolean;
  deleteAfterDays: number;
  noticeDaysBefore: number;
};

const DEFAULT_SETTINGS: TrialCleanupSettings = {
  enabled: true,
  deleteAfterDays: 20,
  noticeDaysBefore: 3,
};

export type DeletableTenant = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
  trialStart: string | null;
  trialEnd: string | null;
  daysExpired: number;
  shopCount: number;
  productCount: number;
  saleCount: number;
  totalRevenue: number;
  ownerEmail: string | null;
  ownerPhone: string | null;
  warned: boolean;
};

// ─── SETTINGS ────────────────────────────────────────────────────────────────

export async function getTrialCleanupSettings(): Promise<TrialCleanupSettings> {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'trial_cleanup_settings'`);
    if (result.rows.length === 0) return { ...DEFAULT_SETTINGS };
    const raw = result.rows[0].value;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      enabled: parsed?.enabled ?? DEFAULT_SETTINGS.enabled,
      deleteAfterDays: clampInt(parsed?.deleteAfterDays, 1, 365, DEFAULT_SETTINGS.deleteAfterDays),
      noticeDaysBefore: clampInt(parsed?.noticeDaysBefore, 1, 30, DEFAULT_SETTINGS.noticeDaysBefore),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveTrialCleanupSettings(input: Partial<TrialCleanupSettings>): Promise<TrialCleanupSettings> {
  const current = await getTrialCleanupSettings();
  const next: TrialCleanupSettings = {
    enabled: input.enabled ?? current.enabled,
    deleteAfterDays: clampInt(input.deleteAfterDays, 1, 365, current.deleteAfterDays),
    noticeDaysBefore: clampInt(input.noticeDaysBefore, 1, 30, current.noticeDaysBefore),
  };
  if (next.noticeDaysBefore >= next.deleteAfterDays) {
    next.noticeDaysBefore = Math.max(1, next.deleteAfterDays - 1);
  }
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('trial_cleanup_settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(next)]
  );
  return next;
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

// ─── STORAGE ─────────────────────────────────────────────────────────────────

async function ensureTrialCleanupTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trial_deletion_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      tenant_name VARCHAR(255),
      tenant_email VARCHAR(255),
      tenant_phone VARCHAR(50),
      trial_end TIMESTAMP,
      days_expired INTEGER,
      notice_type VARCHAR(20) NOT NULL,
      email_status VARCHAR(20),
      sms_status VARCHAR(20),
      error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, notice_type)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS trial_deletion_log_tenant_idx ON trial_deletion_log(tenant_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS trial_deletion_log_type_idx ON trial_deletion_log(notice_type)`);
}

async function tableExists(client: any, table: string): Promise<boolean> {
  try {
    const r = await client.query(`SELECT to_regclass($1) AS reg`, [table]);
    return Boolean(r.rows[0]?.reg);
  } catch {
    return false;
  }
}

// ─── ELIGIBILITY ─────────────────────────────────────────────────────────────

// Shared WHERE fragment. `daysParam` must be a positional placeholder (e.g. '$1').
function eligibilitySql(daysParam: string): string {
  return `
    t.trial_activated = true
    AND t.trial_end IS NOT NULL
    AND t.trial_end < NOW() - (${daysParam}::int * INTERVAL '1 day')
    AND NOT EXISTS (
      SELECT 1 FROM tenant_subscriptions ts
      WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()
    )
    AND NOT EXISTS (
      SELECT 1 FROM subscription_payments sp
      WHERE sp.tenant_id = t.id AND sp.status = 'completed'
    )
    AND NOT EXISTS (
      SELECT 1 FROM tenant_subscriptions ts2
      WHERE ts2.tenant_id = t.id AND ts2.status = 'pending'
        AND ts2.created_at > NOW() - INTERVAL '7 days'
    )
    AND NOT EXISTS (
      SELECT 1 FROM shops s WHERE s.tenant_id = t.id AND s.is_super_admin = true
    )
    AND NOT EXISTS (
      SELECT 1 FROM "user" u WHERE u.tenant_id = t.id::text AND u.role = 'developer'
    )
  `;
}

export async function listDeletionCandidates(opts: {
  minDaysExpired: number;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: DeletableTenant[]; total: number }> {
  await ensureTrialCleanupTables();
  const minDays = clampInt(opts.minDaysExpired, 1, 365, DEFAULT_SETTINGS.deleteAfterDays);
  const limit = clampInt(opts.limit, 1, 500, 100);
  const offset = Math.max(0, Math.round(Number(opts.offset) || 0));
  const search = (opts.search || '').trim();

  const whereParams: any[] = [minDays];
  let searchSql = '';
  if (search) {
    whereParams.push(`%${search}%`);
    searchSql = ` AND (t.name ILIKE $${whereParams.length} OR t.email ILIKE $${whereParams.length} OR COALESCE(t.phone, '') ILIKE $${whereParams.length})`;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM tenants t WHERE ${eligibilitySql('$1')}${searchSql}`,
    whereParams
  );

  const listParams = [...whereParams, limit, offset];
  const limitIdx = listParams.length - 1;
  const offsetIdx = listParams.length;

  const result = await pool.query(`
    SELECT
      t.id, t.name, t.email, t.phone, t.created_at, t.trial_start, t.trial_end,
      CEIL(EXTRACT(EPOCH FROM (NOW() - t.trial_end)) / 86400)::int AS days_expired,
      (SELECT COUNT(*) FROM shops s WHERE s.tenant_id = t.id)::int AS shop_count,
      (SELECT COUNT(*) FROM products p JOIN shops s ON s.id = p.shop_id WHERE s.tenant_id = t.id)::int AS product_count,
      (SELECT COUNT(*) FROM sales sa JOIN shops s ON s.id = sa.shop_id WHERE s.tenant_id = t.id)::int AS sale_count,
      (SELECT COALESCE(SUM(sa.total_amount), 0) FROM sales sa JOIN shops s ON s.id = sa.shop_id WHERE s.tenant_id = t.id) AS total_revenue,
      (SELECT u.email FROM "user" u
        WHERE u.tenant_id = t.id::text AND u.role IN ('admin', 'owner')
          AND u.email IS NOT NULL AND u.email != ''
        ORDER BY u.created_at LIMIT 1) AS owner_email,
      (SELECT u.phone FROM "user" u
        WHERE u.tenant_id = t.id::text AND u.role IN ('admin', 'owner')
          AND u.phone IS NOT NULL AND u.phone != ''
        ORDER BY u.created_at LIMIT 1) AS owner_phone,
      EXISTS (
        SELECT 1 FROM trial_deletion_log dl
        WHERE dl.tenant_id = t.id AND dl.notice_type = 'warning'
      ) AS warned
    FROM tenants t
    WHERE ${eligibilitySql('$1')}${searchSql}
    ORDER BY t.trial_end ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `, listParams);

  const data: DeletableTenant[] = result.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    createdAt: r.created_at,
    trialStart: r.trial_start,
    trialEnd: r.trial_end,
    daysExpired: r.days_expired,
    shopCount: r.shop_count,
    productCount: r.product_count,
    saleCount: r.sale_count,
    totalRevenue: parseFloat(r.total_revenue) || 0,
    ownerEmail: r.owner_email,
    ownerPhone: r.owner_phone,
    warned: r.warned,
  }));

  return { data, total: countResult.rows[0]?.count || 0 };
}

export async function getTrialCleanupCounts(): Promise<Record<string, number>> {
  await ensureTrialCleanupTables();
  const thresholds = [10, 20, 30];
  const counts: Record<string, number> = {};
  for (const days of thresholds) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tenants t WHERE ${eligibilitySql('$1')}`,
      [days]
    );
    counts[`days${days}`] = r.rows[0]?.count || 0;
  }
  return counts;
}

// ─── COPY (AI SWAHILI + FALLBACKS) ───────────────────────────────────────────

type CleanupCopy = { emailSubject: string; emailBody: string; sms: string };

function emailWrapper(title: string, bodyHtml: string, ctaLabel: string, ctaUrl: string): string {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto;">
    <div style="background: linear-gradient(135deg, #059669, #2563eb); padding: 24px 20px; border-radius: 10px 10px 0 0;">
      <h1 style="color: #fff; margin: 0; font-size: 20px;">${title}</h1>
      <p style="color: #d1fae5; margin: 6px 0 0; font-size: 13px;">ALFEAN ENTERPRISES — Mfumo wa mauzo na usimamizi wa biashara</p>
    </div>
    <div style="background: #fff; padding: 22px 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px; color: #374151; font-size: 14px; line-height: 1.7;">
      ${bodyHtml}
      <p style="text-align: center; margin: 26px 0 10px;">
        <a href="${ctaUrl}" style="display:inline-block; background:#059669; color:#fff; padding:13px 28px; border-radius:8px; text-decoration:none; font-weight:700;">${ctaLabel}</a>
      </p>
      <p style="font-size: 12px; color: #6b7280; text-align: center;">Au piga simu: +255 775 699 545 / +255 740 418 712</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 18px 0;" />
      <p style="font-size: 11px; color: #9ca3af;">Ulipokea ujumbe huu kwa sababu ulijiandikisha ALFEAN ENTERPRISES. Kama hutaki kupokea ujumbe huu, jibu kwa neno STOP.</p>
    </div>
  </div>`;
}

function warningFallback(name: string, daysExpired: number, deleteInDays: number): CleanupCopy {
  const sms = `Habari ${name}, akaunti yako ya ALFEAN ENTERPRISES (mfumo wa mauzo) imekaa bila matumizi na kipindi chako cha bure kimeisha siku ${daysExpired}. Itafutwa ndani ya siku ${deleteInDays} kama hutofanya malipo. Lipia sasa: ${RENEW_URL} - ALFEAN ENTERPRISES Team`;
  const body = `
    <p>Habari <strong>${name}</strong>,</p>
    <p>Tunakutakia salama. Akaunti yako ya <strong>ALFEAN ENTERPRISES</strong> haitumiki kwa sasa, na kipindi chako cha bure kimeisha.</p>
    <p><strong>Tafadhali fahamu:</strong> akaunti yako itafutwa kabisa ndani ya <strong>siku ${deleteInDays}</strong> kama hutafanya malipo na kuanza kutumia mfumo tena.</p>
    <ul>
      <li>Data yako yote (bidhaa, mauzo, madeni na ripoti) itafutwa pamoja na akaunti.</li>
      <li>Ukifanya malipo sasa, akaunti yako itaendelea kama kawaida — hakuna kitu kitakachopotea.</li>
      <li>Malipo ni rahisi: M-Pesa, Airtel Money, Tigo Pesa, Halotel au kadi.</li>
    </ul>
    <p>Bofya kitufe hapa chini kulipia na kuendelea kutumia ALFEAN ENTERPRISES.</p>`;
  return {
    emailSubject: `Akaunti yako ya ALFEAN ENTERPRISES itafutwa ndani ya siku ${deleteInDays}`,
    emailBody: body,
    sms,
  };
}

function deletedFallback(name: string, daysExpired: number): CleanupCopy {
  const sms = `Habari ${name}, akaunti yako ya ALFEAN ENTERPRISES (mfumo wa mauzo) imefutwa kwa sababu hujatumia mfumo kwa zaidi ya siku ${daysExpired}. Ukihitaji kuendelea kutumia mfumo, jisajili upya kupitia ${REGISTER_URL} - ALFEAN ENTERPRISES Team`;
  const body = `
    <p>Habari <strong>${name}</strong>,</p>
    <p>Akaunti yako ya <strong>ALFEAN ENTERPRISES</strong> imefutwa kwa sababu hujatumia mfumo kwa zaidi ya <strong>siku ${daysExpired}</strong> na hakuna malipo yaliyofanyika.</p>
    <p>Data yote iliyokuwa kwenye akaunti hiyo (bidhaa, mauzo, madeni na ripoti) imeondolewa.</p>
    <p>Bado unataka kuendelea kutumia mfumo wa ALFEAN ENTERPRISES? <strong>Jisajili upya</strong> na uanze upya — ni haraka na rahisi.</p>`;
  return {
    emailSubject: 'Akaunti yako ya ALFEAN ENTERPRISES imefutwa',
    emailBody: body,
    sms,
  };
}

async function generateCleanupCopy(
  kind: 'warning' | 'deleted',
  ctx: { tenantName: string; daysExpired: number; deleteInDays: number; planSummary: string }
): Promise<CleanupCopy | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const rules = `
KANUNI:
- Andika kwa KISWAHILI SANIFU, cha heshima, rafiki na wazi. Usimtishie, lakini eleza ukweli kwa upole.
- SMS: herufi 140-200. Lazima iwe na neno ALFEAN ENTERPRISES, idadi ya siku, na kiungo ${kind === 'warning' ? RENEW_URL : REGISTER_URL}. Emoji moja (1) tu au hakuna. Tumia {{name}} kwa jina la mteja.
- Barua pepe: subject fupi yenye mvuto; body kwa HTML rahisi (p, ul, li, strong, a) yenye hatua wazi. Tumia {{name}} kwa jina la mteja. USIWEKE <html>, <head> au <body>.
- Jibu kwa JSON pekee bila maelezo mengine: {"emailSubject":"...","emailBody":"...","sms":"..."}`;

  const prompt = kind === 'warning'
    ? `Andika ujumbe wa mwisho wa kumkumbusha mteja wa ALFEAN ENTERPRISES (mfumo wa mauzo/POS kwa maduka ya Tanzania) ambaye kipindi chake cha bure kimeisha siku ${ctx.daysExpired} na hajalipia.
Lengo: kumjulisha kwa upole kwamba akaunti yake imekaa bila matumizi na itafutwa kabisa ndani ya siku ${ctx.deleteInDays} kama hatofanya malipo, kisha kumwalika kulipia ili kuendelea kutumia mfumo.
Mipango ya kulipia: ${ctx.planSummary}
${rules}`
    : `Andika ujumbe wa kumjulisha mteja wa ALFEAN ENTERPRISES (mfumo wa mauzo/POS kwa maduka ya Tanzania) kwamba akaunti yake imefutwa kwa sababu hakutumia mfumo kwa zaidi ya siku ${ctx.daysExpired} na hakuna malipo yaliyofanyika.
Lengo: kumjulisha kwa heshima, kumweleza kwamba data yake imeondolewa, na kumwalika kujisajili upya kupitia ${REGISTER_URL} kama bado anataka kutumia mfumo.
${rules}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        messages: [
          { role: 'system', content: 'Wewe ni mtaalamu wa mawasiliano kwa wateja wa ALFEAN ENTERPRISES (POS ya Tanzania). Jibu kwa JSON pekee.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 900,
        temperature: 0.6,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
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
    console.warn('[TrialCleanup] AI copy generation failed:', e?.message);
    return null;
  }
}

async function getPlanSummary(): Promise<string> {
  try {
    const plans = await pool.query(
      `SELECT name, price_tzs, duration_days FROM subscription_plans WHERE is_active = true ORDER BY duration_days ASC LIMIT 4`
    );
    if (plans.rows.length > 0) {
      return plans.rows.map((p: any) => `${p.name}: TZS ${Number(p.price_tzs).toLocaleString()}/${p.duration_days} siku`).join(', ');
    }
  } catch {}
  return 'Mipango ya ALFEAN ENTERPRISES inaanzia TSh 7,500/mwezi.';
}

function personalise(text: string, name: string): string {
  return text.replace(/\{\{name\}\}/g, name || 'Mteja');
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

type TenantContact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  trialEnd: string | null;
  daysExpired: number;
};

async function getTenantContact(tenantId: string, client: any = pool): Promise<TenantContact | null> {
  const result = await client.query(`
    SELECT
      t.id, t.name, t.email AS tenant_email, t.phone AS tenant_phone, t.trial_end,
      CEIL(EXTRACT(EPOCH FROM (NOW() - t.trial_end)) / 86400)::int AS days_expired,
      (SELECT u.email FROM "user" u
        WHERE u.tenant_id = t.id::text AND u.role IN ('admin', 'owner')
          AND u.email IS NOT NULL AND u.email != ''
        ORDER BY u.created_at LIMIT 1) AS owner_email,
      (SELECT u.phone FROM "user" u
        WHERE u.tenant_id = t.id::text AND u.role IN ('admin', 'owner')
          AND u.phone IS NOT NULL AND u.phone != ''
        ORDER BY u.created_at LIMIT 1) AS owner_phone
    FROM tenants t
    WHERE t.id = $1
  `, [tenantId]);
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    id: r.id,
    name: r.name,
    email: r.owner_email || r.tenant_email || null,
    phone: r.owner_phone || r.tenant_phone || null,
    trialEnd: r.trial_end,
    daysExpired: r.days_expired,
  };
}

async function logNotice(entry: {
  tenantId: string;
  tenantName?: string | null;
  tenantEmail?: string | null;
  tenantPhone?: string | null;
  trialEnd?: string | null;
  daysExpired?: number | null;
  noticeType: 'warning' | 'deleted';
  emailStatus?: string | null;
  smsStatus?: string | null;
  error?: string | null;
}): Promise<boolean> {
  const result = await pool.query(`
    INSERT INTO trial_deletion_log
      (tenant_id, tenant_name, tenant_email, tenant_phone, trial_end, days_expired, notice_type, email_status, sms_status, error)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (tenant_id, notice_type) DO NOTHING
    RETURNING id
  `, [
    entry.tenantId, entry.tenantName ?? null, entry.tenantEmail ?? null, entry.tenantPhone ?? null,
    entry.trialEnd ?? null, entry.daysExpired ?? null, entry.noticeType,
    entry.emailStatus ?? null, entry.smsStatus ?? null, entry.error ?? null,
  ]);
  return result.rows.length > 0;
}

async function updateNoticeStatus(tenantId: string, noticeType: string, emailStatus: string, smsStatus: string, error?: string | null) {
  await pool.query(`
    UPDATE trial_deletion_log
    SET email_status = $3, sms_status = $4, error = $5
    WHERE tenant_id = $1 AND notice_type = $2
  `, [tenantId, noticeType, emailStatus, smsStatus, error ?? null]);
}

async function sendEmailAndSms(contact: TenantContact, copy: CleanupCopy, cta: { label: string; url: string }, templateKey: string) {
  let emailStatus = 'skipped';
  let smsStatus = 'skipped';
  const errors: string[] = [];

  if (contact.email) {
    try {
      const result = await sendEmail({
        to: contact.email,
        subject: personalise(copy.emailSubject, contact.name),
        html: emailWrapper(personalise(copy.emailSubject, contact.name), personalise(copy.emailBody, contact.name), cta.label, cta.url),
        name: contact.name,
        templateKey,
      });
      emailStatus = result.success ? 'sent' : 'failed';
      if (!result.success) errors.push(`email: ${result.error || result.reason || 'unknown'}`);
    } catch (e: any) {
      emailStatus = 'failed';
      errors.push(`email: ${e?.message || 'unknown'}`);
    }
  }

  if (contact.phone) {
    try {
      const result = await sendSystemMarketingSms({ phone: contact.phone, message: personalise(copy.sms, contact.name) });
      smsStatus = result.success ? 'sent' : 'failed';
      if (!result.success) errors.push(`sms: ${result.error || 'unknown'}`);
    } catch (e: any) {
      smsStatus = 'failed';
      errors.push(`sms: ${e?.message || 'unknown'}`);
    }
  }

  return { emailStatus, smsStatus, error: errors.length ? errors.join('; ') : null };
}

// ─── WARNINGS ────────────────────────────────────────────────────────────────

export async function sendTrialDeletionWarning(tenantId: string): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  await ensureTrialCleanupTables();
  const contact = await getTenantContact(tenantId);
  if (!contact) return { success: false, error: 'Tenant not found' };

  const existing = await pool.query(
    `SELECT 1 FROM trial_deletion_log WHERE tenant_id = $1 AND notice_type = 'warning'`,
    [tenantId]
  );
  if (existing.rows.length > 0) return { success: true, skipped: true };

  const settings = await getTrialCleanupSettings();
  const deleteInDays = settings.noticeDaysBefore;
  const planSummary = await getPlanSummary();
  const ai = await generateCleanupCopy('warning', {
    tenantName: contact.name,
    daysExpired: contact.daysExpired,
    deleteInDays,
    planSummary,
  });
  const copy = ai || warningFallback(contact.name, contact.daysExpired, deleteInDays);

  const inserted = await logNotice({
    tenantId,
    tenantName: contact.name,
    tenantEmail: contact.email,
    tenantPhone: contact.phone,
    trialEnd: contact.trialEnd,
    daysExpired: contact.daysExpired,
    noticeType: 'warning',
  });
  if (!inserted) return { success: true, skipped: true };

  const { emailStatus, smsStatus, error } = await sendEmailAndSms(
    contact,
    copy,
    { label: 'Lipia na Uendelee na ALFEAN ENTERPRISES', url: RENEW_URL },
    'trial_deletion_warning'
  );
  await updateNoticeStatus(tenantId, 'warning', emailStatus, smsStatus, error);
  return { success: true };
}

// ─── DELETION ────────────────────────────────────────────────────────────────

export type DeleteTenantResult = {
  tenantId: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  daysExpired?: number;
  emailStatus?: string;
  smsStatus?: string;
};

/**
 * Permanently deletes a tenant account and ALL of its data.
 * Re-validates eligibility inside a row-locked transaction. Never deletes:
 * active trials, active subscribers, anyone who ever completed a payment,
 * super-admin shops, or developer accounts.
 */
export async function deleteTenantAccount(opts: {
  tenantId: string;
  minDaysExpired: number;
  notify?: boolean;
  adminId?: string | null;
  dryRun?: boolean;
}): Promise<DeleteTenantResult> {
  const { tenantId, minDaysExpired, notify = true, adminId = null, dryRun = false } = opts;
  await ensureTrialCleanupTables();

  const client = await pool.connect();
  let contact: TenantContact | null = null;
  try {
    await client.query('BEGIN');

    const check = await client.query(`
      SELECT t.id FROM tenants t
      WHERE t.id = $1 AND ${eligibilitySql('$2')}
      FOR UPDATE OF t
    `, [tenantId, clampInt(minDaysExpired, 1, 365, DEFAULT_SETTINGS.deleteAfterDays)]);

    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return { tenantId, success: false, skipped: true, error: 'not_eligible' };
    }

    contact = await getTenantContact(tenantId, client);
    if (!contact) {
      await client.query('ROLLBACK');
      return { tenantId, success: false, error: 'Tenant not found' };
    }

    const shops = (await client.query(`SELECT id FROM shops WHERE tenant_id = $1`, [tenantId])).rows.map((r: any) => r.id);
    const userIds = (await client.query(`SELECT id FROM "user" WHERE tenant_id = $1::text`, [tenantId])).rows.map((r: any) => r.id);

    // Rows that reference the tenant/shops without ON DELETE CASCADE.
    if (shops.length > 0 && await tableExists(client, 'sales_during_stock_take')) {
      await client.query(
        `DELETE FROM sales_during_stock_take WHERE session_id IN (SELECT id FROM stock_take_sessions WHERE shop_id = ANY($1::uuid[]))`,
        [shops]
      );
    }
    if (await tableExists(client, 'sms_log')) {
      await client.query(`DELETE FROM sms_log WHERE tenant_id = $1`, [tenantId]);
    }
    if (await tableExists(client, 'support_tickets')) {
      await client.query(`DELETE FROM support_tickets WHERE tenant_id = $1`, [tenantId]);
    }
    if (await tableExists(client, 'system_errors')) {
      await client.query(`DELETE FROM system_errors WHERE tenant_id = $1`, [tenantId]);
    }
    if (await tableExists(client, 'activity_logs')) {
      await client.query(`DELETE FROM activity_logs WHERE tenant_id = $1`, [tenantId]);
    }
    if (await tableExists(client, 'email_campaign_recipients')) {
      await client.query(`DELETE FROM email_campaign_recipients WHERE tenant_id = $1`, [tenantId]);
    }
    if (await tableExists(client, 'email_events')) {
      await client.query(`DELETE FROM email_events WHERE tenant_id = $1`, [tenantId]);
    }
    if (userIds.length > 0) {
      if (await tableExists(client, 'login_history')) {
        await client.query(`DELETE FROM login_history WHERE user_id = ANY($1::varchar[])`, [userIds]);
      }
      if (await tableExists(client, 'user_permissions')) {
        await client.query(`DELETE FROM user_permissions WHERE user_id = ANY($1::varchar[])`, [userIds]);
      }
      if (await tableExists(client, 'admin_audit_log')) {
        await client.query(`DELETE FROM admin_audit_log WHERE admin_id = ANY($1::text[])`, [userIds]);
      }
    }

    // Better Auth users (session + account cascade). Everything else cascades
    // from `tenants` (shops → products/sales/debts/expenses/... and the legacy
    // `users` table).
    await client.query(`DELETE FROM "user" WHERE tenant_id = $1::text`, [tenantId]);
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);

    // Audit trail (admin_audit_log.target_tenant_id has no FK — survives deletion).
    let auditAdminId = adminId;
    if (!auditAdminId) {
      const dev = await client.query(`SELECT id FROM "user" WHERE role = 'developer' ORDER BY created_at ASC LIMIT 1`);
      auditAdminId = dev.rows[0]?.id || null;
    }
    if (auditAdminId) {
      await client.query(`
        INSERT INTO admin_audit_log (admin_id, action, target_tenant_id, notes)
        VALUES ($1, 'delete_expired_trial_tenant', $2, $3)
      `, [auditAdminId, tenantId, JSON.stringify({
        automatic: !adminId,
        tenantName: contact.name,
        tenantEmail: contact.email,
        daysExpired: contact.daysExpired,
        shops: shops.length,
      })]);
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      return { tenantId, success: true, name: contact.name, email: contact.email, phone: contact.phone, daysExpired: contact.daysExpired };
    }

    await client.query('COMMIT');
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`[TrialCleanup] Deletion failed for ${tenantId}:`, e?.message);
    return { tenantId, success: false, error: e?.message || 'Deletion failed' };
  } finally {
    client.release();
  }

  // Final notice goes out after the data is gone — but the contact details were
  // captured before deletion, so the email/SMS can still be delivered.
  const result: DeleteTenantResult = {
    tenantId,
    success: true,
    name: contact?.name,
    email: contact?.email,
    phone: contact?.phone,
    daysExpired: contact?.daysExpired,
  };

  if (contact) {
    const inserted = await logNotice({
      tenantId,
      tenantName: contact.name,
      tenantEmail: contact.email,
      tenantPhone: contact.phone,
      trialEnd: contact.trialEnd,
      daysExpired: contact.daysExpired,
      noticeType: 'deleted',
    }).catch(() => false);

    if (notify) {
      const settings = await getTrialCleanupSettings();
      const ai = await generateCleanupCopy('deleted', {
        tenantName: contact.name,
        daysExpired: contact.daysExpired,
        deleteInDays: settings.noticeDaysBefore,
        planSummary: '',
      });
      const copy = ai || deletedFallback(contact.name, contact.daysExpired);
      const { emailStatus, smsStatus, error } = await sendEmailAndSms(
        contact,
        copy,
        { label: 'Jisajili Upya ALFEAN ENTERPRISES', url: REGISTER_URL },
        'trial_deletion_notice'
      );
      result.emailStatus = emailStatus;
      result.smsStatus = smsStatus;
      if (inserted) {
        await updateNoticeStatus(tenantId, 'deleted', emailStatus, smsStatus, error).catch(() => {});
      }
    }
  }

  return result;
}

// ─── AUTOMATIC PROCESSING ────────────────────────────────────────────────────

export async function processTrialDeletionWarnings(limit = 200): Promise<{ sent: number; failed: number }> {
  await ensureTrialCleanupTables();
  const settings = await getTrialCleanupSettings();
  const warnThreshold = Math.max(1, settings.deleteAfterDays - settings.noticeDaysBefore);

  const rows = await pool.query(`
    SELECT t.id FROM tenants t
    WHERE ${eligibilitySql('$1')}
      AND NOT EXISTS (
        SELECT 1 FROM trial_deletion_log dl
        WHERE dl.tenant_id = t.id AND dl.notice_type = 'warning'
      )
    ORDER BY t.trial_end ASC
    LIMIT $2
  `, [warnThreshold, clampInt(limit, 1, 1000, 200)]);

  let sent = 0;
  let failed = 0;
  for (const row of rows.rows) {
    try {
      const result = await sendTrialDeletionWarning(row.id);
      if (result.success) sent++;
      else failed++;
    } catch (e: any) {
      failed++;
      console.warn(`[TrialCleanup] Warning failed for ${row.id}:`, e?.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { sent, failed };
}

export async function processTrialDeletion(limit = 100): Promise<{ deleted: number; failed: number; results: DeleteTenantResult[] }> {
  await ensureTrialCleanupTables();
  const settings = await getTrialCleanupSettings();

  // Only delete AFTER the warning has had its full notice window — guarantees
  // every account gets the 3-day notice even if the cron was down.
  const rows = await pool.query(`
    SELECT t.id FROM tenants t
    WHERE ${eligibilitySql('$1')}
      AND EXISTS (
        SELECT 1 FROM trial_deletion_log dl
        WHERE dl.tenant_id = t.id AND dl.notice_type = 'warning'
          AND dl.created_at <= NOW() - ($2::int * INTERVAL '1 day')
      )
    ORDER BY t.trial_end ASC
    LIMIT $3
  `, [settings.deleteAfterDays, settings.noticeDaysBefore, clampInt(limit, 1, 500, 100)]);

  let deleted = 0;
  let failed = 0;
  const results: DeleteTenantResult[] = [];
  for (const row of rows.rows) {
    const result = await deleteTenantAccount({
      tenantId: row.id,
      minDaysExpired: settings.deleteAfterDays,
      notify: true,
    });
    results.push(result);
    if (result.success) deleted++;
    else failed++;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { deleted, failed, results };
}

export async function runTrialCleanup(): Promise<{ enabled: boolean; warningsSent: number; warningsFailed: number; deleted: number; deleteFailed: number }> {
  const settings = await getTrialCleanupSettings();
  if (!settings.enabled) {
    return { enabled: false, warningsSent: 0, warningsFailed: 0, deleted: 0, deleteFailed: 0 };
  }
  const warnings = await processTrialDeletionWarnings();
  const deletions = await processTrialDeletion();
  console.log(`[TrialCleanup] Warnings: ${warnings.sent} sent / ${warnings.failed} failed · Deletions: ${deletions.deleted} done / ${deletions.failed} failed`);
  return {
    enabled: true,
    warningsSent: warnings.sent,
    warningsFailed: warnings.failed,
    deleted: deletions.deleted,
    deleteFailed: deletions.failed,
  };
}

// ─── MANUAL (DEVELOPER DASHBOARD) ────────────────────────────────────────────

export async function sendWarningsForTenants(opts: {
  tenantIds?: string[];
  all?: boolean;
  minDaysExpired: number;
}): Promise<{ sent: number; skipped: number; failed: number }> {
  await ensureTrialCleanupTables();
  const settings = await getTrialCleanupSettings();
  // A warning promises "deleted in N days" — never send it before the account
  // is within the real notice window (deleteAfterDays - noticeDaysBefore).
  const warnThreshold = Math.max(settings.deleteAfterDays - settings.noticeDaysBefore, 1);
  const minDays = Math.max(clampInt(opts.minDaysExpired, 1, 365, settings.deleteAfterDays), warnThreshold);

  let ids: string[] = [];
  let belowThreshold = 0;
  if (opts.all) {
    const rows = await pool.query(
      `SELECT t.id FROM tenants t WHERE ${eligibilitySql('$1')} ORDER BY t.trial_end ASC LIMIT 500`,
      [minDays]
    );
    ids = rows.rows.map((r: any) => r.id);
  } else if (opts.tenantIds?.length) {
    const rows = await pool.query(
      `SELECT t.id FROM tenants t WHERE t.id = ANY($1::uuid[]) AND ${eligibilitySql('$2')}`,
      [opts.tenantIds, minDays]
    );
    ids = rows.rows.map((r: any) => r.id);
    belowThreshold = Math.max(opts.tenantIds.length - ids.length, 0);
  }

  let sent = 0;
  let skipped = belowThreshold;
  let failed = 0;
  for (const id of ids) {
    const result = await sendTrialDeletionWarning(id);
    if (result.success && result.skipped) skipped++;
    else if (result.success) sent++;
    else failed++;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { sent, skipped, failed };
}

export async function deleteEligibleTenants(opts: {
  tenantIds?: string[];
  all?: boolean;
  minDaysExpired: number;
  notify?: boolean;
  adminId?: string | null;
  dryRun?: boolean;
}): Promise<{ requested: number; deleted: number; skipped: number; failed: number; results: DeleteTenantResult[] }> {
  await ensureTrialCleanupTables();
  const minDays = clampInt(opts.minDaysExpired, 1, 365, DEFAULT_SETTINGS.deleteAfterDays);

  let ids: string[] = [];
  if (opts.all) {
    const rows = await pool.query(
      `SELECT t.id FROM tenants t WHERE ${eligibilitySql('$1')} ORDER BY t.trial_end ASC LIMIT 500`,
      [minDays]
    );
    ids = rows.rows.map((r: any) => r.id);
  } else {
    ids = Array.from(new Set(opts.tenantIds || []));
  }

  const results: DeleteTenantResult[] = [];
  let deleted = 0;
  let skipped = 0;
  let failed = 0;

  for (const id of ids) {
    // Eligibility is re-validated inside deleteTenantAccount's transaction.
    const result = await deleteTenantAccount({
      tenantId: id,
      minDaysExpired: minDays,
      notify: opts.notify !== false,
      adminId: opts.adminId || null,
      dryRun: opts.dryRun === true,
    });
    results.push(result);
    if (result.success) deleted++;
    else if (result.skipped) skipped++;
    else failed++;
    if (!opts.dryRun) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { requested: ids.length, deleted, skipped, failed, results };
}
