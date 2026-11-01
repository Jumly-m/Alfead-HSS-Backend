import { pool } from '../config/drizzle.js';
import * as ehub from './ehub-sms.service.js';
import { initiateSubscriptionPayment, getPaymentStatus, ensurePaymentPush } from './snippe.service.js';
import { sendSms } from './ehub-sms-adapter.service.js';
import { sendEmail } from './email.service.js';

const DEFAULT_RESELLER_SETTINGS = {
  price_per_sms: 25,
  provider_cost: 16,
  min_sms_purchase: 50,          // Minimum SMS a user may buy at once
  free_sms_bonus: 5,             // Free SMS a new shop gets once on signup
  low_balance_threshold: 5,
  enabled: true,
  sms_enabled: true,
  // Provider float alerts (TZS threshold + where to notify the developer)
  provider_low_balance_tzs: 20000,
  provider_alert_phone: '',
  provider_alert_email: '',
  // Developer gets notified on every successful SMS purchase so they can
  // monitor their provider wallet and keep the float topped up.
  purchase_notify_email: '',
  purchase_notify_phone: '',
  // AI content review of every user-sent SMS to catch scam/prohibited content.
  ai_review_enabled: true,
  // Editable auto-message templates (developer portal)
  low_balance_message: 'Habari {shop_name}, SMS zako zimebaki {balance} tu. Nunua SMS zaidi kwenye SMS Center ili uendelee kupata ripoti za mauzo ya kila duka, kuwatumia wateja SMS, kukumbusha madeni na kutuma matangazo. - ALFEAN ENTERPRISES',
  balance_exhausted_message: 'Habari {shop_name}, SMS zako zimeisha. Hutaweza kupata ripoti za mauzo ya kila duka, kuwatumia wateja wako SMS, kukumbusha madeni wala kutuma matangazo mpaka ununue SMS. Nunua sasa kwenye SMS Center - tab ya "Nunua SMS". - ALFEAN ENTERPRISES',
  default_sale_message: 'Asante {customer_name} kwa kununua bidhaa zetu! Jumla: TZS {total}. Karibu tena - {shop_name}',
  default_debt_message: 'Habari {customer_name}, unadaiwa kiasi cha sh {amount}. Tafadhali lipia kabla ya {due_date}. Asante - {shop_name}',
  default_new_product_message: 'Bidhaa mpya imeingia: {product_name}! Karibu uone - {shop_name}',
  default_invoice_message: 'Habari {customer_name}, bado unadaiwa sh {amount} ya invoice ya {invoice_date}. Tafadhali lipia - {shop_name}',
  default_daily_summary_message: 'Muhtasari wa mauzo leo ({date}):\n{shops}',
  default_admin_sale_message: 'Mauzo yamefanyika: Duka {shop_name} TZS {total} na {seller_name}. {items}',
};

const DEFAULT_SHOP_SMS_SETTINGS = {
  auto_sms_on_sale: false,
  auto_sms_message: 'Asante {customer_name} kwa kununua bidhaa zetu! Jumla: TZS {total}. Karibu tena - {shop_name}',
  sale_include_items: true,
  low_balance_notify: true,
  debt_reminder_enabled: false,
  debt_reminder_message: 'Habari {customer_name}, unadaiwa kiasi cha sh {amount}. Tafadhali lipia kabla ya {due_date}. Asante - {shop_name}',
  debt_reminder_days: 7,
  new_product_enabled: false,
  new_product_message: 'Bidhaa mpya imeingia: {product_name}! Karibu uone - {shop_name}',
  invoice_reminder_enabled: false,
  invoice_reminder_message: 'Habari {customer_name}, bado unadaiwa sh {amount} ya invoice ya {invoice_date}. Tafadhali lipia - {shop_name}',
  invoice_reminder_days: 7,
  // Daily sales summary SMS to the shop owner (aggregates all his shops)
  daily_summary_enabled: false,
  daily_summary_time: '20:00',
  daily_summary_message: 'Muhtasari wa mauzo leo ({date}):\n{shops}',
  // Per-sale SMS to the owner for every sale in this shop
  admin_sale_sms_enabled: false,
  admin_sale_sms_message: 'Mauzo yamefanyika: Duka {shop_name} TZS {total} na {seller_name}. {items}',
  // Low stock alert SMS to the owner
  low_stock_alert_enabled: false,
  low_stock_alert_message: 'Tahadhari! Bidhaa zifuatazo zinaisha: {products}. Tafadhali jaza tena - {shop_name}',
};

// ─── CONFIG HELPERS ──────────────────────────────────────────────────────────

export async function getResellerSettings() {
  const r = await pool.query(`SELECT value FROM settings WHERE key = 'sms_reseller' AND shop_id IS NULL LIMIT 1`);
  if (r.rows.length === 0) return { ...DEFAULT_RESELLER_SETTINGS };
  const value = typeof r.rows[0].value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0].value;
  return { ...DEFAULT_RESELLER_SETTINGS, ...value };
}

export async function saveResellerSettings(settings: any) {
  const current = await getResellerSettings();
  const merged = { ...current, ...settings };
  await pool.query(`DELETE FROM settings WHERE key = 'sms_reseller' AND shop_id IS NULL`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('sms_reseller', $1)`, [JSON.stringify(merged)]);
  return merged;
}

export async function getShopSmsSettings(shopId: string) {
  const [r, reseller] = await Promise.all([
    pool.query(`SELECT value FROM settings WHERE key = 'sms' AND shop_id = $1 LIMIT 1`, [shopId]),
    getResellerSettings(),
  ]);
  const defaults = {
    ...DEFAULT_SHOP_SMS_SETTINGS,
    auto_sms_message: reseller.default_sale_message || DEFAULT_SHOP_SMS_SETTINGS.auto_sms_message,
    debt_reminder_message: reseller.default_debt_message || DEFAULT_SHOP_SMS_SETTINGS.debt_reminder_message,
    new_product_message: reseller.default_new_product_message || DEFAULT_SHOP_SMS_SETTINGS.new_product_message,
    invoice_reminder_message: reseller.default_invoice_message || DEFAULT_SHOP_SMS_SETTINGS.invoice_reminder_message,
    daily_summary_message: reseller.default_daily_summary_message || DEFAULT_SHOP_SMS_SETTINGS.daily_summary_message,
    admin_sale_sms_message: reseller.default_admin_sale_message || DEFAULT_SHOP_SMS_SETTINGS.admin_sale_sms_message,
  };
  if (r.rows.length === 0) return defaults;
  const value = typeof r.rows[0].value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0].value;
  return { ...defaults, ...value };
}

export async function saveShopSmsSettings(shopId: string, settings: any) {
  const current = await getShopSmsSettings(shopId);
  const merged = { ...current, ...settings };
  await pool.query(`DELETE FROM settings WHERE key = 'sms' AND shop_id = $1`, [shopId]);
  await pool.query(`INSERT INTO settings (key, value, shop_id) VALUES ('sms', $1, $2)`, [JSON.stringify(merged), shopId]);
  return merged;
}

// ─── ACCOUNT / BALANCE ───────────────────────────────────────────────────────

// Free SMS granted once per shop so a new user can test that SMS really works
// before buying their own credits. Count is configurable per the developer via
// the reseller setting "free_sms_bonus" (default 5).
export async function ensureSmsAccount(shopId: string) {
  await pool.query(
    `INSERT INTO sms_accounts (shop_id) VALUES ($1)
     ON CONFLICT (shop_id) DO UPDATE SET updated_at = NOW()`,
    [shopId]
  );
  await grantFreeSmsBonus(shopId);
}

// One-time, idempotent free SMS gift. Only the first call per shop adds credits
// (guarded by the free_bonus_granted flag); later calls are no-ops.
export async function grantFreeSmsBonus(shopId: string): Promise<boolean> {
  const { free_sms_bonus } = await getResellerSettings();
  const bonus = Math.max(0, Number(free_sms_bonus) || 0);
  if (bonus <= 0) return false;
  const res = await pool.query(
    `UPDATE sms_accounts
        SET balance = balance + $2, free_bonus_granted = true, updated_at = NOW()
      WHERE shop_id = $1 AND free_bonus_granted = false
      RETURNING balance`,
    [shopId, bonus]
  );
  if (res.rows.length === 0) return false;
  await pool.query(
    `INSERT INTO sms_transactions (shop_id, type, credits, amount_tzs, price_per_sms, reference)
     VALUES ($1, 'bonus', $2, 0, 0, 'free-bonus')`,
    [shopId, bonus]
  );
  return true;
}

export async function getShopAccount(shopId: string): Promise<any> {
  await ensureSmsAccount(shopId);
  const r = await pool.query(`SELECT * FROM sms_accounts WHERE shop_id = $1`, [shopId]);
  return r.rows[0] || { shop_id: shopId, balance: 0, total_bought: 0, total_sent: 0 };
}

// Whether the shop currently holds an active SMS bundle (i.e. it has bought
// credits / received a bonus and still has a positive balance).
// Used to stop ALL automated (system) SMS — sale receipts, debt/invoice
// reminders, new-product blasts, daily summaries, low-stock alerts — from
// being sent until the shop tops up. Read-only: never creates/funds an account.
export async function hasActiveSmsBundle(shopId: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT COALESCE(balance, 0) AS balance FROM sms_accounts WHERE shop_id = $1`,
      [shopId]
    );
    return (Number(r.rows[0]?.balance) || 0) > 0;
  } catch (e: any) {
    console.warn('[SMS] hasActiveSmsBundle error:', e.message);
    return false;
  }
}

export async function getSmsBalanceInfo(shopId: string) {
  const [account, settings] = await Promise.all([getShopAccount(shopId), getResellerSettings()]);
  return {
    balance: Number(account.balance) || 0,
    total_bought: Number(account.total_bought) || 0,
    total_sent: Number(account.total_sent) || 0,
    price_per_sms: settings.price_per_sms,
    low_balance_threshold: settings.low_balance_threshold,
    enabled: settings.sms_enabled !== false && settings.enabled !== false,
  };
}

export async function creditSmsAccount(shopId: string, credits: number, amountTzs: number, pricePerSms: number, reference?: string) {
  await ensureSmsAccount(shopId);
  await pool.query(
    `UPDATE sms_accounts SET balance = balance + $2, total_bought = total_bought + $2, updated_at = NOW() WHERE shop_id = $1`,
    [shopId, credits]
  );
  await pool.query(
    `INSERT INTO sms_transactions (shop_id, type, credits, amount_tzs, price_per_sms, reference) VALUES ($1, 'credit', $2, $3, $4, $5)`,
    [shopId, credits, amountTzs, pricePerSms, reference || null]
  );
  return getShopAccount(shopId);
}

// ─── PHONE / MESSAGE HELPERS ─────────────────────────────────────────────────

export function normalizePhone(phone: string): string {
  const cleaned = String(phone || '').replace(/^\+/, '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) return `255${cleaned.slice(1)}`;
  if (cleaned.startsWith('255')) return cleaned;
  return cleaned;
}

export function isValidTzPhone(phone: string): boolean {
  const p = normalizePhone(phone);
  return /^255[0-9]{9}$/.test(p);
}

export function countSmsParts(message: string): number {
  const len = (message || '').length;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

// Fallback for providers that expose the review/rejection message only on the
// per-sender detail endpoint. Best-effort: any failure returns null.
async function fetchProviderReasonDetail(provider: any): Promise<string | null> {
  const id = provider?.id || provider?.uuid || provider?.sender_id_id || provider?.senderId;
  if (!id) return null;
  try {
    const detail = await ehub.getSenderIdDetail(String(id));
    return extractProviderReason(detail);
  } catch {
    return null;
  }
}

// ─── SENDER IDS ──────────────────────────────────────────────────────────────

// eHub may return the reason/message under different keys (and sometimes nested
// inside an admin/review object). Scan shallow + one level deep so the provider's
// response always lands in the portal regardless of its field name.
function extractProviderReason(provider: any): string | null {
  if (!provider) return null;
  const clean = (v: any): string | null => {
    const s = v == null ? '' : String(v).trim();
    return s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined' ? s.slice(0, 500) : null;
  };

  const direct = clean(
    provider.reason ?? provider.rejection_reason ?? provider.reject_reason ?? provider.message
    ?? provider.admin_note ?? provider.note ?? provider.remarks ?? provider.comment
    ?? provider.feedback ?? provider.rejection_message
  );
  if (direct) return direct;

  const REASON_KEY = /reason|message|note|remark|comment|feedback|reject|declin/i;
  const deep = (obj: any, depth: number): string | null => {
    if (!obj || typeof obj !== 'object' || depth > 2) return null;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && REASON_KEY.test(k)) {
        const hit = clean(v);
        if (hit) return hit;
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const hit = deep(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return deep(provider, 0);
}

export async function listSenderIds(shopId: string) {
  const r = await pool.query(
    `SELECT * FROM sms_sender_ids WHERE shop_id = $1 ORDER BY created_at DESC`,
    [shopId]
  );
  return r.rows;
}

// Returns the shop's sender IDs merged with the LIVE status from eHub
// (GET /sender-ids). Reconciles the local DB status so later reads reflect the
// provider. Falls back to local statuses if eHub is unreachable.
// Returns sender IDs (optionally for one shop) merged with the LIVE status from
// eHub (GET /sender-ids). Reconciles the local DB status so later reads reflect
// the provider. Falls back to local statuses if eHub is unreachable.
export async function getLiveSenderIdStatuses(shopId?: string) {
  if (shopId) await ensureDefaultSender(shopId);
  const shopFilter = shopId ? ` WHERE s.shop_id = $1` : '';
  const params = shopId ? [shopId] : [];
  const localRows = (
    await pool.query(
      `SELECT s.*, sh.name as shop_name, u.email as applicant_email, u.phone as applicant_phone, u.first_name, u.last_name
       FROM sms_sender_ids s JOIN shops sh ON sh.id = s.shop_id
       LEFT JOIN "user" u ON u.id = s.applied_by${shopFilter}
       ORDER BY s.created_at DESC`,
      params
    )
  ).rows;

  let providerMap = new Map<string, any>();
  const providerById = new Map<string, any>();
  try {
    const provider = await ehub.getSenderIds();
    for (const p of provider) {
      const name = String(p.sender_id || p.senderId || p.name || '').trim().toUpperCase();
      if (name) providerMap.set(name, p);
      const pid = p.id || p.uuid;
      if (pid) providerById.set(String(pid), p);
    }
  } catch { /* provider unreachable — return local statuses */ }

  const results: any[] = [];
  for (const row of localRows) {
    const key = String(row.sender_id || '').trim().toUpperCase();
    // Prefer the provider entry that matches the provider_id we stored — if the
    // provider keeps an older record under the same sender name, the name match
    // must not override the record this application actually owns.
    const providerByIdMatch = row.provider_id ? providerById.get(String(row.provider_id)) : null;
    // A freshly re-applied row whose submission never reached eHub (no
    // provider_id) would otherwise be knocked straight back to 'rejected' by the
    // stale provider record under the same name. Skip the name fallback until a
    // provider_id is stored (developer submits / provider accepts it).
    const skipNameMatch = Boolean(row.last_reapply_at) && !row.provider_id && !providerByIdMatch;
    const provider = providerByIdMatch || (skipNameMatch ? null : providerMap.get(key));
    const providerStatus = provider ? String(provider.status || '').toLowerCase() : null;
    let providerReason = extractProviderReason(provider);
    // Some eHub plans only expose the review message on the detail endpoint.
    if (!providerReason && provider && providerStatus && !['approved', 'active', 'enabled'].includes(providerStatus)) {
      providerReason = await fetchProviderReasonDetail(provider);
    }

    let status = row.status;
    let rejectedReason = row.rejected_reason;
    if (providerStatus) {
      if (['approved', 'active', 'enabled'].includes(providerStatus)) {
        status = 'approved';
      } else if (providerStatus === 'rejected' || providerStatus === 'declined') {
        status = 'rejected';
        rejectedReason = providerReason || row.rejected_reason || 'Rejected by eHub';
      } else {
        status = 'submitted';
      }
    }

    const statusChanged = status !== row.status;
    const reasonChanged = Boolean(providerReason && providerReason !== row.provider_reason);
    const providerStatusChanged = Boolean(providerStatus && providerStatus !== row.provider_status);
    if (statusChanged || reasonChanged || providerStatusChanged) {
      await pool.query(
        `UPDATE sms_sender_ids
         SET status = $2,
             rejected_reason = CASE WHEN $2::varchar = 'rejected' THEN COALESCE($3::text, rejected_reason, 'Rejected by eHub') ELSE rejected_reason END,
             provider_reason = COALESCE($3::text, provider_reason),
             provider_status = COALESCE($4::varchar, provider_status),
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, status, providerReason, providerStatus]
      );
    }

    // Real-time applicant notification: approved → congrats; rejected → the
    // provider's exact reason. Re-sends when the provider updates its reason so
    // the user always receives the latest "why" — never spams duplicates.
    if (provider) {
      try {
        if (status === 'approved' && row.status !== 'approved') {
          await notifyApprovedSender({ ...row, status });
        } else if (
          status === 'rejected'
          && (
            row.status !== 'rejected'
            || row.rejection_notify_sent !== true
            || (providerReason && providerReason !== row.rejection_notified_reason)
          )
        ) {
          // No explicit reason: the helper prefers the developer's review text,
          // then falls back to the provider/DB reason — never the other way.
          await notifyRejectedSender({ ...row, status, rejected_reason: rejectedReason });
        }
      } catch (e: any) {
        console.warn('[SMS] Sender live notify failed:', e.message);
      }
    }

    results.push({
      id: row.id,
      sender_id: row.sender_id,
      purpose: row.purpose,
      shop_name: row.shop_name,
      status,
      is_default: row.is_default === true,
      is_system: row.is_system === true,
      local_status: row.status,
      provider_status: providerStatus || row.provider_status || null,
      provider_reason: providerReason || row.provider_reason || null,
      provider_id: provider?.id || row.provider_id,
      // Applicant-facing reason: the developer's explanation takes precedence
      // over the provider's wording when they wrote one.
      rejected_reason: row.review_reason || rejectedReason || row.provider_reason || null,
      review_reason: row.review_reason || null,
      rejection_guidance: row.rejection_guidance || null,
      sample: row.sample || null,
      rejected_at: row.rejected_at || null,
      reapply_count: row.reapply_count || 0,
      last_reapply_at: row.last_reapply_at || null,
      applied_by: row.applied_by,
      applied_email: row.applied_email,
      applied_phone: row.applied_phone,
      rejection_notify_sent: row.rejection_notify_sent === true,
      rejection_notified_at: row.rejection_notified_at,
      approval_notify_sent: row.approval_notify_sent === true,
      approval_notified_at: row.approval_notified_at || null,
      approval_notify_count: row.approval_notify_count || 0,
      created_at: row.created_at,
    });
  }
  return results;
}

// Makes sure the shop has the ALFEAN ENTERPRISES system sender ID as a usable approved sender.
// New shops get it automatically (the "hybrid" model), so they can send SMS right
// away while their own sender ID is pending approval. Best-effort: returns the
// system sender row or null if eHub is unreachable.
//
// Also HEALS an existing system row that points at the wrong sender (an older
// fallback could have picked another shop's brand) so every system/developer
// SMS goes out as the configured ALFEAN ENTERPRISES sender.
export async function ensureDefaultSender(shopId: string): Promise<any | null> {
  const existing = await pool.query(
    `SELECT * FROM sms_sender_ids WHERE shop_id = $1 AND is_system = true LIMIT 1`,
    [shopId]
  );

  let info: { id: string; sender_id: string } | null = null;
  try {
    info = await ehub.getPrimarySenderInfo();
  } catch { /* provider/env unavailable — keep whatever we have */ }

  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (info?.id && String(row.provider_id || '') !== String(info.id)) {
      try {
        const upd = await pool.query(
          `UPDATE sms_sender_ids
           SET sender_id = $2, provider_id = $3, status = 'approved', provider_status = 'approved', updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [row.id, info.sender_id, info.id]
        );
        console.log(`[SMS] System sender corrected to "${info.sender_id}" for shop ${shopId}`);
        return upd.rows[0];
      } catch (e: any) {
        // e.g. this shop already has an own row with the same name — keep the old row
        console.warn('[SMS] System sender correction skipped:', e.message);
      }
    }
    return row;
  }

  if (!info) return null;
  try {
    const hasDefault = await pool.query(
      `SELECT 1 FROM sms_sender_ids WHERE shop_id = $1 AND is_default = true LIMIT 1`,
      [shopId]
    );
    const r = await pool.query(
      `INSERT INTO sms_sender_ids (shop_id, sender_id, purpose, status, provider_id, is_default, is_system)
       VALUES ($1, $2, $3, 'approved', $4, $5, true)
       RETURNING *`,
      [shopId, info.sender_id, 'ALFEAN ENTERPRISES system sender', info.id, hasDefault.rows.length === 0]
    );
    return r.rows[0];
  } catch (e: any) {
    // Best-effort by design (never blocks loading the SMS Center), but the
    // message matters: an FK error here means the shop row is gone.
    console.warn('[SMS] Could not ensure system sender for shop', shopId + ':', e.message);
    return null;
  }
}

// Backfills the ALFEAN ENTERPRISES system sender ID for every shop that doesn't have one yet
// AND corrects existing system rows that point at the wrong sender (an older
// fallback could have picked another shop's brand). Runs once at startup so ALL
// tenants send system SMS under the configured ALFEAN ENTERPRISES brand.
export async function bootstrapSystemSenders(): Promise<number> {
  try {
    const info = await ehub.getPrimarySenderInfo();
    const shops = await pool.query(`SELECT id FROM shops`);
    let created = 0;
    let healed = 0;
    for (const shop of shops.rows) {
      const existing = await pool.query(
        `SELECT id, provider_id FROM sms_sender_ids WHERE shop_id = $1 AND is_system = true LIMIT 1`,
        [shop.id]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (info?.id && String(row.provider_id || '') !== String(info.id)) {
          try {
            await pool.query(
              `UPDATE sms_sender_ids
               SET sender_id = $2, provider_id = $3, status = 'approved', provider_status = 'approved', updated_at = NOW()
               WHERE id = $1`,
              [row.id, info.sender_id, info.id]
            );
            healed++;
          } catch { /* this shop has an own row with that name — leave the old row */ }
        }
        continue;
      }
      const hasDefault = await pool.query(
        `SELECT 1 FROM sms_sender_ids WHERE shop_id = $1 AND is_default = true LIMIT 1`,
        [shop.id]
      );
      await pool.query(
        `INSERT INTO sms_sender_ids (shop_id, sender_id, purpose, status, provider_id, is_default, is_system)
         VALUES ($1, $2, $3, 'approved', $4, $5, true)
         ON CONFLICT DO NOTHING`,
        [shop.id, info.sender_id, 'ALFEAN ENTERPRISES system sender', info.id, hasDefault.rows.length === 0]
      );
      created++;
    }
    if (created > 0) {
      console.log(`  ✅ System sender '${info.sender_id}' ensured for ${created} shop(s)`);
    }
    if (healed > 0) {
      console.log(`  ✅ System sender '${info.sender_id}' corrected for ${healed} shop(s)`);
    }
    return created + healed;
  } catch (e: any) {
    console.warn('  ⚠️  Could not bootstrap system sender IDs:', e.message);
    return 0;
  }
}

export async function setDefaultSender(shopId: string, senderRowId: string) {
  const row = await pool.query(
    `SELECT * FROM sms_sender_ids WHERE id = $1 AND shop_id = $2`,
    [senderRowId, shopId]
  );
  if (row.rows.length === 0) throw new Error('Sender ID not found');
  if (row.rows[0].status !== 'approved') throw new Error('Only an approved sender ID can be set as default');
  if (row.rows[0].is_default === true) return row.rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE sms_sender_ids SET is_default = false, updated_at = NOW() WHERE shop_id = $1`,
      [shopId]
    );
    await client.query(
      `UPDATE sms_sender_ids SET is_default = true, updated_at = NOW() WHERE id = $1`,
      [senderRowId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return (await pool.query(`SELECT * FROM sms_sender_ids WHERE id = $1`, [senderRowId])).rows[0];
}

export async function getApprovedSender(shopId: string): Promise<any | null> {
  await ensureDefaultSender(shopId);
  const r = await pool.query(
    `SELECT * FROM sms_sender_ids
     WHERE shop_id = $1 AND status = 'approved'
     ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
    [shopId]
  );
  return r.rows[0] || null;
}

// The ALFEAN ENTERPRISES system sender (is_system=true) — reserved exclusively for system /
// automation messages (receipts, debt reminders, low stock, summaries, etc.)
// so the developer's brand never leaks into user-typed sends.
export async function getSystemSender(shopId: string): Promise<any | null> {
  await ensureDefaultSender(shopId);
  const r = await pool.query(
    `SELECT * FROM sms_sender_ids
     WHERE shop_id = $1 AND is_system = true AND status = 'approved'
     LIMIT 1`,
    [shopId]
  );
  return r.rows[0] || null;
}

// The single PUBLIC/shared sender ID that any shop without an approved sender
// may broadcast under. Every other sender ID on the provider account belongs to
// a specific shop and is NEVER exposed to other shops.
const PUBLIC_SENDER_ID = 'UPDATE';

// Approved public/shared sender IDs from eHub (GET /sender-ids). STRICTLY
// returns only the shared "UPDATE" sender — shops must apply for their own
// sender ID; they may never pick another shop's sender.
export async function getPublicSenders(): Promise<Array<{ provider_id: string; sender_id: string }>> {
  try {
    const rows = await ehub.getSenderIds();
    const approved = rows.filter((s) => {
      const st = String(s.status || '').toLowerCase();
      return ['approved', 'active', 'enabled'].includes(st);
    });
    return approved.map((s) => ({
      provider_id: s.id,
      sender_id: String(s.sender_id || s.senderId || s.name || '').trim(),
    })).filter((s) => {
      if (!s.provider_id || !s.sender_id) return false;
      const norm = s.sender_id.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return norm === PUBLIC_SENDER_ID.replace(/[^A-Z0-9]/g, '');
    });
  } catch {
    return [];
  }
}

// Resolve the sender for a USER-typed send (manual / bulk / campaign). Prefers
// the user's approved own sender (default), otherwise a public approved sender.
// NEVER falls back to the system sender for user content. Accepts an optional
// preferred provider_id (from the sender selection UI).
export async function resolveUserSender(shopId: string, preferredProviderId?: string): Promise<{ provider_id: string; sender_id: string; row?: any } | null> {
  // 1. Preferred selection (own approved row or a public sender id).
  if (preferredProviderId) {
    const own = await pool.query(
      `SELECT * FROM sms_sender_ids WHERE shop_id = $1 AND status = 'approved' AND is_system = false AND provider_id = $2 LIMIT 1`,
      [shopId, preferredProviderId]
    );
    if (own.rows[0]) {
      return { provider_id: own.rows[0].provider_id, sender_id: own.rows[0].sender_id, row: own.rows[0] };
    }
    // Maybe it's a public sender id from eHub.
    const publics = await getPublicSenders();
    const match = publics.find((p) => p.provider_id === preferredProviderId);
    if (match) return match;
  }

  // 2. Approved own sender (default first).
  const own = await pool.query(
    `SELECT * FROM sms_sender_ids
     WHERE shop_id = $1 AND status = 'approved' AND is_system = false
     ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
    [shopId]
  );
  if (own.rows[0]) {
    return { provider_id: own.rows[0].provider_id, sender_id: own.rows[0].sender_id, row: own.rows[0] };
  }

  // 3. Public approved sender (user's own is still pending).
  const publics = await getPublicSenders();
  return publics[0] || null;
}

// Submits (or re-submits) a sender ID to eHub. Returns the provider UUID and a
// normalized provider status. When eHub refuses because the name ALREADY exists
// (409 duplicate — e.g. re-applying after rejection, or a sender registered
// directly on the eHub dashboard), the existing provider record is looked up and
// reused, so the application is linked instead of silently staying pending.
async function submitSenderIdToProvider(
  name: string,
  purpose?: string,
  sample?: string
): Promise<{ providerId: string | null; providerStatus: 'approved' | 'rejected' | 'pending' | null }> {
  try {
    const result = await ehub.requestSenderId(name, purpose || 'Business communications', sample || undefined);
    const providerId = result?.id || result?.sender_id_id || result?.uuid || null;
    return { providerId: providerId ? String(providerId) : null, providerStatus: providerId ? 'pending' : null };
  } catch (e: any) {
    console.warn('[SMS] Sender ID provider submission failed:', e.message);
    try {
      const senders = await ehub.getSenderIds();
      const norm = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const match = senders.find(
        (s) => String(s.sender_id || s.senderId || s.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === norm
      );
      if (match?.id) {
        const st = String(match.status || '').toLowerCase();
        const providerStatus: 'approved' | 'rejected' | 'pending' =
          ['approved', 'active', 'enabled'].includes(st) ? 'approved'
          : ['rejected', 'declined'].includes(st) ? 'rejected'
          : 'pending';
        return { providerId: String(match.id), providerStatus };
      }
    } catch { /* provider unreachable — keep pending locally */ }
    return { providerId: null, providerStatus: null };
  }
}

// Best-effort: give the shop a default sender when it has none, so sending
// works without an extra step after a sender gets approved/linked.
async function ensureShopDefaultSender(shopId: string, rowId: string): Promise<boolean> {
  try {
    const hasDefault = await pool.query(
      `SELECT 1 FROM sms_sender_ids WHERE shop_id = $1 AND is_default = true LIMIT 1`,
      [shopId]
    );
    if (hasDefault.rows.length === 0) {
      await pool.query(`UPDATE sms_sender_ids SET is_default = true, updated_at = NOW() WHERE id = $1`, [rowId]);
      return true;
    }
  } catch { /* default is best-effort */ }
  return false;
}

// eHub requires a 50–250 character sample of the messages the sender will
// carry. An empty sample falls back to the built-in default (inside the eHub
// client); a provided one must be valid, otherwise the provider would reject the
// whole request — tell the applicant clearly instead.
function normalizeSenderSample(sample?: string | null): string | undefined {
  const s = String(sample || '').trim();
  if (!s) return undefined;
  if (s.length < 50) throw new Error('Sample message must be at least 50 characters (or leave it empty)');
  return s.slice(0, 250);
}

// Fail fast with a human-readable message when the shop row no longer exists.
// Stale references (user_shops / user.shop_id on databases without the shops
// FK) would otherwise surface as a raw Postgres FK error on INSERT, e.g.
// "insert or update on table sms_sender_ids violates foreign key constraint
// sms_sender_ids_shop_id_fkey" — which tells the user nothing.
async function assertShopExists(shopId: string, adminAction = false): Promise<void> {
  if (!shopId) {
    throw new Error(adminAction ? 'Shop is required' : 'No shop is linked to this account');
  }
  const r = await pool.query(`SELECT 1 FROM shops WHERE id = $1 LIMIT 1`, [shopId]);
  if (r.rows.length > 0) return;
  throw new Error(adminAction
    ? 'That shop no longer exists — refresh the shop list and pick the shop again'
    : 'Your shop account was not found (it may have been removed). Sign out and sign back in; if it continues, contact support.');
}

// Re-apply a previously rejected sender ID. The (shop_id, sender_id) unique
// constraint means a re-application cannot be a second row: the rejected row is
// reset for a fresh review cycle (the previous rejection text is cleared so the
// applicant starts clean) and re-submitted to the provider. This is what gives
// rejected applicants room to apply again — no developer action required.
export async function reapplySenderId(
  shopId: string,
  id: string,
  purpose?: string,
  applicantInfo?: { userId?: string; email?: string; phone?: string },
  sample?: string
) {
  await assertShopExists(shopId);
  // Re-applications also need a real sample message (AI suggestions available
  // in the SMS Center form).
  if (!String(sample || '').trim()) {
    throw new Error('Weka mfano wa SMS (herufi 50–250) unaoelezea matumizi ya sender ID yako — unaweza kutumia mapendekezo ya AI kwenye fomu.');
  }
  const r = await pool.query(
    `SELECT * FROM sms_sender_ids WHERE id = $1 AND shop_id = $2 AND is_system = false`,
    [id, shopId]
  );
  const row = r.rows[0];
  if (!row) throw new Error('Sender ID request not found');
  if (row.status === 'approved') throw new Error('This sender ID is already approved');
  if (row.status === 'pending' || row.status === 'submitted') {
    throw new Error('This sender ID is already awaiting approval');
  }

  // Block personal names before they reach the provider (rule + AI gate).
  await assertBusinessSenderName(String(row.sender_id || ''), applicantInfo, shopId);

  const cleanSample = normalizeSenderSample(sample);
  const { providerId, providerStatus } = await submitSenderIdToProvider(
    row.sender_id,
    purpose || row.purpose,
    cleanSample || row.sample || undefined
  );
  // ISOLATION: if the provider record this name resolves to already belongs to
  // another shop in ALFEAN ENTERPRISES, never adopt it — keep this shop's application from
  // hijacking another shop's sender.
  if (providerId) {
    const owner = await findCrossShopSenderOwner({ shopId, senderId: row.sender_id, providerId, excludeRowId: row.id });
    if (owner) throw new Error('This sender ID is already used by another shop');
  }
  const status = providerStatus === 'approved' ? 'approved' : providerId ? 'submitted' : 'pending';
  const updated = await pool.query(
    `UPDATE sms_sender_ids
     SET status = $2,
         purpose = COALESCE($3, purpose),
         sample = COALESCE($9, sample),
         provider_id = $4,
         provider_status = $8,
         submitted_at = CASE WHEN $4 IS NOT NULL THEN NOW() ELSE submitted_at END,
         rejected_reason = NULL, provider_reason = NULL,
         review_reason = NULL, rejection_guidance = NULL, rejected_at = NULL,
         rejection_notify_sent = false, rejection_notified_at = NULL, rejection_notified_reason = NULL,
         applied_by = COALESCE($5, applied_by),
         applied_email = COALESCE($6, applied_email),
         applied_phone = COALESCE($7, applied_phone),
         reapply_count = reapply_count + 1,
         last_reapply_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      status,
      purpose || null,
      providerId,
      applicantInfo?.userId || null,
      applicantInfo?.email || null,
      applicantInfo?.phone || null,
      providerStatus,
      cleanSample || null,
    ]
  );
  // Approved on the spot (the name already exists and is approved on eHub) —
  // make sure the shop has a default sender so it can send right away.
  if (status === 'approved' && updated.rows[0]) {
    if (await ensureShopDefaultSender(shopId, updated.rows[0].id)) updated.rows[0].is_default = true;
  }
  return updated.rows[0];
}

// ─── AI ASSIST FOR SENDER-ID APPLICATIONS ────────────────────────────────────
// eHub rejects applications for the same reasons over and over: the sender ID
// is a personal name, or the sample message is missing/unrelated. This helper
// checks the draft BEFORE submission and returns actionable suggestions —
// business-style names and ready sample messages — so applications pass first
// time. Uses DeepSeek when configured, with a solid rule-based fallback.

const SENDER_NAME_SUFFIXES = ['AUTO', 'SHOP', 'STORE', 'TRADERS', 'TECH', 'PHARMACY', 'COSMETICS', 'BEAUTY', 'HARDWARE', 'SUPPLIES', 'MOTORS', 'GROUP', 'SERVICES'];

const ASSIST_PURPOSES = ['Notification', 'Transactional', 'OTP / Verification', 'Promotional', 'Marketing', 'Alerts & Reminders', 'Other'];

function normalizeAssistName(v: any): string {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Common Tanzanian personal first names. eHub rejects sender IDs that are a
// person's name ("sender id haitakiwi kuwa jina la mtu binafsi") — this list +
// the applicant's own name + an AI second opinion block those applications
// BEFORE they are sent to the provider, so shops stop getting rejected.
const COMMON_PERSONAL_NAMES = new Set([
  'JUMA','JAMES','JULIUS','YUSUPH','YUSUP','SILAS','JOSEPH','JOHN','PETER','PAUL','DAVID','DANIEL','EMMANUEL','GODFREY','JAPHET','JAPHETH','DEO','DERICK','DERRICK','GIFT','HAMISI','HAMZA','HASAN','HASSAN','HUSSEIN','IBRAHIM','IDDI','ISSA','JACKSON','JACOB','JAMAL','JEREMIAH','JOEL','JONAS','JOSHUA','KENNEDY','KEVIN','KHALID','LAURENT','LUCAS','MAJID','MARTIN','MASANJA','MICHAEL','MOHAMED','MUSA','MUSTAFA','NASSOR','NELSON','NICHOLAS','NOEL','OMARI','OSCAR','PATRICK','RAJABU','RAMADHANI','RASHID','RAYMOND','RICHARD','ROBERT','ROGERS','RONALD','SAID','SALIM','SAMSON','SAMWEL','SELEMANI','SHAFII','SHABANI','SIMON','STEPHEN','STEVEN','SULEIMAN','THOMAS','VICTOR','VINCENT','WILLIAM','ZAKARIA','ALLY','AMANI','ANDREW','ANTHONY','BENEDICT','BENJAMIN','BERNARD','BONIFACE','BRIAN','CHARLES','CHRISTOPHER','DENIS','DICKSON','EDWARD','ELIAS','ERICK','ERIC','ERNEST','EVARIST','FABIAN','FELIX','FRANCIS','FRANK','FREDRICK','GABRIEL','GEORGE','GERALD','GREGORY','HAMIDU','HENRY','HERMAN','HILLARY','INNOCENT','ISAYA','ISRAEL','IVAN','JASSON','JAYSON','JIMMY','JOACHIM','JOHNSON','JONATHAN','GRACE','MARY','REHEMA','ZAINABU','HALIMA','MWANAHAWA','ASHA','FATUMA','SALMA','NEEMA','UPENDO','TUMAINI','ZUHURA','SUBIRA','AGNES','ANNA','BEATRICE','CHRISTINA','DIANA','DORIS','EDINA','ELIZABETH','ESTHER','EVA','GLORIA','HAPPINESS','IRENE','JANETH','JESCA','JOYCE','JUDITH','KULWA','LEAH','LILIAN','LUCIA','MAGDALENA','MARIAMU','MONICA','NAOMI','PENDO','PRISCA','RACHEL','REGINA','ROSEMARY','SARA','SARAH','SOPHIA','STELLA','THERESIA','VERONICA','WINFRIDA','AMINA','AZIZA','CATHERINE','CECILIA','CONSOLATA','FELISTA','FLORA','HAWA','HELENA','JENIFA','LATIFA','MARTHA','MERCY','MWAJUMA','NASRA','PAULINA','RITA','ROSE','TATU','VUMILIA','WEMA','YASINTA',
]);

// True when the typed sender ID is a personal name: the applicant's own name
// (or a close spelling variant, e.g. YUSUPH vs YUSUP) or a common first name.
export function isPersonalSenderName(typed: string, applicantName: string): boolean {
  const name = normalizeAssistName(typed);
  if (!name) return false;
  const parts = String(applicantName || '').split(/\s+/).map((p) => normalizeAssistName(p)).filter((p) => p.length >= 4);
  const full = normalizeAssistName(applicantName);
  const variant = (s: string, p: string) =>
    s === p ||
    (s.startsWith(p) && s.length - p.length <= 2) ||
    (s.length >= 4 && p.startsWith(s) && p.length - s.length <= 2);
  if (name === full || parts.some((p) => variant(name, p))) return true;
  return COMMON_PERSONAL_NAMES.has(name);
}

async function getApplicantNames(applicantInfo?: { userId?: string }): Promise<string> {
  if (!applicantInfo?.userId) return '';
  try {
    const r = await pool.query(`SELECT first_name, last_name, name FROM "user" WHERE id = $1`, [applicantInfo.userId]);
    const u: any = r.rows[0] || {};
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || '';
  } catch {
    return '';
  }
}

// AI second opinion (best-effort): catches personal names that are not the
// applicant's own (e.g. applying a relative's name). Returns null when AI is
// unavailable — the rule-based check above is always the primary gate.
async function aiPersonalNameCheck(name: string, applicantName: string, shopName: string): Promise<{ personal: boolean; reason?: string } | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      // Bounded latency: the rule check is the primary gate, so if the AI
      // second opinion is slow we skip it (never block on AI latency).
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You check Tanzanian SMS sender IDs for the eHub provider. A sender ID must be a BUSINESS name, never a personal name. Answer with JSON only: {"personal": true|false, "reason": "short Swahili reason when personal"}. Flag ONLY clear personal names (JULIUS, JUMA, JAMES, JOSEPH, MAMA GRACE). Business-style names containing a name (JULIUSAUTO, MWEKOTECH, JMELECTRONICS) are NOT personal.',
          },
          { role: 'user', content: `Sender ID: ${name}\nApplicant: ${applicantName || 'unknown'}\nBusiness: ${shopName || 'unknown'}` },
        ],
        max_tokens: 1200,
        temperature: 0,
      }),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return { personal: parsed.personal === true, reason: parsed.reason ? String(parsed.reason) : undefined };
  } catch {
    return null;
  }
}

// Hard gate: throws before the application is ever sent to the provider.
async function assertBusinessSenderName(name: string, applicantInfo?: { userId?: string }, shopId?: string) {
  const applicantName = await getApplicantNames(applicantInfo);
  let shopName = '';
  if (shopId) {
    try {
      shopName = (await pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId])).rows[0]?.name || '';
    } catch { /* ignore */ }
  }
  if (isPersonalSenderName(name, applicantName)) {
    const examples = buildFallbackNameSuggestions(shopName, applicantName, name).slice(0, 3).join(', ');
    throw new Error(`"${name}" ni jina la mtu binafsi — provider haikubali sender ID ya jina la mtu. Omba jina la biashara${examples ? `, mfano ${examples}` : ''}.`);
  }
  const ai = await aiPersonalNameCheck(name, applicantName, shopName);
  if (ai?.personal) {
    throw new Error(ai.reason || `"${name}" inaonekana ni jina la mtu binafsi — provider haikubali. Omba jina la biashara.`);
  }
}

function buildFallbackNameSuggestions(shopName: string, applicantName: string, typed: string): string[] {
  const out: string[] = [];
  const personParts = String(applicantName || '').split(/\s+/).map((p) => normalizeAssistName(p)).filter((p) => p.length >= 4);
  const isPersonalLike = (s: string) =>
    personParts.some((p) => s === p || (s.startsWith(p) && s.length - p.length <= 2) || (s.length >= 4 && p.startsWith(s) && p.length - s.length <= 2));
  const push = (v: string) => {
    const s = normalizeAssistName(v);
    if (s.length < 4 || s.length > 11 || s === typed || out.includes(s)) return;
    if (isPersonalLike(s)) return; // never suggest the applicant's own name
    out.push(s);
  };
  const shopNorm = normalizeAssistName(shopName);
  if (shopNorm.length <= 11) push(shopNorm);
  const firstWordNorm = normalizeAssistName(String(shopName || '').trim().split(/\s+/)[0] || '');
  if (firstWordNorm.length <= 11) push(firstWordNorm);
  const base = (firstWordNorm || normalizeAssistName(String(applicantName || '').split(' ')[0]) || 'ALFEAN ENTERPRISES').slice(0, 7);
  for (const suffix of SENDER_NAME_SUFFIXES) {
    push(base + suffix);
    if (out.length >= 4) break;
  }
  return out.slice(0, 4);
}

function buildFallbackSampleSuggestions(shopName: string, purpose?: string): string[] {
  const s = String(shopName || '').trim() || 'biashara yetu';
  const p = String(purpose || '').toLowerCase();
  const promo = p.includes('promo') || p.includes('market');
  const bank = promo
    ? [
        `Karibu ${s}! Ofa maalum wiki hii — punguzo hadi 20% kwa bidhaa zilizochaguliwa. Tembelea dukani kwetu leo. Reply STOP kuacha.`,
        `Habari kutoka ${s}: bidhaa mpya zimewasili! Karibu uone mkusanyiko wetu mpya na upate bei nafuu. Reply STOP kuacha.`,
        `Mteja wetu mpendwa, asante kwa kutuunga mkono. Tunakuletea ofa mpya kila wiki. Karibu ${s} leo! Reply STOP kuacha.`,
      ]
    : [
        `Karibu ${s}! Tunakuletea bidhaa na huduma bora kwa bei nafuu. Tembelea dukani kwetu leo na upate ofa maalum. Reply STOP kuacha.`,
        `Habari kutoka ${s}: tuna bidhaa mpya zilizowasili. Karibu uone na upate punguzo maalum la wiki hii. Reply STOP kuacha.`,
        `Asante kwa kuwa mteja wa ${s}. Tunakukumbusha kuwa tunatoa huduma bora na bei nafuu kila siku. Karibu tena! Reply STOP kuacha.`,
      ];
  return bank.map((m) => m.slice(0, 250)).filter((m) => m.length >= 50);
}

export interface SenderIdAssist {
  name: { ok: boolean; reason?: string; suggestions: string[] };
  sample: { ok: boolean; reason?: string; suggestions: string[] };
  purpose: string;
  tip: string;
  aiUsed: boolean;
}

export async function assistSenderIdApplication(opts: {
  senderId?: string;
  sample?: string;
  purpose?: string;
  shopName?: string;
  applicantName?: string;
  language?: string;
  businessContext?: string;
}): Promise<SenderIdAssist> {
  const typed = normalizeAssistName(opts.senderId);
  const sample = String(opts.sample || '').trim();
  const shopName = String(opts.shopName || '').trim();
  const applicantName = String(opts.applicantName || '').trim();
  const businessContext = String(opts.businessContext || '').trim();
  const language = opts.language === 'en' ? 'English' : 'Swahili';

  const fallbackTip = language === 'English'
    ? 'A good sender ID is your business name in 4–11 letters (e.g. shop name + what you sell). The sample should be a real message you send customers — receipts, offers or reminders.'
    : 'Sender ID nzuri ni jina la biashara lenye herufi 4–11 (mfano jina la duka + bidhaa/huduma unazouza). Mfano wa SMS uwe meseji halisi unayotumia kwa wateja — risiti, ofa au vikumbusho.';

  // A personal name is when the sender ID is the applicant's own name (or a
  // close spelling variant) or a common first name. "JULIUSAUTO" is a business
  // name and must stay allowed.
  const looksPersonal = isPersonalSenderName(typed, applicantName);

  const fallbackNames = buildFallbackNameSuggestions(shopName, applicantName, typed);
  const fallbackSamples = buildFallbackSampleSuggestions(shopName, opts.purpose);

  const nameOk = typed.length >= 4 && typed.length <= 11 && !looksPersonal;
  const sampleOk = sample.length >= 50 && sample.length <= 250;

  const base: SenderIdAssist = {
    name: {
      ok: nameOk,
      reason: looksPersonal
        ? `"${typed}" ni jina la mtu binafsi — provider haikubali. Tumia jina la biashara (mfano mojawapo ya mapendekezo hapa chini).`
        : undefined,
      suggestions: fallbackNames,
    },
    sample: {
      ok: sampleOk,
      reason: !sample
        ? 'Mfano wa SMS unahitajika (herufi 50–250). Chagua mojawapo ya mapendekezo au andika wako.'
        : (sample.length < 50 ? 'Mfano wa SMS ni mfupi mno — unahitaji herufi 50–250.' : undefined),
      suggestions: fallbackSamples,
    },
    purpose: ASSIST_PURPOSES.find((p) => p.toLowerCase() === String(opts.purpose || '').toLowerCase()) || 'Other',
    tip: fallbackTip,
    aiUsed: false,
  };

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return base;

  try {
    const prompt = `Applicant details:
- Shop/business name: ${shopName || '(unknown)'}
- What the shop sells (from ALFEAN ENTERPRISES): ${businessContext || '(unknown)'}
- Applicant (person) name: ${applicantName || '(unknown)'}
- Typed sender ID: ${typed || '(empty)'}
- Typed purpose: ${opts.purpose || '(none)'}
- Typed sample message: ${sample || '(empty)'}
Language for suggestions: ${language}.

Tanzania eHub rules:
1. A sender ID must be 4-11 characters A-Z/0-9 and must NOT be a personal name (like JULIUS, JUMA, JAMES). It must be a business brand built from the shop's name and what it sells (e.g. YUSUPAUTO, YUSUPARTS, MWEKOTECH, YZautospare).
2. personal_name is true ONLY when the typed sender ID is exactly the applicant's personal name (first, last or full name) — names like JULIUSAUTO are fine and must NOT be flagged.
3. Every application needs a realistic sample message (50-250 characters) showing how the sender will be used, matching what the shop sells.

Return STRICT JSON only:
{
  "personal_name": true|false,
  "name_reason": "short reason in ${language} when personal_name is true, else empty string",
  "suggestions": ["4 business-style sender IDs built from THIS shop's name and products, 4-11 chars, A-Z0-9 only, uppercase, no spaces"],
  "samples": ["3 realistic SMS samples (50-250 chars each) in ${language} for THIS business (mention what they sell), each ending with 'Reply STOP kuacha.' or 'Reply STOP to opt out.'"],
  "purpose": "one of: Notification, Transactional, OTP / Verification, Promotional, Marketing, Alerts & Reminders, Other",
  "tip": "one short, friendly, teaching tip in ${language} (max 200 chars) telling the applicant how to pick a sender ID and sample that get approved fast for their business"
}`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an SMS sender-ID compliance assistant for Tanzania. You prevent provider rejections by suggesting business names and realistic sample messages. Think briefly, then return ONLY valid JSON.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4000,
        temperature: 0.6,
      }),
    });
    if (!response.ok) return base;
    const data: any = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');

    const aiNames = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s: any) => normalizeAssistName(s)).filter((s: string) => s.length >= 4 && s.length <= 11)
      : [];
    const aiSamples = Array.isArray(parsed.samples)
      ? parsed.samples.map((s: any) => String(s || '').trim()).filter((s: string) => s.length >= 50 && s.length <= 250)
      : [];
    const aiPersonal = parsed.personal_name === true;
    const aiPurpose = ASSIST_PURPOSES.includes(parsed.purpose) ? parsed.purpose : base.purpose;

    return {
      name: {
        ok: nameOk && !aiPersonal,
        reason: (aiPersonal && parsed.name_reason) ? String(parsed.name_reason) : base.name.reason,
        suggestions: [...new Set([...aiNames, ...fallbackNames])].slice(0, 4),
      },
      sample: {
        ok: sampleOk,
        reason: base.sample.reason,
        suggestions: [...new Set([...aiSamples, ...fallbackSamples])].slice(0, 3),
      },
      purpose: aiPurpose,
      tip: parsed.tip ? String(parsed.tip).slice(0, 240) : fallbackTip,
      aiUsed: true,
    };
  } catch {
    return base;
  }
}

export async function requestShopSenderId(shopId: string, senderId: string, purpose?: string, applicantInfo?: { userId?: string; email?: string; phone?: string }, sample?: string) {
  await assertShopExists(shopId);
  const name = String(senderId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (name.length < 4 || name.length > 11) {
    throw new Error('Sender ID must be 4-11 alphanumeric characters');
  }
  // A real sample message is required: applications without one are the #1
  // rejection reason. The SMS Center offers AI suggestions to make this easy.
  if (!String(sample || '').trim()) {
    throw new Error('Weka mfano wa SMS (herufi 50–250) unaoelezea matumizi ya sender ID yako — unaweza kutumia mapendekezo ya AI kwenye fomu.');
  }
  // Never send an application the provider will reject: personal names are
  // blocked here (rule + AI), with business-name examples in the error.
  await assertBusinessSenderName(name, applicantInfo, shopId);

  // Re-application path: a rejected sender ID can be applied for again. The
  // unique constraint (shop_id, sender_id) forbids inserting a second row, so
  // reset + resubmit the existing rejected row instead. Approved/pending rows
  // are still blocked from duplicates.
  const existing = await pool.query(
    `SELECT * FROM sms_sender_ids WHERE shop_id = $1 AND UPPER(sender_id) = $2 AND is_system = false LIMIT 1`,
    [shopId, name]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.status === 'approved') {
      throw new Error('This sender ID is already approved — set it as your default instead');
    }
    if (row.status === 'pending' || row.status === 'submitted') {
      throw new Error('You have already requested this sender ID — it is awaiting approval');
    }
    return reapplySenderId(shopId, row.id, purpose, applicantInfo, sample);
  }

  const cleanSample = normalizeSenderSample(sample);
  const { providerId, providerStatus } = await submitSenderIdToProvider(name, purpose, cleanSample);
  // ISOLATION: never adopt a provider sender that is already linked to another
  // shop — e.g. when eHub answers 409 (name exists) and the lookup finds it.
  if (providerId) {
    const owner = await findCrossShopSenderOwner({ shopId, senderId: name, providerId });
    if (owner) throw new Error('This sender ID is already used by another shop');
  }
  const status = providerStatus === 'approved' ? 'approved' : providerId ? 'submitted' : 'pending';
  try {
    const r = await pool.query(
      `INSERT INTO sms_sender_ids (shop_id, sender_id, purpose, sample, status, provider_id, provider_status, submitted_at, applied_by, applied_email, applied_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [shopId, name, purpose || null, cleanSample || null, status, providerId, providerStatus, providerId ? new Date() : null, applicantInfo?.userId || null, applicantInfo?.email || null, applicantInfo?.phone || null]
    );
    // The name already exists and is approved on eHub (409 duplicate) — the
    // application is linked and approved immediately; give the shop a default.
    if (status === 'approved' && r.rows[0]) {
      if (await ensureShopDefaultSender(shopId, r.rows[0].id)) r.rows[0].is_default = true;
    }
    return r.rows[0];
  } catch (e: any) {
    if (e.message?.includes('unique') || e.message?.includes('duplicate')) {
      throw new Error('You have already requested this sender ID');
    }
    // 23503 = foreign key violation: the shop was removed between the check
    // above and the insert (race). Give the same actionable message.
    if (e.code === '23503') {
      throw new Error('Your shop account was not found (it may have been removed). Sign out and sign back in; if it continues, contact support.');
    }
    throw e;
  }
}

// Resolver for SYSTEM / auto SMS (low stock, transaction alerts, reminders,
// daily summaries...). Prefers the shop's approved (default) own sender so that
// business traffic goes out under the client's brand, and falls back to the ALFEAN ENTERPRISES
// system sender ("ALFEAN ENTERPRISES POS") which is reserved exclusively for system auto-SMS.
// getSystemSender() ensures/heals that system row on demand. Balance is always
// the CLIENT's — sendUserSms / sendUserBulkSms deduct it.
export async function resolveSystemSmsSender(shopId: string): Promise<any | null> {
  const own = await pool.query(
    `SELECT * FROM sms_sender_ids
     WHERE shop_id = $1 AND status = 'approved' AND is_system = false
     ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
    [shopId]
  );
  // An approved row without a provider UUID cannot actually send — fall through
  // to the system sender instead of failing every automatic message.
  if (own.rows[0]?.provider_id) return own.rows[0];
  return getSystemSender(shopId);
}

// Developer actions
export async function adminSubmitSenderId(id: string) {
  const r = await pool.query(`SELECT * FROM sms_sender_ids WHERE id = $1`, [id]);
  if (r.rows.length === 0) throw new Error('Sender ID request not found');
  const row = r.rows[0];
  if (row.status === 'approved') throw new Error('Sender ID is already approved');

  const result = await ehub.requestSenderId(row.sender_id, row.purpose, row.sample || undefined);
  const providerId = result?.id || result?.sender_id_id || result?.uuid || null;

  await pool.query(
    `UPDATE sms_sender_ids
     SET status = 'submitted', provider_id = $2, submitted_at = NOW(),
         rejected_reason = NULL, provider_reason = NULL, provider_status = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id, providerId]
  );
  return { ...row, status: 'submitted', provider_id: providerId, provider_result: result };
}

// Sends a rejection notification (SMS + email) to the sender ID applicant and
// marks rejection_notify_sent. Returns which channels were attempted. The
// optional `guidance` is the developer's "what to do" advice; both reason and
// guidance tell the applicant they may apply again from the SMS Center.
async function notifyRejectedSender(row: any, reason?: string, guidance?: string): Promise<{ sms: boolean; email: boolean; hasContact: boolean }> {
  const hasContact = Boolean(row.applied_email || row.applied_phone);
  if (!hasContact) return { sms: false, email: false, hasContact: false };

  const reasonText = reason || row.review_reason || row.rejected_reason || 'Not specified';
  const guidanceText = guidance || row.rejection_guidance || '';
  const shop = await pool.query(`SELECT name FROM shops WHERE id = $1`, [row.shop_id]);
  const shopName = shop.rows[0]?.name || 'ALFEAN ENTERPRISES';

  const smsMsg = `Habari ${shopName}, ombi lako la sender ID "${row.sender_id}" limekataliwa. Sababu: ${reasonText}.${guidanceText ? ` Hatua ya kuchukua: ${guidanceText}.` : ''} Unaweza kuomba tena kwenye mfumo (SMS Center) kwa jina hilo hilo au jina lingine. Simu 255775699545. - ALFEAN ENTERPRISES`;
  const emailHtml = `
    <h2 style="color:#dc2626; margin:0 0 16px;">Sender ID Rejected</h2>
    <p style="font-size:15px; color:#374151; line-height:1.6;">Your sender ID <strong>${row.sender_id}</strong> for <strong>${shopName}</strong> has been <strong>rejected</strong>.</p>
    <p style="font-size:15px; color:#374151; line-height:1.6;"><strong>Reason:</strong> ${reasonText}</p>
    ${guidanceText ? `<p style="font-size:15px; color:#374151; line-height:1.6;"><strong>What to do:</strong> ${guidanceText}</p>` : ''}
    <p style="font-size:15px; color:#374151; line-height:1.6;">You can apply again right away: log in to your ALFEAN ENTERPRISES portal, open <strong>SMS Center</strong>, and request the sender ID again with the same name (after fixing the issue) or a different name.</p>
    <p style="font-size:14px; color:#6b7280;">- ALFEAN ENTERPRISES</p>
  `;

  let smsSent = false;
  let emailSent = false;
  if (row.applied_email) {
    try {
      const r = await sendEmail({ to: row.applied_email, subject: `Sender ID "${row.sender_id}" Rejected – Action Required`, html: emailHtml, name: shopName });
      emailSent = r.success !== false;
    } catch (e: any) { console.warn('[SMS] Rejection email failed:', e.message); }
  }
  if (row.applied_phone) {
    try {
      const r = await sendSms(normalizePhone(row.applied_phone), smsMsg);
      smsSent = r.success !== false;
    } catch (e: any) { console.warn('[SMS] Rejection SMS failed:', e.message); }
  }

  // Only mark as notified when at least one channel actually went out, so a
  // failed send is retried automatically on the next provider refresh/sync.
  if (smsSent || emailSent) {
    await pool.query(
      `UPDATE sms_sender_ids SET rejection_notify_sent = true, rejection_notified_at = NOW(), rejection_notified_reason = $2 WHERE id = $1`,
      [row.id, reasonText]
    );
  }
  return { sms: smsSent, email: emailSent, hasContact: true };
}

// Who should receive approval messages: the applicant's own contact first, then
// the shop owner's, then the shop contact — so the message still lands for
// sender IDs the developer linked to a shop directly on eHub (those rows have
// no applicant on file).
async function resolveSenderApplicantContact(row: any): Promise<{ email: string | null; phone: string | null }> {
  let email: string | null = row.applied_email || row.applicant_email || null;
  let phone: string | null = row.applied_phone || row.applicant_phone || null;
  if (email && phone) return { email, phone };
  try {
    const c = await pool.query(
      `SELECT u.email AS owner_email, u.phone AS owner_phone, sh.email AS shop_email, sh.phone AS shop_phone
       FROM shops sh
       LEFT JOIN user_shops us ON us.shop_id = sh.id AND us.role = 'owner'
       LEFT JOIN "user" u ON u.id = us.user_id
       WHERE sh.id = $1
       LIMIT 1`,
      [row.shop_id]
    );
    const owner = c.rows[0] || {};
    email = email || owner.owner_email || owner.shop_email || null;
    phone = phone || owner.owner_phone || owner.shop_phone || null;
  } catch (e: any) { console.warn('[SMS] Contact lookup failed:', e.message); }
  return { email, phone };
}

// Sends an approval notification (SMS + email) the moment a sender ID is
// approved — either by the developer (force-approve) or by a provider status
// sync. Real-time: the applicant learns on their phone right away.
//
// The message doubles as an SMS-sales nudge: it tells the shop to buy SMS in
// the SMS Center and what they can send (debt reminders, offers, receipts,
// daily sales reports) — an approved brand that never buys SMS earns nothing.
async function notifyApprovedSender(row: any): Promise<{ sms: boolean; email: boolean; hasContact: boolean }> {
  const contact = await resolveSenderApplicantContact(row);
  const hasContact = Boolean(contact.email || contact.phone);
  if (!hasContact) return { sms: false, email: false, hasContact: false };

  const shop = await pool.query(`SELECT name FROM shops WHERE id = $1`, [row.shop_id]);
  const shopName = row.shop_name || shop.rows[0]?.name || 'ALFEAN ENTERPRISES';
  const settings = await getResellerSettings();
  const price = Number(settings.price_per_sms) || 25;
  const minPurchase = Number(settings.min_sms_purchase) || 50;

  const smsMsg = `Hongera ${shopName}! Sender ID "${row.sender_id}" yako imeidhinishwa. Nunua SMS kwenye SMS Center - tab ya "Nunua SMS" (TZS ${price}/SMS, kuanzia SMS ${minPurchase}) kisha anza kutuma: kukumbusha madeni, matangazo na ofa, risiti, na ripoti za mauzo ya kila duka. Simu 255775699545. - ALFEAN ENTERPRISES`;
  const emailHtml = `
    <h2 style="color:#059669; margin:0 0 16px;">Sender ID Approved 🎉</h2>
    <p style="font-size:15px; color:#374151; line-height:1.6;">Your sender ID <strong>${row.sender_id}</strong> for <strong>${shopName}</strong> has been <strong>approved</strong> — you can now send SMS in your own business name.</p>
    <p style="font-size:15px; color:#374151; line-height:1.6;"><strong>Next step — buy SMS:</strong> log in to your ALFEAN ENTERPRISES portal, open <strong>SMS Center</strong> and go to the <strong>Nunua SMS</strong> tab (TZS ${price} per SMS, minimum ${minPurchase} SMS).</p>
    <p style="font-size:15px; color:#374151; line-height:1.6;"><strong>What you can send with ALFEAN ENTERPRISES SMS:</strong></p>
    <ul style="font-size:15px; color:#374151; line-height:1.6; padding-left:20px;">
      <li>Kukumbusha madeni (debt reminders)</li>
      <li>Matangazo, ofa na bidhaa mpya</li>
      <li>Risiti za mauzo</li>
      <li>Ripoti ya mauzo ya kila duka kila siku</li>
    </ul>
    <p style="font-size:14px; color:#6b7280;">- ALFEAN ENTERPRISES</p>
  `;

  let smsSent = false;
  let emailSent = false;
  if (contact.email) {
    try {
      const r = await sendEmail({
        to: contact.email,
        subject: `Sender ID "${row.sender_id}" Approved ✅ — Buy SMS & start sending`,
        html: emailHtml,
        name: shopName,
      });
      emailSent = r.success !== false;
    } catch (e: any) { console.warn('[SMS] Approval email failed:', e.message); }
  }
  if (contact.phone) {
    try {
      const r = await sendSms(normalizePhone(contact.phone), smsMsg);
      smsSent = r.success !== false;
    } catch (e: any) { console.warn('[SMS] Approval SMS failed:', e.message); }
  }

  // Track the last successful approval message so the developer registry shows
  // "Notified <date>" and the reminder count (marketing follow-up).
  if (smsSent || emailSent) {
    await pool.query(
      `UPDATE sms_sender_ids
       SET approval_notify_sent = true,
           approval_notified_at = NOW(),
           approval_notify_count = COALESCE(approval_notify_count, 0) + 1
       WHERE id = $1`,
      [row.id]
    );
  }
  return { sms: smsSent, email: emailSent, hasContact: true };
}

// Developer action: (re)send the approval + "buy SMS" message to the applicant
// of an APPROVED sender ID. Approvals alone don't sell SMS — this nudges the
// shop to top up in the SMS Center and start sending. Accepts any approved row,
// including provider senders linked to a shop (falls back to the shop owner's
// contact when there is no applicant on file).
export async function notifySenderApproval(id: string) {
  const r = await pool.query(
    `SELECT s.*, sh.name as shop_name, sh.email as shop_email, sh.phone as shop_phone,
            u.email as applicant_email, u.phone as applicant_phone
     FROM sms_sender_ids s
     JOIN shops sh ON sh.id = s.shop_id
     LEFT JOIN "user" u ON u.id = s.applied_by
     WHERE s.id = $1`,
    [id]
  );
  if (r.rows.length === 0) throw new Error('Sender ID request not found');
  const row = r.rows[0];
  if (row.status !== 'approved') {
    throw new Error(`Sender ID is "${row.status}" — only an approved sender ID can be announced`);
  }
  const notification = await notifyApprovedSender(row);
  return { ...row, notification };
}

export async function adminRejectSenderId(id: string, reason?: string, notifyApplicant: boolean = true, guidance?: string) {
  const r = await pool.query(
    `UPDATE sms_sender_ids
     SET status = 'rejected',
         rejected_reason = COALESCE($2, rejected_reason, 'Rejected by admin'),
         review_reason = COALESCE($2, review_reason),
         rejection_guidance = COALESCE($3, rejection_guidance),
         rejected_at = NOW(),
         rejection_notify_sent = false, rejection_notified_at = NULL, rejection_notified_reason = NULL,
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, reason || null, guidance || null]
  );
  if (r.rows.length === 0) throw new Error('Sender ID request not found');
  const row = r.rows[0];
  let notification: { sms: boolean; email: boolean; hasContact: boolean } | undefined;
  if (notifyApplicant) {
    notification = await notifyRejectedSender(row, reason, guidance);
  }
  return { ...row, notification };
}

// Developer: save the applicant-facing rejection reason + the "what to do"
// guidance WITHOUT notifying, so the wording can be reviewed before sending.
export async function adminUpdateSenderIdRejection(id: string, reason?: string, guidance?: string) {
  const r = await pool.query(
    `UPDATE sms_sender_ids
     SET review_reason = COALESCE($2, review_reason),
         rejection_guidance = COALESCE($3, rejection_guidance),
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, reason || null, guidance || null]
  );
  if (r.rows.length === 0) throw new Error('Sender ID request not found');
  return r.rows[0];
}

// Re-send the rejection notification (SMS + email) to the applicant, e.g. after
// the developer corrects the reason/guidance or the applicant missed the first
// message. Any reason/guidance passed here is persisted first so the applicant
// reads exactly what the developer wrote.
export async function notifySenderRejection(id: string, reason?: string, guidance?: string) {
  const r = await pool.query(`SELECT * FROM sms_sender_ids WHERE id = $1`, [id]);
  if (r.rows.length === 0) throw new Error('Sender ID request not found');
  let row = r.rows[0];
  if (reason || guidance) {
    const updated = await pool.query(
      `UPDATE sms_sender_ids
       SET review_reason = COALESCE($2, review_reason),
           rejection_guidance = COALESCE($3, rejection_guidance),
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, reason || null, guidance || null]
    );
    row = updated.rows[0];
  }
  const notification = await notifyRejectedSender(row, reason, guidance);
  return { ...row, notification };
}

// DEV/TEST: force-approve a sender ID without contacting the provider.
export async function adminForceApproveSenderId(id: string) {
  const r = await pool.query(`SELECT * FROM sms_sender_ids WHERE id = $1`, [id]);
  if (r.rows.length === 0) throw new Error('Sender ID request not found');
  const row = r.rows[0];
  if (row.status === 'approved') return { ...row, status: 'approved' };
  const updated = await pool.query(
    `UPDATE sms_sender_ids
     SET status = 'approved', provider_id = COALESCE(provider_id, 'test-provider'),
         submitted_at = COALESCE(submitted_at, NOW()), rejected_reason = NULL,
         provider_reason = NULL, provider_status = 'approved', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  // Real-time: tell the applicant on their phone that it's approved.
  let notification: { sms: boolean; email: boolean; hasContact: boolean } | undefined;
  try {
    notification = await notifyApprovedSender(updated.rows[0]);
  } catch (e: any) { console.warn('[SMS] Approval notify failed:', e.message); }
  return { ...updated.rows[0], notification };
}

// DEV/TEST: reopen a sender ID back to 'pending' so the onboarding flow can be re-tested.
export async function adminReopenSenderId(id: string) {
  const r = await pool.query(
    `UPDATE sms_sender_ids
     SET status = 'pending', provider_id = NULL, rejected_reason = NULL,
         provider_reason = NULL, provider_status = NULL,
         review_reason = NULL, rejection_guidance = NULL, rejected_at = NULL,
         rejection_notify_sent = false, rejection_notified_at = NULL,
         approval_notify_sent = false, approval_notified_at = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  if (r.rows.length === 0) throw new Error('Sender ID request not found');
  return r.rows[0];
}

export async function adminSyncSenderStatuses() {
  let providerSenderIds: any[] = [];
  try {
    providerSenderIds = await ehub.getSenderIds();
  } catch (e: any) {
    console.warn('[SMS] Could not reach eHub for sender sync:', e.message);
    return { synced: 0, updated: 0, error: e.message, offline: true };
  }
  let updated = 0;
  let notified = 0;

  // Current DB state before syncing — needed to detect real status CHANGES so
  // we only notify applicants once, when their sender ID actually moves.
  const before = await pool.query(`SELECT UPPER(sender_id) AS name, status, id FROM sms_sender_ids WHERE sender_id IS NOT NULL`);
  const beforeMap = new Map<string, string>((before.rows as any[]).map((r) => [r.name, r.status]));

  for (const pid of providerSenderIds) {
    const name = String(pid.sender_id || pid.senderId || pid.name || '').trim().toUpperCase();
    if (!name) continue;
    const status = String(pid.status || '').toLowerCase();
    const providerReason = extractProviderReason(pid) || (status && !['approved', 'active', 'enabled'].includes(status)
      ? await fetchProviderReasonDetail(pid)
      : null);
    let newStatus = 'submitted';
    if (['approved', 'active', 'enabled'].includes(status)) newStatus = 'approved';
    else if (status === 'rejected' || status === 'declined') newStatus = 'rejected';

    const r = await pool.query(
      `UPDATE sms_sender_ids
       SET status = $2::varchar,
           provider_id = COALESCE(provider_id, $3),
           rejected_reason = CASE WHEN $2::varchar = 'rejected' THEN COALESCE($4::text, rejected_reason, 'Rejected by eHub') ELSE NULL END,
           provider_reason = COALESCE($4::text, provider_reason),
           provider_status = COALESCE($5::varchar, provider_status),
           updated_at = NOW()
       WHERE UPPER(sender_id) = $1
         -- A freshly re-applied row (no provider_id yet) must not be knocked
         -- back to rejected by the provider's stale record under the same name.
         -- provider_id is also never overwritten by this sync — the row keeps
         -- the id stored when it was submitted.
         AND NOT (last_reapply_at IS NOT NULL AND provider_id IS NULL)
       RETURNING *`,
      [name, newStatus, pid.id, providerReason, status || null]
    );
    updated += r.rowCount || 0;

    // Real-time notification on a genuine status change (submitted → approved /
    // rejected). Best-effort so one bad phone number can never break the sync.
    const oldStatus = beforeMap.get(name);
    const row = r.rows[0];
    if (row) {
      try {
        if (newStatus === 'approved' && oldStatus && oldStatus !== 'approved') {
          await notifyApprovedSender(row);
          notified++;
        } else if (
          newStatus === 'rejected'
          && (
            oldStatus !== 'rejected'
            || row.rejection_notify_sent !== true
            || (providerReason && providerReason !== row.rejection_notified_reason)
          )
        ) {
          await notifyRejectedSender(row);
          notified++;
        }
      } catch (e: any) {
        console.warn('[SMS] Sender change notify failed:', e.message);
      }
    }
  }

  return { synced: providerSenderIds.length, updated, notified };
}

// ─── SENDING ─────────────────────────────────────────────────────────────────

async function logSmsMessage(opts: {
  shopId: string;
  recipient: string;
  message: string;
  parts: number;
  credits: number;
  cost: number;
  status: string;
  providerMessageId?: string;
  senderId?: string;
  campaignId?: string;
  source?: string;
  senderRowId?: string;
  senderProviderId?: string;
  queuedAt?: Date | null;
  error?: string;
}) {
  try {
    const r = await pool.query(
      `INSERT INTO sms_messages (shop_id, recipient, message, parts, credits, cost, status, provider_message_id, sender_id, campaign_id, source, sender_row_id, sender_provider_id, queued_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        opts.shopId, opts.recipient, opts.message, opts.parts, opts.credits, opts.cost,
        opts.status, opts.providerMessageId || null, opts.senderId || null, opts.campaignId || null, opts.source || 'manual',
        opts.senderRowId || null, opts.senderProviderId || null, opts.queuedAt || null, opts.error || null,
      ]
    );
    return r.rows[0]?.id || null;
  } catch (e: any) {
    // Never let monitoring persistence break a real send — the SMS already left
    // the device; log the failure for ops and carry on.
    console.error('[SMS] Failed to persist sms_messages row:', e.message);
    return null;
  }
}

// Returns whether the provider float can currently deliver SMS (reachable and
// has at least one unit of credit). When this is false, user sends are queued
// and flushed once the developer tops up the wallet — the user never sees that
// the provider is out of balance.
export async function getProviderCanSend(): Promise<boolean> {
  try {
    const status = await getProviderWalletStatus();
    return status.reachable && status.sms_balance > 0;
  } catch {
    return false;
  }
}

// ─── AI CONTENT REVIEW ───────────────────────────────────────────────────────
// Every user-sent SMS is logged and reviewed by AI for content that may violate
// Tanzanian law / TCRA regulations (scams, fraudulent promotions, gambling,
// pornography, hate speech, etc.). Flagged messages surface in the developer
// dashboard so the developer can act. This runs non-blocking (fire & forget).

// Deterministic hard-blocklist — clearly criminal content never even reaches
// the AI. Kept deliberately narrow to avoid blocking legitimate business SMS;
// everything else is judged by the AI classifier below.
const BLOCKED_PATTERNS: RegExp[] = [
  /\byou have won\b/i,
  /\byou'?ve won\b/i,
  /\bclaim.*prize\b/i,
  /\blottery\b/i,
  /\bjackpot\b/i,
  /\bfree money\b/i,
  /\bdouble your money\b/i,
  /\bmpesa\s*(pin|code|password)\b/i,
  /\bbank\s*(details|account|numbers?)\b/i,
  /\bhack(er|ing|ed)?\b/i,
  /\b(utapeli|ulogushi|fedha za bure|pesa za bure)\b/i,
  /\btuma\s+(kiasi|fedha|pesa)\s+[0-9]/i,
  /\bsend\s+(money|kiasi)\s+to\b/i,
];

// System-generated templates (receipts, debt reminders, low-stock alerts, ...)
// are developer-authored and exempt from the blocking check — they cannot be
// edited by the shop user.
const SYSTEM_SMS_SOURCES = new Set([
  'sale', 'new_product', 'debt_reminder', 'invoice_reminder', 'admin_sale',
  'low_stock_alert', 'payment', 'trial', 'expiry', 'system',
]);

export interface SmsContentCheckResult {
  allowed: boolean;
  risk: string;
  reasons: string[];
  source: 'blocklist' | 'ai' | 'unchecked' | 'system';
}

// BLOCKING pre-send surveillance for user-typed content. Throws a Swahili
// error when the message is clearly scam/fraud/hacking/abuse so the SMS can
// NEVER be sent, and logs the blocked attempt for the developer portal.
export async function assertSmsContentAllowed(opts: {
  message: string;
  shopId: string;
  recipient?: string;
  source?: string;
}): Promise<SmsContentCheckResult> {
  const message = String(opts.message || '');
  const source = opts.source || 'manual';

  // System templates skip blocking (still logged by the caller).
  if (SYSTEM_SMS_SOURCES.has(source)) {
    return { allowed: true, risk: 'safe', reasons: [], source: 'system' };
  }

  const settings = await getResellerSettings();
  if (settings.ai_review_enabled === false) {
    return { allowed: true, risk: 'unchecked', reasons: [], source: 'unchecked' };
  }

  // 1. Deterministic blocklist — instant, always on.
  const blockHits: string[] = [];
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(message)) blockHits.push(re.source);
  }

  if (blockHits.length > 0) {
    await logBlockedSms(opts, 'high', blockHits, 'blocklist');
    throw new Error(
      `SMS yako ina viashiria vibaya (${blockHits.join(', ').slice(0, 120)}) na haijaruhusiwa kutumwa. Andika ujumbe wa biashara wa kawaida na ujaribu tena.`
    );
  }

  // 2. AI classifier — catches grey-area utapeli/hacking/abuse.
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { allowed: true, risk: 'unchecked', reasons: [], source: 'unchecked' };
  }

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a compliance reviewer for a Tanzanian SMS gateway. Review the SMS content and classify its risk.
Rules: Return ONLY JSON: {"risk":"safe|low|medium|high","reasons":["..."]}
- "safe": normal business/marketing/notification message
- "low": minor marketing puffery
- "medium": aggressive/possibly misleading marketing or promotional claims
- "high": likely scam (utapeli), fraud, phishing, hacking attempts, illegal gambling, porn, hate speech, or TCRA-prohibited content
Be conservative: only flag "high" for clearly unlawful content.`,
          },
          { role: 'user', content: message.slice(0, 1000) },
        ],
        max_tokens: 200,
        temperature: 0.1,
      }),
    });
    if (!response.ok) return { allowed: true, risk: 'unchecked', reasons: [], source: 'unchecked' };
    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const risk = String(parsed.risk || 'safe').toLowerCase();
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5) : [];

    if (risk === 'high') {
      await logBlockedSms(opts, 'high', reasons, 'ai');
      throw new Error(
        `SMS yako ina viashiria vibaya (${(reasons.join('; ') || 'utapeli').slice(0, 120)}) na haijaruhusiwa kutumwa. Andika ujumbe wa biashara wa kawaida na ujaribu tena.`
      );
    }

    return { allowed: true, risk, reasons, source: 'ai' };
  } catch (e: any) {
    // Re-throw our own blocking errors; treat AI outages as unchecked (allow).
    if (e.message?.includes('SMS yako ina viashiria vibaya')) throw e;
    return { allowed: true, risk: 'unchecked', reasons: [], source: 'unchecked' };
  }
}

// Persists a blocked attempt into the SMS log (status='blocked', risk=high) and
// alerts the developer so it surfaces in the /developer portal for review.
async function logBlockedSms(
  opts: { message: string; shopId: string; recipient?: string; source?: string },
  risk: string,
  reasons: string[],
  source: 'blocklist' | 'ai'
) {
  try {
    const parts = countSmsParts(opts.message);
    const msgId = await logSmsMessage({
      shopId: opts.shopId,
      recipient: opts.recipient || 'BLOCKED',
      message: opts.message,
      parts,
      credits: 0,
      cost: 0,
      status: 'blocked',
      source: opts.source || 'manual',
      error: `Blocked by SMS surveillance (${source}): ${reasons.join('; ')}`,
    });
    if (msgId) {
      await pool.query(
        `UPDATE sms_messages SET ai_reviewed = true, ai_risk = 'high', ai_flags = $2, ai_reviewed_at = NOW() WHERE id = $1`,
        [msgId, JSON.stringify(reasons)]
      );
      await notifyDeveloperOfFlagged(msgId, opts.message, opts.shopId, opts.recipient || 'BLOCKED', opts.source || 'manual', reasons);
    }
  } catch (e: any) {
    console.warn('[SMS] Blocked-message logging failed:', e.message);
  }
}

// Classifies a single SMS body with the DeepSeek compliance classifier.
// Returns null when AI review is disabled/unavailable — callers then leave the
// row as "unchecked" so the developer sees it was not reviewed.
async function classifySmsContent(message: string): Promise<{ risk: string; reasons: string[] } | null> {
  const settings = await getResellerSettings();
  if (settings.ai_review_enabled === false) return null;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a compliance reviewer for a Tanzanian SMS gateway. Review the SMS content and classify its risk.
Rules: Return ONLY JSON: {"risk":"safe|low|medium|high","reasons":["..."]}
- "safe": normal business/marketing/notification message
- "low": minor marketing puffery
- "medium": aggressive/possibly misleading marketing or promotional claims
- "high": likely scam (utapeli), fraud, phishing, hacking attempts, illegal gambling, porn, hate speech, or TCRA-prohibited content
Be conservative: only flag "high" for clearly unlawful content.`,
          },
          { role: 'user', content: message.slice(0, 1000) },
        ],
        max_tokens: 200,
        temperature: 0.1,
      }),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return {
      risk: String(parsed.risk || 'safe').toLowerCase(),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5) : [],
    };
  } catch {
    return null;
  }
}

// Reviews one logged message and writes the AI verdict back to its DB row.
// `messageId` MUST be the sms_messages row id (not the provider message id).
async function aiReviewQueued(messageId: string | null, message: string, shopId: string, recipient: string, source?: string): Promise<boolean> {
  if (!messageId) return false;
  try {
    const verdict = await classifySmsContent(message);
    if (!verdict) return false;

    await pool.query(
      `UPDATE sms_messages SET ai_reviewed = true, ai_risk = $2, ai_flags = $3, ai_reviewed_at = NOW() WHERE id = $1`,
      [messageId, verdict.risk, JSON.stringify(verdict.reasons)]
    );

    // Notify the developer when a message is clearly unlawful.
    if (verdict.risk === 'high') {
      await notifyDeveloperOfFlagged(messageId, message, shopId, recipient, source, verdict.reasons);
    }
    return true;
  } catch {
    /* AI review is best-effort — never blocks sending */
    return false;
  }
}

// Reviews one bulk message body ONCE and applies the same verdict to every
// logged row — avoids hammering the AI endpoint for identical campaign content.
async function aiReviewMany(messageIds: string[], message: string, shopId: string, recipient: string, source?: string): Promise<number> {
  const ids = messageIds.filter(Boolean);
  if (ids.length === 0) return 0;
  try {
    const verdict = await classifySmsContent(message);
    if (!verdict) return 0;

    await pool.query(
      `UPDATE sms_messages SET ai_reviewed = true, ai_risk = $2, ai_flags = $3, ai_reviewed_at = NOW() WHERE id = ANY($1::uuid[])`,
      [ids, verdict.risk, JSON.stringify(verdict.reasons)]
    );

    if (verdict.risk === 'high') {
      await notifyDeveloperOfFlagged(ids[0], message, shopId, recipient, source, verdict.reasons);
    }
    return ids.length;
  } catch {
    return 0;
  }
}

// Developer-triggered batch review: classifies messages still marked
// "unchecked" so older sends can be reviewed without waiting for new traffic.
export async function reviewUnreviewedSms(limit = 50): Promise<{ scanned: number; reviewed: number }> {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const r = await pool.query(
    `SELECT id, message, shop_id, recipient, source
     FROM sms_messages
     WHERE COALESCE(ai_reviewed, false) = false AND status <> 'blocked'
     ORDER BY created_at DESC
     LIMIT $1`,
    [capped]
  );
  let reviewed = 0;
  for (const row of r.rows) {
    const ok = await aiReviewQueued(row.id, row.message, row.shop_id, row.recipient, row.source);
    if (ok) reviewed++;
  }
  return { scanned: r.rows.length, reviewed };
}

// Aggregated counters for the developer SMS Monitoring header.
export async function getSmsMonitoringStats() {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
        COUNT(*) FILTER (WHERE ai_risk = 'high' AND status <> 'blocked')::int AS high,
        COUNT(*) FILTER (WHERE ai_risk = 'medium')::int AS medium,
        COUNT(*) FILTER (WHERE ai_risk = 'low')::int AS low,
        COUNT(*) FILTER (WHERE ai_risk = 'safe')::int AS safe,
        COUNT(*) FILTER (WHERE ai_risk IS NULL AND status <> 'blocked')::int AS unreviewed,
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
        COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered
      FROM sms_messages
    `);
    return r.rows[0];
  } catch {
    // Older DBs without the AI columns — return what we can still count.
    const r = await pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
        0::int AS high, 0::int AS medium, 0::int AS low, 0::int AS safe,
        COUNT(*)::int AS unreviewed,
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
        COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered
      FROM sms_messages
    `);
    return r.rows[0];
  }
}

async function notifyDeveloperOfFlagged(messageId: string, message: string, shopId: string, recipient: string, source?: string, reasons: string[] = []) {
  try {
    const settings = await getResellerSettings();
    let email = settings.purchase_notify_email || settings.provider_alert_email || '';
    let phone = settings.purchase_notify_phone || settings.provider_alert_phone || '';
    if (!email && !phone) {
      const dev = await pool.query(
        `SELECT phone, email FROM "user" WHERE role = 'developer' AND (phone IS NOT NULL OR email IS NOT NULL)
         ORDER BY created_at ASC LIMIT 1`
      );
      if (dev.rows[0]) {
        email = email || dev.rows[0].email || '';
        phone = phone || dev.rows[0].phone || '';
      }
    }

    const shopRes = await pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]);
    const shopName = shopRes.rows[0]?.name || 'Unknown shop';
    const reasonText = reasons.join('; ') || 'Possible prohibited content';

    if (email) {
      const html = `
        <h2 style="margin:0 0 16px;color:#dc2626;">⚠️ Flagged SMS Content</h2>
        <p style="font-size:14px;color:#374151;">A user SMS was flagged by AI review as potentially unlawful.</p>
        <table style="border-collapse:collapse;width:100%;font-size:14px;color:#374151;">
          <tr><td style="padding:6px 0;color:#6b7280;">Shop</td><td style="text-align:right;font-weight:600;">${shopName}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Recipient</td><td style="text-align:right;font-weight:600;">${recipient}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Source</td><td style="text-align:right;font-weight:600;">${source || 'manual'}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Reason</td><td style="text-align:right;font-weight:600;">${reasonText}</td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">Message: ${message.replace(/</g, '&lt;')}</p>
        <p style="font-size:13px;color:#6b7280;">Review in Developer Dashboard → SMS Reseller Control → AI Review.</p>
      `;
      await sendEmail({ to: email, subject: `Flagged SMS — ${shopName} (${reasonText.slice(0, 60)})`, html, templateKey: 'sms_ai_flag' });
    }
    if (phone) {
      try {
        const msg = `ALFEAN ENTERPRISES: SMS flagged! Duka ${shopName} alituma ujumbe wenye hatari: ${reasonText.slice(0, 90)}. Angalia dashboard.`;
        await sendSms(normalizePhone(phone), msg, undefined);
      } catch { /* ignore */ }
    }
  } catch (e: any) {
    console.warn('[SMS] Flagged notification failed:', e.message);
  }
}

// Paginated list of messages for the developer AI-review dashboard. Filters by
// review status and risk level.
export async function listAiReviewedMessages(opts: { page?: number; limit?: number; risk?: string; unreviewed?: boolean }) {
  const page = opts.page || 1;
  const limit = Math.min(opts.limit || 50, 200);
  const offset = (page - 1) * limit;
  const where: string[] = [];
  const params: any[] = [];
  if (opts.risk) {
    params.push(opts.risk);
    where.push(`m.ai_risk = $${params.length}`);
  }
  if (opts.unreviewed) {
    where.push(`(m.ai_reviewed = false OR m.ai_reviewed IS NULL)`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM sms_messages m ${whereSql}`, params);
  const rows = await pool.query(
    `SELECT m.id, m.recipient, m.message, m.status, m.source, m.created_at,
            m.ai_reviewed, m.ai_risk, m.ai_flags, m.ai_reviewed_at,
            sh.name as shop_name
     FROM sms_messages m
     LEFT JOIN shops sh ON sh.id = m.shop_id
     ${whereSql}
     ORDER BY m.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const total = parseInt(count.rows[0].count);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// Paginated ALL-shops SMS log for the developer portal — every SMS sent by any
// shop (contents included), with shop name, sender, status and AI risk.
// Filters: ?shop= (shop name/partial), ?status=, ?risk=, ?q= (message search).
export async function listAllSmsMessages(opts: {
  page?: number;
  limit?: number;
  shop?: string;
  status?: string;
  risk?: string;
  q?: string;
}) {
  const page = opts.page || 1;
  const limit = Math.min(opts.limit || 50, 200);
  const offset = (page - 1) * limit;
  const where: string[] = [];
  const params: any[] = [];
  if (opts.shop) {
    params.push(`%${opts.shop}%`);
    where.push(`sh.name ILIKE $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`m.status = $${params.length}`);
  }
  if (opts.risk) {
    params.push(opts.risk);
    where.push(`m.ai_risk = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    where.push(`m.message ILIKE $${params.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(
    `SELECT COUNT(*) FROM sms_messages m LEFT JOIN shops sh ON sh.id = m.shop_id ${whereSql}`,
    params
  );
  const rows = await pool.query(
    `SELECT m.id, m.recipient, m.message, m.status, m.source, m.sender_id,
            m.parts, m.credits, m.error, m.created_at,
            m.ai_reviewed, m.ai_risk, m.ai_flags, m.ai_reviewed_at,
            sh.name as shop_name
     FROM sms_messages m
     LEFT JOIN shops sh ON sh.id = m.shop_id
     ${whereSql}
     ORDER BY m.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const total = parseInt(count.rows[0].count);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
// When the provider float is empty, user sends are stored with status='queued'.
// Once the developer tops up the wallet, this drains the queue. Deducted credits
// are NOT charged twice — they were already deducted at queue time.

// ─── RESEND FAILED SMS ───────────────────────────────────────────────────────
// Re-send a single system SMS (sms_log) that failed. The original row is kept
// for the audit trail and marked 'resent'; the adapter writes a fresh row too.
export async function resendSmsLog(id: string) {
  const r = await pool.query(`SELECT * FROM sms_log WHERE id = $1`, [id]);
  if (r.rows.length === 0) throw new Error('SMS record not found');
  const row = r.rows[0];
  const result = await sendSms(row.phone, row.message, row.tenant_id || undefined);
  if (!result.success) throw new Error(result.error || 'Resend failed');
  await pool.query(`UPDATE sms_log SET status = 'resent' WHERE id = $1`, [id]);
  return { success: true, messageId: result.batchId || null };
}

// Bulk retry of everything currently failed in the system SMS log (capped).
export async function resendAllFailedSms(limit = 50) {
  const rows = await pool.query(`SELECT id FROM sms_log WHERE status = 'failed' ORDER BY created_at DESC LIMIT $1`, [limit]);
  let sent = 0, failed = 0;
  for (const row of rows.rows) {
    try { await resendSmsLog(row.id); sent++; } catch { failed++; }
  }
  const remaining = await pool.query(`SELECT COUNT(*)::int AS n FROM sms_log WHERE status = 'failed'`);
  return { attempted: rows.rows.length, sent, failed, remaining: Number(remaining.rows[0].n) || 0 };
}

// Re-send a failed SHOP SMS (sms_messages) — used by the shop's own SMS center
// so a failed message can be retried with one tap. Credits are not deducted
// again: the first attempt failed, so no value was delivered the first time.
export async function resendShopSms(shopId: string, id: string) {
  const r = await pool.query(`SELECT * FROM sms_messages WHERE id = $1 AND shop_id = $2`, [id, shopId]);
  if (r.rows.length === 0) throw new Error('SMS record not found');
  const row = r.rows[0];
  const status = String(row.status || '').toLowerCase();
  if (status !== 'failed' && status !== 'rejected') {
    throw new Error('Only failed SMS can be resent');
  }

  // Send with the SAME sender the message originally used (shop's own approved
  // sender or the ALFEAN ENTERPRISES system sender) — never silently switch the brand.
  let providerId = row.sender_provider_id || null;
  if (!providerId && row.sender_row_id) {
    const s = await pool.query(`SELECT provider_id FROM sms_sender_ids WHERE id = $1`, [row.sender_row_id]);
    providerId = s.rows[0]?.provider_id || null;
  }
  if (!providerId) {
    const sender = await resolveUserSender(row.shop_id);
    providerId = sender?.provider_id || null;
  }
  if (!providerId) throw new Error('No sender available');

  try {
    await ehub.sendSingleSms(normalizePhone(row.recipient), row.message, providerId);
  } catch (e: any) {
    await pool.query(`UPDATE sms_messages SET status = 'failed', error = $2 WHERE id = $1`, [id, e.message || 'Resend failed']);
    throw e;
  }
  await pool.query(`UPDATE sms_messages SET status = 'sent', error = NULL WHERE id = $1`, [id]);
  return { success: true };
}

export async function flushQueuedSms(): Promise<{ sent: number; failed: number; remaining: number }> {
  const canSend = await getProviderCanSend();
  if (!canSend) return { sent: 0, failed: 0, remaining: (await pool.query(`SELECT COUNT(*) FROM sms_messages WHERE status = 'queued'`)).rows[0].count };

  const queued = await pool.query(
    `SELECT * FROM sms_messages WHERE status = 'queued' ORDER BY created_at ASC LIMIT 100`
  );
  let sent = 0;
  let failed = 0;
  for (const row of queued.rows) {
    // Resolve the sender that was chosen at queue time.
    let providerId = row.sender_provider_id;
    if (!providerId && row.sender_row_id) {
      const s = await pool.query(`SELECT provider_id FROM sms_sender_ids WHERE id = $1`, [row.sender_row_id]);
      providerId = s.rows[0]?.provider_id || null;
    }
    if (!providerId) {
      const sender = await resolveUserSender(row.shop_id);
      providerId = sender?.provider_id || null;
    }
    if (!providerId) {
      // Queue-time sender is gone and no replacement exists: fail once and
      // refund the held credits (the message never went out).
      const upd = await pool.query(
        `UPDATE sms_messages SET status = 'failed', error = 'No sender available', attempts = attempts + 1
         WHERE id = $1 AND refunded = false RETURNING credits`,
        [row.id]
      );
      const heldCredits = Number(upd.rows[0]?.credits || 0);
      if (heldCredits > 0) {
        await pool.query(`UPDATE sms_messages SET refunded = true WHERE id = $1`, [row.id]);
        await refundCredits(row.shop_id, heldCredits);
      }
      failed++;
      continue;
    }

    try {
      const result = await ehub.sendSingleSms(normalizePhone(row.recipient), row.message, providerId);
      const msgId = result?.message_id || result?.id || result?.messageId || null;
      await pool.query(
        `UPDATE sms_messages SET status = 'sent', provider_message_id = $2, error = NULL, attempts = attempts + 1, queued_at = NULL WHERE id = $1`,
        [row.id, msgId || null]
      );
      await aiReviewQueued(row.id, row.message, row.shop_id, row.recipient, row.source);
      sent++;
    } catch (e: any) {
      const attempts = Number(row.attempts || 0) + 1;
      const final = attempts >= 5;
      if (final) {
        // Out of retries: mark failed ONCE and refund the held credits — the
        // shop must not pay for an SMS that never left ALFEAN ENTERPRISES.
        const upd = await pool.query(
          `UPDATE sms_messages SET status = 'failed', error = $2, attempts = $3, queued_at = NULL
           WHERE id = $1 AND refunded = false RETURNING credits`,
          [row.id, e.message, attempts]
        );
        const heldCredits = Number(upd.rows[0]?.credits || 0);
        if (heldCredits > 0) {
          await pool.query(`UPDATE sms_messages SET refunded = true WHERE id = $1`, [row.id]);
          await refundCredits(row.shop_id, heldCredits);
        }
        failed++;
      } else {
        // Transient failure (e.g. provider 502/timeout): stay queued and let the
        // 2-minute flusher try again (up to 5 attempts total).
        await pool.query(
          `UPDATE sms_messages SET status = 'queued', error = $2, attempts = $3, queued_at = COALESCE(queued_at, NOW()) WHERE id = $1`,
          [row.id, e.message, attempts]
        );
      }
    }
  }
  const remainingRes = await pool.query(`SELECT COUNT(*) FROM sms_messages WHERE status = 'queued'`);
  return { sent, failed, remaining: parseInt(remainingRes.rows[0].count) || 0 };
}

// ─── AI ASSISTANT FOR USERS ──────────────────────────────────────────────────
// Suggests professional, compliant SMS drafts to the user in the SMS Center.

export async function aiSmsSuggestions(opts: { topic?: string; businessName?: string; message?: string; language?: string; audience?: string }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const language = opts.language === 'en' ? 'English' : 'Swahili';
  const base = opts.message
    ? `Rewrite/improve this SMS professionally (max 160 chars, compliant with TCRA/Tanzania law — no scam, no false promises): "${opts.message}"`
    : `Write a professional marketing SMS for ${opts.businessName || 'the business'}${opts.topic ? ` about ${opts.topic}` : ''}${opts.audience ? ` for ${opts.audience}` : ''}. Max 160 chars, compliant with TCRA/Tanzania law. Include a call to action.`;

  if (!apiKey) {
    return { suggestions: [opts.message || `Habari! Karibu ${opts.businessName || 'duka letu'}. Karibu tena! - ${opts.businessName || 'ALFEAN ENTERPRISES'}`] };
  }

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a professional SMS copywriter in Tanzania. Generate 3 short ${language} SMS drafts (each under 160 chars) that are compliant, sweet, and professional. Never suggest scams or prohibited content. Return ONLY JSON: {"suggestions":["...","...","..."]}`,
          },
          { role: 'user', content: base },
        ],
        max_tokens: 400,
        temperature: 0.8,
      }),
    });
    if (!response.ok) return { suggestions: [] };
    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return { suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [] };
  } catch {
    return { suggestions: [] };
  }
}

async function deductCredits(shopId: string, credits: number) {
  await pool.query(
    `UPDATE sms_accounts SET balance = balance - $2, total_sent = total_sent + $2, updated_at = NOW() WHERE shop_id = $1`,
    [shopId, credits]
  );
}

// Give back credits held for a message that could not be delivered (provider
// permanently down / no sender after retries). Never drops total_sent below 0.
async function refundCredits(shopId: string, credits: number) {
  await pool.query(
    `UPDATE sms_accounts
     SET balance = balance + $2,
         total_sent = GREATEST(total_sent - $2, 0),
         updated_at = NOW()
     WHERE shop_id = $1`,
    [shopId, credits]
  );
}

// Whether a provider error is worth RETRYING (queued + flushed again) instead of
// failing the message outright. Covers nginx/gateway 5xx (the classic
// "Invalid response: <html>...502 Bad Gateway"), timeouts, dropped sockets and
// rate limits. Permanent errors (invalid phone, rejected sender/content) do not
// match, so those still fail immediately as before.
export function isRetryableProviderError(message?: string): boolean {
  const m = String(message || '');
  if (!m) return false;
  return (
    /\b(429|500|502|503|504)\b/.test(m) ||
    /invalid response/i.test(m) ||
    /network error|fetch failed|socket hang up|econnreset|econnrefused|etimedout|eai_again|timeout|timed out|aborted/i.test(m)
  );
}

export async function checkLowBalance(shopId: string) {
  try {
    const [account, settings, shopSms] = await Promise.all([
      getShopAccount(shopId),
      getResellerSettings(),
      getShopSmsSettings(shopId),
    ]);
    const balance = Number(account.balance) || 0;
    const threshold = settings.low_balance_threshold ?? 5;

    if (balance <= threshold && balance > 0 && !account.low_balance_notified) {
      // Claim the "low balance" slot atomically so two overlapping jobs can
      // never send the same nudge twice.
      const claim = await pool.query(
        `UPDATE sms_accounts SET low_balance_notified = true, updated_at = NOW()
         WHERE shop_id = $1 AND low_balance_notified = false RETURNING shop_id`,
        [shopId]
      );
      if (claim.rows.length > 0) {
        await notifyOwner(shopId, 'SMS Balance Low', `SMS balance yako imebaki SMS ${balance} tu. Nunua SMS zaidi ili uendelee kupata ripoti za mauzo, kuwatumia wateja SMS na kukumbusha madeni.`);
        try {
          await sendBalanceAlertSms(shopId, balance);
        } catch { /* ignore */ }
      }
    }

    // Balance exhausted → warn the owner once that auto-SMS to customers is paused
    if (balance === 0 && !account.balance_exhausted_notified) {
      const claim = await pool.query(
        `UPDATE sms_accounts SET balance_exhausted_notified = true, low_balance_notified = false, updated_at = NOW()
         WHERE shop_id = $1 AND balance_exhausted_notified = false RETURNING shop_id`,
        [shopId]
      );
      if (claim.rows.length > 0) {
        const exhaustedMsg = settings.balance_exhausted_message || DEFAULT_RESELLER_SETTINGS.balance_exhausted_message;
        await notifyOwner(shopId, 'SMS Balance Exhausted — Auto SMS Paused', exhaustedMsg);
        try {
          await sendBalanceExhaustedSms(shopId);
        } catch { /* ignore */ }
      }
    }

    // Balance topped up again → allow re-warning next time it drops
    if (balance > threshold && account.low_balance_notified) {
      await pool.query(`UPDATE sms_accounts SET low_balance_notified = false, updated_at = NOW() WHERE shop_id = $1`, [shopId]);
    }
    if (balance > 0 && account.balance_exhausted_notified) {
      await pool.query(`UPDATE sms_accounts SET balance_exhausted_notified = false, updated_at = NOW() WHERE shop_id = $1`, [shopId]);
    }
  } catch (e: any) {
    console.error('[SMS] checkLowBalance error:', e.message);
  }
}

// Guard used by the scheduled automation jobs (debt reminder, invoice reminder,
// low-stock alert, daily summary). When the shop has credits, jobs proceed and
// the balance is deducted as usual. When it has none, the owner gets the
// low-balance/exhausted nudge ONCE per cycle (free — sent by ALFEAN ENTERPRISES, not charged
// to the shop) telling them to buy SMS so their reports and reminders resume.
async function ensureSmsBundleForAutomation(shopId: string): Promise<boolean> {
  if (await hasActiveSmsBundle(shopId)) return true;
  await checkLowBalance(shopId);
  return false;
}

async function sendBalanceAlertSms(shopId: string, balance: number) {
  const settings = await getResellerSettings();
  if (settings.sms_enabled === false && settings.enabled === false) return;
  const phone = await getOwnerPhone(shopId);
  if (!phone) return;
  const sender = await resolveSystemSmsSender(shopId);
  if (!sender?.provider_id) return;
  const shopName = (await pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId])).rows[0]?.name || 'Duka';
  const template = settings.low_balance_message || DEFAULT_RESELLER_SETTINGS.low_balance_message;
  const message = (template || '')
    .replaceAll('{balance}', String(balance))
    .replaceAll('{shop_name}', shopName);
  try {
    await ehub.sendSingleSms(normalizePhone(phone), message, sender.provider_id);
  } catch (e: any) {
    console.warn('[SMS] Low balance SMS failed:', e.message);
  }
}

async function sendBalanceExhaustedSms(shopId: string) {
  const settings = await getResellerSettings();
  if (settings.sms_enabled === false && settings.enabled === false) return;
  const phone = await getOwnerPhone(shopId);
  if (!phone) return;
  const sender = await resolveSystemSmsSender(shopId);
  if (!sender?.provider_id) return;
  const shopName = (await pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId])).rows[0]?.name || 'Duka';
  const template = settings.balance_exhausted_message || DEFAULT_RESELLER_SETTINGS.balance_exhausted_message;
  const message = (template || '').replaceAll('{shop_name}', shopName);
  try {
    await ehub.sendSingleSms(normalizePhone(phone), message, sender.provider_id);
  } catch (e: any) {
    console.warn('[SMS] Balance exhausted SMS failed:', e.message);
  }
}

async function notifyOwner(shopId: string, title: string, message: string) {
  try {
    const shop = await pool.query(`SELECT tenant_id FROM shops WHERE id = $1`, [shopId]);
    const tenantId = shop.rows[0]?.tenant_id;
    if (!tenantId) return;
    await pool.query(
      `INSERT INTO notifications (tenant_id, user_id, title, message, type, action_url)
       VALUES ($1, NULL, $2, $3, 'sms', '/sms')`,
      [tenantId, title, message]
    );
  } catch (e: any) {
    console.warn('[SMS] notifyOwner error:', e.message);
  }
}

export async function getOwnerPhone(shopId: string): Promise<string | null> {
  // Preferred: the shop's actual owner/admin membership (user_shops). Falls
  // back to the tenant-level owner for legacy shops without membership rows.
  try {
    const r = await pool.query(
      `SELECT u.phone
       FROM user_shops us
       JOIN "user" u ON u.id = us.user_id
       WHERE us.shop_id = $1 AND u.phone IS NOT NULL AND u.phone <> ''
         AND us.role IN ('owner','admin')
       ORDER BY CASE WHEN us.role = 'owner' THEN 0 ELSE 1 END
       LIMIT 1`,
      [shopId]
    );
    if (r.rows[0]?.phone) return r.rows[0].phone;
  } catch (e: any) {
    console.warn('[SMS] Owner lookup via user_shops failed:', e.message);
  }
  // Legacy fallback: the tenant's admin/owner. Compare tenant ids as TEXT —
  // user.tenant_id is varchar while shops.tenant_id is uuid, so casting the
  // varchar to uuid here used to throw and silently lose the owner's phone.
  try {
    const r = await pool.query(
      `SELECT u.phone FROM "user" u
       JOIN shops s ON s.tenant_id::text = u.tenant_id
       WHERE s.id = $1 AND u.role IN ('admin','owner') AND u.phone IS NOT NULL AND u.phone <> ''
       LIMIT 1`,
      [shopId]
    );
    return r.rows[0]?.phone || null;
  } catch (e: any) {
    console.warn('[SMS] Owner phone fallback failed:', e.message);
    return null;
  }
}

export async function sendUserSms(opts: {
  shopId: string;
  phone: string;
  message: string;
  senderIdRow?: any;
  preferredProviderId?: string;
  source?: string;
  campaignId?: string;
}) {
  const { shopId, phone, message, source } = opts;
  const settings = await getResellerSettings();
  if (settings.sms_enabled === false && settings.enabled === false) {
    throw new Error('SMS service is temporarily disabled');
  }

  // BLOCKING AI surveillance: utapeli / hacking / abuse never goes out.
  await assertSmsContentAllowed({ message, shopId, recipient: phone, source });

  const account = await getShopAccount(shopId);
  const parts = countSmsParts(message);

  if (Number(account.balance) < parts) {
    await checkLowBalance(shopId);
    throw new Error(`Insufficient SMS balance. You need ${parts} credit(s) but you have ${account.balance}. Nunua SMS mpya kupitia Sms Center.`);
  }

  // Resolve sender for USER content (never the system sender).
  const sender = opts.senderIdRow
    ? { provider_id: opts.senderIdRow.provider_id, sender_id: opts.senderIdRow.sender_id, row: opts.senderIdRow }
    : await resolveUserSender(shopId, opts.preferredProviderId);
  if (!sender || !sender.provider_id) {
    throw new Error('Hakuna sender ID inayokubalika. Usajili wa sender yako ukiidhinishwa au tumia sender ya umma.');
  }

  const normalized = normalizePhone(phone);
  if (!isValidTzPhone(normalized)) {
    throw new Error(`Invalid Tanzanian phone number: ${phone}`);
  }

  // Provider float empty? Queue the send; it flushes once the developer tops up.
  const canSend = await getProviderCanSend();
  if (!canSend) {
    await deductCredits(shopId, parts);
    const msgId = await logSmsMessage({
      shopId, recipient: normalized, message, parts,
      credits: parts, cost: 0, status: 'queued',
      senderId: sender.sender_id, senderRowId: sender.row?.id, senderProviderId: sender.provider_id,
      campaignId: opts.campaignId, source, queuedAt: new Date(),
    });
    // Review queued content immediately (non-blocking) so monitoring is complete
    // even before the queue flushes.
    void aiReviewQueued(msgId, message, shopId, normalized, source);
    await checkLowBalance(shopId);
    const remaining = Number(account.balance) - parts;
    return { success: true, queued: true, parts, messageId: msgId, remaining, processing: true };
  }

  try {
    const result = await ehub.sendSingleSms(normalized, message, sender.provider_id);
    const providerId = result?.message_id || result?.id || result?.messageId || null;
    await deductCredits(shopId, parts);
    // Persist FIRST, then review using the sms_messages row id — the provider id
    // is not the DB id, so reviewing before insert silently reviewed nothing.
    const msgId = await logSmsMessage({
      shopId, recipient: normalized, message, parts,
      credits: parts, cost: 0, status: 'sent',
      providerMessageId: providerId, senderId: sender.sender_id,
      senderRowId: sender.row?.id, senderProviderId: sender.provider_id,
      campaignId: opts.campaignId, source,
    });
    void aiReviewQueued(msgId, message, shopId, normalized, source);
    await checkLowBalance(shopId);
    return { success: true, parts, messageId: providerId, remaining: Number(account.balance) - parts };
  } catch (e: any) {
    if (isRetryableProviderError(e.message)) {
      // Transient provider failure (nginx 502/503/timeout...): keep the message
      // in the queue and let the 2-minute flusher retry it automatically —
      // never fail a paid SMS on a blip.
      await deductCredits(shopId, parts);
      const msgId = await logSmsMessage({
        shopId, recipient: normalized, message, parts,
        credits: parts, cost: 0, status: 'queued', error: e.message,
        senderId: sender.sender_id, senderRowId: sender.row?.id, senderProviderId: sender.provider_id,
        campaignId: opts.campaignId, source, queuedAt: new Date(),
      });
      void aiReviewQueued(msgId, message, shopId, normalized, source);
      await checkLowBalance(shopId);
      return { success: true, queued: true, parts, messageId: msgId, remaining: Number(account.balance) - parts, processing: true };
    }
    const msgId = await logSmsMessage({
      shopId, recipient: normalized, message, parts,
      credits: parts, cost: 0, status: 'failed', error: e.message,
      senderId: sender.sender_id, senderRowId: sender.row?.id, senderProviderId: sender.provider_id,
      campaignId: opts.campaignId, source,
    });
    void aiReviewQueued(msgId, message, shopId, normalized, source);
    throw e;
  }
}

// ─── SYSTEM MARKETING SMS ────────────────────────────────────────────────────
// Sends an ALFEAN ENTERPRISES-branded lifecycle message (trial reminders, win-back campaigns)
// from the system sender WITHOUT touching the shop's SMS credits. Provider cost
// is carried by ALFEAN ENTERPRISES, so this is only for platform-level automation.
export async function sendSystemMarketingSms(opts: {
  shopId?: string | null;
  phone: string;
  message: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const settings = await getResellerSettings();
    if (settings.sms_enabled === false && settings.enabled === false) {
      return { success: false, error: 'SMS service disabled' };
    }
    const normalized = normalizePhone(opts.phone);
    if (!isValidTzPhone(normalized)) return { success: false, error: `Invalid phone: ${opts.phone}` };

    // Platform lifecycle marketing (trial reminders, win-backs, offers) is
    // ALFEAN ENTERPRISES-branded: always use the configured system sender from .env, never a
    // shop's own brand.
    let sender: any = null;
    try {
      const info = await ehub.getPrimarySenderInfo();
      if (info?.id) sender = { provider_id: info.id, sender_id: info.sender_id };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
    if (!sender?.provider_id && opts.shopId) {
      // Provider list unreachable — fall back to the shop's stored system row
      // (which is now healed to the configured ALFEAN ENTERPRISES sender).
      sender = await getSystemSender(opts.shopId);
    }
    if (!sender?.provider_id) return { success: false, error: 'No system sender available' };

    const canSend = await getProviderCanSend();
    if (!canSend) return { success: false, error: 'Provider float empty' };

    await ehub.sendSingleSms(normalized, opts.message, sender.provider_id);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function sendUserBulkSms(opts: {
  shopId: string;
  recipients: string[];
  message: string;
  senderIdRow?: any;
  preferredProviderId?: string;
  campaignName?: string;
  source?: string;
  campaignId?: string;
}) {
  const { shopId, recipients, message, source } = opts;
  const settings = await getResellerSettings();
  if (settings.sms_enabled === false && settings.enabled === false) {
    throw new Error('SMS service is temporarily disabled');
  }

  // BLOCKING AI surveillance: utapeli / hacking / abuse never goes out.
  await assertSmsContentAllowed({
    message,
    shopId,
    recipient: recipients[0],
    source,
  });

  const uniquePhones = [...new Set(recipients.map((p) => normalizePhone(p)))];
  if (uniquePhones.length === 0) throw new Error('No valid recipients');
  if (uniquePhones.length > 1000) throw new Error('Maximum 1000 recipients per bulk SMS');

  const parts = countSmsParts(message);
  const totalCredits = parts * uniquePhones.length;

  const account = await getShopAccount(shopId);
  if (Number(account.balance) < totalCredits) {
    // Not enough credits for the whole batch — let the owner know (free nudge,
    // once per low-balance cycle) before skipping.
    await checkLowBalance(shopId);
    throw new Error(`Insufficient SMS balance. You need ${totalCredits} credit(s) but you have ${account.balance}. Nunua SMS mpya kupitia Sms Center.`);
  }

  const sender = opts.senderIdRow
    ? { provider_id: opts.senderIdRow.provider_id, sender_id: opts.senderIdRow.sender_id, row: opts.senderIdRow }
    : await resolveUserSender(shopId, opts.preferredProviderId);
  if (!sender || !sender.provider_id) {
    throw new Error('Hakuna sender ID inayokubalika. Usajili wa sender yako ukiidhinishwa au tumia sender ya umma.');
  }

  // Provider float empty? Queue the whole batch; flushed once topped up.
  const canSend = await getProviderCanSend();
  if (!canSend) {
    await deductCredits(shopId, totalCredits);
    const queuedIds: string[] = [];
    for (const phone of uniquePhones) {
      const id = await logSmsMessage({
        shopId, recipient: phone, message, parts,
        credits: parts, cost: 0, status: 'queued',
        senderId: sender.sender_id, senderRowId: sender.row?.id, senderProviderId: sender.provider_id,
        campaignId: opts.campaignId, source, queuedAt: new Date(),
      });
      if (id) queuedIds.push(id);
    }
    void aiReviewMany(queuedIds, message, shopId, uniquePhones[0], source);
    await checkLowBalance(shopId);
    const remaining = Number(account.balance) - totalCredits;
    return { success: true, queued: true, parts, totalCredits, recipients: uniquePhones.length, remaining, processing: true };
  }

  // eHub caps /sms/send-bulk at 1,000 recipients per request — send in chunks
  // of 500 and keep each chunk's provider id so delivery reports match the
  // right messages. `sentCount` lives outside try/catch so a later chunk
  // failure can mark only the unsent phones as failed.
  const CHUNK_SIZE = 500;
  const sentIds: string[] = [];
  let sentCount = 0;

  try {
    for (let offset = 0; offset < uniquePhones.length; offset += CHUNK_SIZE) {
      const chunk = uniquePhones.slice(offset, offset + CHUNK_SIZE);
      const result = await ehub.sendBulkSms(chunk, message, sender.provider_id, opts.campaignName);
      for (const phone of chunk) {
        const msgId = await logSmsMessage({
          shopId, recipient: phone, message, parts,
          credits: parts, cost: 0, status: 'sent',
          providerMessageId: result?.id || null, senderId: sender.sender_id,
          senderRowId: sender.row?.id, senderProviderId: sender.provider_id,
          campaignId: opts.campaignId, source,
        });
        if (msgId) sentIds.push(msgId);
      }
      sentCount += chunk.length;
    }
    await deductCredits(shopId, totalCredits);
    void aiReviewMany(sentIds, message, shopId, uniquePhones[0], source);
    await checkLowBalance(shopId);
    return { success: true, parts, totalCredits, recipients: uniquePhones.length, remaining: Number(account.balance) - totalCredits };
  } catch (e: any) {
    // A later chunk failed: only the phones that actually went out are 'sent'.
    // Transient provider failures (502/timeout) keep the rest QUEUED for the
    // automatic retry; permanent failures mark them failed and charge only the
    // delivered ones.
    const unsent = uniquePhones.slice(sentCount);
    const retryable = isRetryableProviderError(e.message);
    const restIds: string[] = [];
    for (const phone of unsent) {
      const msgId = await logSmsMessage({
        shopId, recipient: phone, message, parts,
        credits: parts, cost: 0,
        status: retryable ? 'queued' : 'failed',
        error: e.message,
        senderId: sender.sender_id, senderRowId: sender.row?.id, senderProviderId: sender.provider_id,
        campaignId: opts.campaignId, source,
        queuedAt: retryable ? new Date() : null,
      });
      if (msgId) restIds.push(msgId);
    }
    // Charge for delivered chunks + credits held for queued retries.
    const creditsToCharge = parts * (sentCount + (retryable ? unsent.length : 0));
    if (creditsToCharge > 0) {
      try { await deductCredits(shopId, creditsToCharge); } catch { /* best effort */ }
    }
    void aiReviewMany(restIds, message, shopId, uniquePhones[0], source);
    if (retryable) {
      await checkLowBalance(shopId);
      return {
        success: true, queued: true, parts,
        totalCredits: parts * uniquePhones.length,
        recipients: uniquePhones.length,
        remaining: Number(account.balance) - totalCredits,
        processing: true,
      };
    }
    throw e;
  }
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────

export async function getShopSmsHistory(shopId: string, page = 1, limit = 20, status?: string) {
  const offset = (page - 1) * limit;
  const where = ['shop_id = $1'];
  const params: any[] = [shopId];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  const whereSql = where.join(' AND ');
  const count = await pool.query(`SELECT COUNT(*) FROM sms_messages WHERE ${whereSql}`, params);
  const rows = await pool.query(
    `SELECT * FROM sms_messages WHERE ${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const total = parseInt(count.rows[0].count);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// ─── TEMPLATES ───────────────────────────────────────────────────────────────

export async function listTemplates(shopId: string) {
  const r = await pool.query(`SELECT * FROM sms_templates WHERE shop_id = $1 ORDER BY created_at DESC`, [shopId]);
  return r.rows;
}

export async function saveTemplate(shopId: string, data: { name: string; message: string; category?: string; id?: string }) {
  if (data.id) {
    const r = await pool.query(
      `UPDATE sms_templates SET name = $2, message = $3, category = $4 WHERE id = $1 AND shop_id = $5 RETURNING *`,
      [data.id, data.name, data.message, data.category || null, shopId]
    );
    return r.rows[0];
  }
  const r = await pool.query(
    `INSERT INTO sms_templates (shop_id, name, message, category) VALUES ($1, $2, $3, $4) RETURNING *`,
    [shopId, data.name, data.message, data.category || null]
  );
  return r.rows[0];
}

export async function deleteTemplate(shopId: string, id: string) {
  await pool.query(`DELETE FROM sms_templates WHERE id = $1 AND shop_id = $2`, [id, shopId]);
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

export async function listContacts(shopId: string, search?: string) {
  const params: any[] = [shopId];
  let where = 'shop_id = $1';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }
  const r = await pool.query(
    `SELECT * FROM sms_contacts WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  return r.rows;
}

export async function addContact(shopId: string, data: { name?: string; phone: string; email?: string; group_id?: string }) {
  if (!isValidTzPhone(data.phone)) throw new Error('Invalid phone number');
  try {
    const r = await pool.query(
      `INSERT INTO sms_contacts (shop_id, name, phone, email, group_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [shopId, data.name || null, normalizePhone(data.phone), data.email || null, data.group_id || null]
    );
    return r.rows[0];
  } catch (e: any) {
    if (e.message?.includes('unique') || e.message?.includes('duplicate')) throw new Error('Contact with this phone already exists');
    throw e;
  }
}

export async function deleteContact(shopId: string, id: string) {
  await pool.query(`DELETE FROM sms_contacts WHERE id = $1 AND shop_id = $2`, [id, shopId]);
}

// Bulk-import phone numbers into the shop's SMS contacts (deduped & skipped if
// already present). Used when a user pastes or uploads numbers for bulk SMS so
// the numbers are saved and reusable later.
export async function bulkAddContacts(shopId: string, phones: string[]) {
  const unique = [...new Set((phones || []).map((p) => String(p).trim()).filter(Boolean))];
  let added = 0;
  const skipped: string[] = [];
  for (const phone of unique) {
    try {
      await addContact(shopId, { phone });
      added++;
    } catch (e: any) {
      skipped.push(phone);
    }
  }
  return { added, total: unique.length, skipped };
}

export async function listGroups(shopId: string) {
  const r = await pool.query(`SELECT * FROM sms_groups WHERE shop_id = $1 ORDER BY created_at DESC`, [shopId]);
  return r.rows;
}

export async function addGroup(shopId: string, name: string) {
  const r = await pool.query(`INSERT INTO sms_groups (shop_id, name) VALUES ($1, $2) RETURNING *`, [shopId, name]);
  return r.rows[0];
}

export async function listCustomerPhones(shopId: string): Promise<any[]> {
  const r = await pool.query(
    `SELECT id, name, phone, email FROM customers WHERE shop_id = $1 AND phone IS NOT NULL AND phone != ''`,
    [shopId]
  );
  return r.rows;
}

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

export async function listUserCampaigns(shopId: string, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const count = await pool.query(`SELECT COUNT(*) FROM sms_user_campaigns WHERE shop_id = $1`, [shopId]);
  const rows = await pool.query(
    `SELECT * FROM sms_user_campaigns WHERE shop_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [shopId, limit, offset]
  );
  const total = parseInt(count.rows[0].count);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function createUserCampaign(shopId: string, data: any, createdBy: string) {
  // BLOCKING AI surveillance: campaigns with utapeli/hacking/abuse cannot be created.
  await assertSmsContentAllowed({
    message: data.message || '',
    shopId,
    recipient: 'CAMPAIGN',
    source: 'campaign',
  });

  const recipients = Array.isArray(data.recipients) ? data.recipients : [];
  const uniquePhones = [...new Set(recipients.map((p: string) => normalizePhone(p)))];
  const parts = countSmsParts(data.message || '');
  const r = await pool.query(
    `INSERT INTO sms_user_campaigns
       (shop_id, name, message, sender_id, recipients, total_recipients, parts, total_credits, type, status, scheduled_at, recurrence, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      shopId, data.name, data.message, data.sender_id || null,
      JSON.stringify(uniquePhones), uniquePhones.length, parts, parts * uniquePhones.length,
      data.type || 'one_time', data.scheduled_at ? 'scheduled' : 'draft',
      data.scheduled_at || null, data.recurrence || null, createdBy,
    ]
  );
  return r.rows[0];
}

export async function sendUserCampaignNow(shopId: string, campaignId: string) {
  const r = await pool.query(`SELECT * FROM sms_user_campaigns WHERE id = $1 AND shop_id = $2`, [campaignId, shopId]);
  if (r.rows.length === 0) throw new Error('Campaign not found');
  const campaign = r.rows[0];
  if (campaign.status === 'sent') throw new Error('Campaign already sent');
  if (campaign.status === 'sending') throw new Error('Campaign is already being sent');

  const senderRow = campaign.sender_id
    ? (await pool.query(`SELECT * FROM sms_sender_ids WHERE id = $1 AND shop_id = $2`, [campaign.sender_id, shopId])).rows[0]
    : (await resolveUserSender(shopId))?.row || null;

  await pool.query(`UPDATE sms_user_campaigns SET status = 'sending' WHERE id = $1`, [campaignId]);

  try {
    const recipients = Array.isArray(campaign.recipients) ? campaign.recipients : JSON.parse(campaign.recipients || '[]');
    const result = await sendUserBulkSms({
      shopId,
      recipients,
      message: campaign.message,
      senderIdRow: senderRow,
      campaignName: campaign.name,
      source: 'campaign',
      campaignId,
    });
    await pool.query(
      `UPDATE sms_user_campaigns SET status = 'sent', sent_at = NOW(), total_recipients = $2, total_credits = $3 WHERE id = $1`,
      [campaignId, result.recipients, result.totalCredits]
    );
    return result;
  } catch (e: any) {
    await pool.query(`UPDATE sms_user_campaigns SET status = 'failed' WHERE id = $1`, [campaignId]);
    throw e;
  }
}

export async function cancelUserCampaign(shopId: string, campaignId: string) {
  const r = await pool.query(
    `UPDATE sms_user_campaigns SET status = 'cancelled' WHERE id = $1 AND shop_id = $2 AND status = 'scheduled' RETURNING *`,
    [campaignId, shopId]
  );
  if (r.rows.length === 0) throw new Error('Campaign not found or already processed');
  return r.rows[0];
}

export async function deleteUserCampaign(shopId: string, campaignId: string) {
  await pool.query(`DELETE FROM sms_user_campaigns WHERE id = $1 AND shop_id = $2 AND status IN ('draft','cancelled','failed')`, [campaignId, shopId]);
}

// ─── PURCHASES ───────────────────────────────────────────────────────────────

export async function initiateSmsPurchase(shopId: string, credits: number, phone: string, user: any) {
  const settings = await getResellerSettings();
  const qty = Math.floor(Number(credits) || 0);
  const minQty = Number(settings.min_sms_purchase) || 50;
  if (qty < minQty) {
    throw new Error(`Ununuzi wa chini ni SMS ${minQty} (TZS ${(minQty * settings.price_per_sms).toLocaleString()}). Unaweza kununua zaidi kadri utakavyo.`);
  }
  // Snippe rejects non-integer amounts and anything below TZS 500 — a decimal
  // price_per_sms or a tiny order used to die at the API with an opaque error
  // that the UI surfaced as "failed payment". Validate up front, in Swahili.
  const amount = Math.round(qty * settings.price_per_sms);
  if (amount < 500) {
    throw new Error(`Kiwango cha chini cha malipo ni TZS 500. Ongeza idadi ya SMS (unayotaka: TZS ${amount}).`);
  }

  // Normalize + strict-validate the phone the SAME way Snippe will receive it.
  // Malformed numbers (short codes, letters, wrong country code) are the #1
  // reason the USSD push never reaches the customer's phone.
  const rawPhone = String(phone || '').replace(/[^\d+]/g, '');
  const normalizedPhone = rawPhone.startsWith('+') || rawPhone.startsWith('255')
    ? rawPhone.replace('+', '')
    : `255${rawPhone.replace(/^0/, '')}`;
  if (!/^255\d{9}$/.test(normalizedPhone)) {
    throw new Error('Namba ya simu si sahihi. Tumia mfano: 0712345678 au 255712345678.');
  }

  // Snippe keys must be ≤30 chars and unique per attempt. The old format
  // (`sms_${shopId}_${Date.now()}`) was 54 chars and got sliced to 30 — which
  // cut off the timestamp entirely, so every purchase from a shop reused the
  // SAME key. Snippe then returned an idempotency error (different body) or a
  // cached old payment (same body) → failed payments / stuck pendings.
  const idempotencyKey = `sms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payment = await initiateSubscriptionPayment({
    amountTzs: amount,
    phone: normalizedPhone,
    firstName: user?.name?.split(' ')[0] || 'ALFEAN ENTERPRISES',
    lastName: user?.name?.split(' ').slice(1).join(' ') || 'User',
    email: user?.email || 'sms@localhost',
    idempotencyKey,
    metadata: { purpose: 'sms_credits', shop_id: shopId, credits: String(qty) },
  });

  const r = await pool.query(
    `INSERT INTO sms_purchases (shop_id, credits, amount_tzs, price_per_sms, phone_number, snippe_reference, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
    [shopId, qty, amount, settings.price_per_sms, normalizedPhone, payment.reference]
  );

  // Explicitly push the USSD prompt to the customer's phone. Snippe's automatic
  // push on creation is unreliable for these purchases — when it doesn't land,
  // the customer sees nothing and the payment expires after ~10 minutes. Give
  // Snippe a moment to register the payment, then push (fire-and-forget: the
  // frontend starts polling immediately and the push must not delay the reply).
  setTimeout(() => { void ensurePaymentPush(payment.reference); }, 1500);

  return { purchase: r.rows[0], reference: payment.reference, status: payment.status, amount };
}

export async function completeSmsPurchase(snippeReference: string) {
  const settings = await getResellerSettings();

  // ONE transaction: lock the row, flip to completed, and credit the account
  // atomically. The old flow ran the claim UPDATE and creditSmsAccount as two
  // separate statements — if the process (or the credit) failed in between,
  // the row said "completed" while the balance was never credited, and BOTH
  // the webhook retry and the reconcile early-return on completed rows, so the
  // credits were lost permanently ("payment received but balance unchanged").
  const client: any = await pool.connect();
  let purchase: any = null;
  let providerCost = 0;
  let profit = 0;
  let wonClaim = false;
  try {
    await client.query('BEGIN');
    // Row lock serializes webhook vs. on-read reconcile vs. background cron —
    // only one caller can be inside the claim+credit section at a time.
    const r = await client.query(`SELECT * FROM sms_purchases WHERE snippe_reference = $1 FOR UPDATE`, [snippeReference]);
    if (r.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    purchase = r.rows[0];
    providerCost = Math.round(Number(purchase.credits) * (Number(settings.provider_cost) || 0));
    profit = Math.max(0, Number(purchase.amount_tzs) - providerCost);

    if (purchase.status !== 'completed') {
      await client.query(
        `UPDATE sms_purchases SET status = 'completed', paid_at = NOW(), provider_cost = $2, profit = $3 WHERE id = $1`,
        [purchase.id, providerCost, profit]
      );
      wonClaim = true;
      purchase = { ...purchase, status: 'completed', provider_cost: providerCost, profit };
    }

    // Credit in the same transaction, deduped on the PAYMENT REFERENCE (never
    // on the credits amount: a shop buying 100 SMS twice must be credited
    // twice). Also serves as the heal path for a row already marked completed
    // whose credit is missing.
    const alreadyCredit = await client.query(
      `SELECT 1 FROM sms_transactions WHERE shop_id = $1 AND type = 'credit' AND reference = $2 LIMIT 1`,
      [purchase.shop_id, snippeReference]
    );
    if (alreadyCredit.rows.length === 0) {
      await client.query(
        `INSERT INTO sms_accounts (shop_id) VALUES ($1) ON CONFLICT (shop_id) DO UPDATE SET updated_at = NOW()`,
        [purchase.shop_id]
      );
      await client.query(
        `UPDATE sms_accounts SET balance = balance + $2, total_bought = total_bought + $2, updated_at = NOW() WHERE shop_id = $1`,
        [purchase.shop_id, purchase.credits]
      );
      await client.query(
        `INSERT INTO sms_transactions (shop_id, type, credits, amount_tzs, price_per_sms, reference) VALUES ($1, 'credit', $2, $3, $4, $5)`,
        [purchase.shop_id, purchase.credits, purchase.amount_tzs, purchase.price_per_sms, snippeReference]
      );
      await client.query(
        `INSERT INTO sms_provider_ledger (type, sms_quantity, amount_tzs, cost_per_sms, reference, note)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE NOT EXISTS (SELECT 1 FROM sms_provider_ledger WHERE reference = $5)`,
        ['spend', Number(purchase.credits), providerCost, Number(settings.provider_cost) || 0, snippeReference, `SMS purchase (${purchase.credits} credits)`]
      );
    }
    await client.query('COMMIT');
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    client.release();
    throw e;
  }
  client.release();

  // Free one-time bonus (idempotent) — outside the txn; a failure here must
  // never roll back a paid purchase.
  try { await grantFreeSmsBonus(purchase.shop_id); } catch { /* ignore */ }

  if (!wonClaim) {
    // Another caller completed it first — return their committed row.
    const fresh = await pool.query(`SELECT * FROM sms_purchases WHERE id = $1`, [purchase.id]);
    return fresh.rows[0] || purchase;
  }
  await notifyOwner(purchase.shop_id, 'SMS Purchased', `Umefanikiwa kununua SMS ${purchase.credits} kwa TZS ${Number(purchase.amount_tzs).toLocaleString()}.`);
  // Real-time: the shop owner gets an SMS on their phone the moment the
  // purchase completes, with the fresh balance — no need to open the system.
  try {
    const ownerPhone = await getOwnerPhone(purchase.shop_id);
    if (ownerPhone) {
      const acctRes = await pool.query(`SELECT balance FROM sms_accounts WHERE shop_id = $1`, [purchase.shop_id]);
      const balance = Number(acctRes.rows[0]?.balance ?? 0);
      await sendSms(
        normalizePhone(ownerPhone),
        `ALFEAN ENTERPRISES: Umefanikiwa kununua SMS ${purchase.credits} kwa TZS ${Number(purchase.amount_tzs).toLocaleString()}. Salio lako ni SMS ${balance}. Asante! - ALFEAN ENTERPRISES`
      );
    }
  } catch (e: any) {
    console.warn('[SMS] Purchase confirmation SMS failed:', e.message);
  }
  await notifyDeveloperOfPurchase(purchase, settings, providerCost, profit);
  return { ...purchase, status: 'completed', provider_cost: providerCost, profit };
}

// Notifies the developer on every successful SMS purchase so they can watch the
// provider wallet and keep the float topped up. Uses purchase_notify_* settings,
// falling back to the dedicated developer user. Non-fatal.
async function notifyDeveloperOfPurchase(purchase: any, settings: any, providerCost: number, profit: number) {
  try {
    let email = settings.purchase_notify_email || settings.provider_alert_email || '';
    let phone = settings.purchase_notify_phone || settings.provider_alert_phone || '';
    if (!email && !phone) {
      const dev = await pool.query(
        `SELECT phone, email FROM "user" WHERE role = 'developer' AND (phone IS NOT NULL OR email IS NOT NULL)
         ORDER BY created_at ASC LIMIT 1`
      );
      if (dev.rows[0]) {
        email = email || dev.rows[0].email || '';
        phone = phone || dev.rows[0].phone || '';
      }
    }
    if (!email && !phone) return;

    let wallet = 'unknown';
    try {
      wallet = String(await ehub.getWalletBalance());
    } catch { /* ignore */ }

    const shopRes = await pool.query(`SELECT name FROM shops WHERE id = $1`, [purchase.shop_id]);
    const shopName = shopRes.rows[0]?.name || 'Unknown shop';
    const amountTzs = Number(purchase.amount_tzs).toLocaleString();

    if (email) {
      const html = `
        <h2 style="margin:0 0 16px;color:#111827;">SMS Purchase Completed</h2>
        <table style="border-collapse:collapse;width:100%;font-size:14px;color:#374151;">
          <tr><td style="padding:8px 0;color:#6b7280;">Shop</td><td style="text-align:right;font-weight:600;">${shopName}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">SMS bought</td><td style="text-align:right;font-weight:600;">${purchase.credits}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Amount (TZS)</td><td style="text-align:right;font-weight:600;">${amountTzs}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Provider cost (TZS)</td><td style="text-align:right;font-weight:600;">${providerCost.toLocaleString()}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Profit (TZS)</td><td style="text-align:right;font-weight:600;">${profit.toLocaleString()}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Provider wallet (SMS)</td><td style="text-align:right;font-weight:600;">${wallet}</td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">Make sure the provider wallet is topped up so this user's SMS can be delivered.</p>
      `;
      await sendEmail({ to: email, subject: `SMS Purchase — ${shopName} bought ${purchase.credits} SMS (TZS ${amountTzs})`, html, templateKey: 'sms_purchase_notify' });
      console.log(`[SMS] Purchase email sent to ${email}`);
    }
    if (phone) {
      try {
        const msg = `ALFEAN ENTERPRISES: Sms purchase! Duka ${shopName} amenunua SMS ${purchase.credits} (TZS ${amountTzs}). Provider wallet inabaki SMS ${wallet}. Hudumisha float.`;
        await sendSms(normalizePhone(phone), msg, undefined);
      } catch { /* ignore */ }
    }
  } catch (e: any) {
    console.warn('[SMS] Purchase notification failed:', e.message);
  }
}

export async function failSmsPurchase(snippeReference: string) {
  await pool.query(`UPDATE sms_purchases SET status = 'failed' WHERE snippe_reference = $1 AND status = 'pending'`, [snippeReference]);
}

// Reconcile a purchase against the payment provider. If a purchase is still
// "pending" but Snippe reports it completed (e.g. the webhook was missed or
// failed signature verification), finalize it so it stops showing as pending.
export async function reconcileSmsPurchase(reference: string) {
  const r = await pool.query(`SELECT * FROM sms_purchases WHERE snippe_reference = $1`, [reference]);
  if (r.rows.length === 0) return null;
  const purchase = r.rows[0];
  if (purchase.status === 'completed') return purchase;

  try {
    const info = await getPaymentStatus(reference);
    const st = String(info?.status || info?.state || '').toLowerCase();
    if (st === 'completed' || st === 'success' || st === 'paid') {
      return await completeSmsPurchase(reference);
    }
    // 'expired' was missing here — Snippe auto-expires payments after 4h, so
    // those rows stayed "pending" forever in the purchase history.
    if (st === 'failed' || st === 'voided' || st === 'cancelled' || st === 'expired') {
      await failSmsPurchase(reference);
      const upd = await pool.query(`SELECT * FROM sms_purchases WHERE snippe_reference = $1`, [reference]);
      return upd.rows[0] || r.rows[0];
    }
  } catch {
    /* Snippe unreachable — leave as-is, will reconcile again on next check */
  }
  return r.rows[0];
}

// Finalize any pending purchases for a shop whose payment already completed.
// Called when the user opens the purchase history so pending rows never linger.
// Bounded to the payment-expiry window and 8 rows: Snippe rate-limits 60 req/min
// across all users, and this used to fire up to 20 calls on every page load.
export async function reconcileShopPurchases(shopId: string) {
  const pending = await pool.query(
    `SELECT snippe_reference FROM sms_purchases
     WHERE shop_id = $1 AND status = 'pending' AND snippe_reference IS NOT NULL
       AND created_at > NOW() - INTERVAL '6 hours'
     ORDER BY created_at DESC LIMIT 8`,
    [shopId]
  );
  for (const row of pending.rows) {
    try {
      await reconcileSmsPurchase(row.snippe_reference);
    } catch { /* keep others going */ }
  }
  return pending.rows.length;
}

// ─── MANUAL GRANT (developer → shop) ─────────────────────────────────────────
// Developer grants SMS to a shop when auto-purchase failed (provider error) but
// the shop already paid manually (cash / M-Pesa sent directly). Credits land
// instantly in sms_accounts so the shop sees them in SMS Center and can send.
// A completed sms_purchases row + sms_transactions row + provider ledger entry
// are written so revenue/profit reports stay correct. Idempotent per reference.
export async function manualGrantSmsCredits(opts: {
  shopId: string;
  credits: number;
  amountTzs?: number | string;
  reference?: string;
  note?: string;
}) {
  const qty = Math.floor(Number(opts.credits) || 0);
  if (!opts.shopId) throw new Error('shopId is required');
  if (!Number.isFinite(qty) || qty < 1) throw new Error('Credits must be a positive integer');
  if (qty > 100000) throw new Error('Credits too large (max 100000)');

  const shop = await pool.query(`SELECT id, name FROM shops WHERE id = $1`, [opts.shopId]);
  if (shop.rows.length === 0) throw new Error('Shop not found');
  const shopName = shop.rows[0]?.name || 'shop';

  const settings = await getResellerSettings();
  const pricePerSms = Number(settings.price_per_sms) || 25;
  const amountRaw = opts.amountTzs as unknown;
  const amount = amountRaw != null && String(amountRaw).trim() !== ''
    ? Math.max(0, Math.round(Number(amountRaw) || 0))
    : qty * pricePerSms;

  const ref = String(opts.reference || '').trim().slice(0, 120)
    || `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const note = String(opts.note || '').trim().slice(0, 500) || null;

  // Idempotency: same manual reference granted twice → return existing.
  const existing = await pool.query(
    `SELECT * FROM sms_purchases WHERE snippe_reference = $1 LIMIT 1`,
    [ref]
  );
  if (existing.rows.length > 0) {
    const account = await getShopAccount(opts.shopId);
    return { purchase: existing.rows[0], account, duplicate: true };
  }

  const providerCost = Math.round(qty * (Number(settings.provider_cost) || 16));
  const profit = Math.max(0, amount - providerCost);

  const purchase = (
    await pool.query(
      `INSERT INTO sms_purchases
         (shop_id, credits, amount_tzs, price_per_sms, phone_number, snippe_reference, status, paid_at, provider_cost, profit)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW(), $7, $8)
       RETURNING *`,
      [opts.shopId, qty, amount, pricePerSms, null, ref, providerCost, profit]
    )
  ).rows[0];

  await creditSmsAccount(opts.shopId, qty, amount, pricePerSms, note ? `${ref} | ${note}` : ref);
  // Tag the transaction row with the manual reference for audit.
  await pool.query(
    `UPDATE sms_transactions SET snippe_reference = $2 WHERE shop_id = $1 AND reference = $3 AND snippe_reference IS NULL`,
    [opts.shopId, ref, note ? `${ref} | ${note}` : ref]
  );
  await pool.query(
    `INSERT INTO sms_provider_ledger (type, sms_quantity, amount_tzs, cost_per_sms, reference, note)
     VALUES ('spend', $1, $2, $3, $4, $5)`,
    [qty, providerCost, Number(settings.provider_cost) || 16, ref, `Manual grant: ${shopName} (${qty} SMS)${note ? ` — ${note}` : ''}`]
  );

  await notifyOwner(
    opts.shopId,
    'SMS Credited',
    `Umeongezewa SMS ${qty} na admin${amount ? ` (TZS ${amount.toLocaleString()})` : ''}. Salio lako sasa linaonekana kwenye SMS Center.`
  );
  try {
    const ownerPhone = await getOwnerPhone(opts.shopId);
    if (ownerPhone) {
      const acct = await pool.query(`SELECT balance FROM sms_accounts WHERE shop_id = $1`, [opts.shopId]);
      const balance = Number(acct.rows[0]?.balance ?? 0);
      await sendSms(
        normalizePhone(ownerPhone),
        `ALFEAN ENTERPRISES: Umeongezewa SMS ${qty}${amount ? ` (TZS ${amount.toLocaleString()})` : ''}. Salio lako ni SMS ${balance}. Unaweza kutuma sasa. - ALFEAN ENTERPRISES`
      );
    }
  } catch (e: any) {
    console.warn('[SMS] Manual grant confirmation SMS failed:', e.message);
  }

  const account = await getShopAccount(opts.shopId);
  return { purchase, account, duplicate: false };
}

// Complete one stuck purchase (pending/failed) manually: marks it completed
// and credits the shop exactly once (guarded by reference so a double-click or
// a later webhook can never credit twice).
export async function completePurchaseManually(purchaseId: string) {
  const r = await pool.query(`SELECT * FROM sms_purchases WHERE id = $1`, [purchaseId]);
  if (r.rows.length === 0) throw new Error('Purchase not found');
  const purchase = r.rows[0];
  if (purchase.status === 'completed') return { purchase, alreadyCompleted: true };

  const settings = await getResellerSettings();
  const providerCost = Math.round(Number(purchase.credits) * (Number(settings.provider_cost) || 16));
  const profit = Math.max(0, Number(purchase.amount_tzs) - providerCost);

  await pool.query(
    `UPDATE sms_purchases SET status = 'completed', paid_at = NOW(), provider_cost = $2, profit = $3 WHERE id = $1`,
    [purchase.id, providerCost, profit]
  );

  // Credit once: skip when a transaction for this purchase reference exists.
  const already = await pool.query(
    `SELECT 1 FROM sms_transactions
      WHERE shop_id = $1 AND (reference = $2 OR snippe_reference = $2) LIMIT 1`,
    [purchase.shop_id, purchase.snippe_reference]
  );
  if (already.rows.length === 0) {
    await creditSmsAccount(
      purchase.shop_id, Number(purchase.credits),
      Number(purchase.amount_tzs), Number(purchase.price_per_sms),
      purchase.snippe_reference
    );
    await pool.query(
      `UPDATE sms_transactions SET snippe_reference = $2 WHERE shop_id = $1 AND reference = $3 AND snippe_reference IS NULL`,
      [purchase.shop_id, purchase.snippe_reference, purchase.snippe_reference]
    );
    await pool.query(
      `INSERT INTO sms_provider_ledger (type, sms_quantity, amount_tzs, cost_per_sms, reference, note)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE NOT EXISTS (SELECT 1 FROM sms_provider_ledger WHERE reference = $5)`,
      [ 'spend', Number(purchase.credits), providerCost, Number(settings.provider_cost) || 16,
        purchase.snippe_reference, `Manual complete of purchase (${purchase.credits} credits)` ]
    );
  }

  await notifyOwner(purchase.shop_id, 'SMS Purchased', `Umefanikiwa kununua SMS ${purchase.credits} kwa TZS ${Number(purchase.amount_tzs).toLocaleString()}.`);
  try {
    const ownerPhone = await getOwnerPhone(purchase.shop_id);
    if (ownerPhone) {
      const acct = await pool.query(`SELECT balance FROM sms_accounts WHERE shop_id = $1`, [purchase.shop_id]);
      const balance = Number(acct.rows[0]?.balance ?? 0);
      await sendSms(
        normalizePhone(ownerPhone),
        `ALFEAN ENTERPRISES: Malipo yako yamethibitishwa — SMS ${purchase.credits} zimeongezwa. Salio: SMS ${balance}. - ALFEAN ENTERPRISES`
      );
    }
  } catch (e: any) {
    console.warn('[SMS] Manual complete confirmation SMS failed:', e.message);
  }

  const updated = (await pool.query(`SELECT * FROM sms_purchases WHERE id = $1`, [purchaseId])).rows[0];
  return { purchase: updated, alreadyCompleted: false };
}

// ─── BALANCE CORRECTION (developer → shop) ───────────────────────────────────
// Fix an over-grant (e.g. granted 1060 instead of 160): deduct credits or set
// the exact balance. Never drops below 0. Logged as a 'correction'
// transaction so revenue (type='credit' only) is untouched, plus an in-app
// notice to the shop owner for transparency.
export async function adjustSmsBalance(opts: {
  shopId: string;
  mode: 'deduct' | 'set';
  credits?: number | string;
  balance?: number | string;
  reason?: string;
}) {
  if (!opts.shopId) throw new Error('shopId is required');
  const shop = await pool.query(`SELECT id, name FROM shops WHERE id = $1`, [opts.shopId]);
  if (shop.rows.length === 0) throw new Error('Shop not found');

  const account = await getShopAccount(opts.shopId);
  const current = Number(account.balance) || 0;
  let target: number;
  if (opts.mode === 'set') {
    const v = Math.floor(Number(opts.balance));
    if (!Number.isFinite(v) || v < 0) throw new Error('Balance must be 0 or more');
    if (v > 100000) throw new Error('Balance too large (max 100000)');
    target = v;
  } else if (opts.mode === 'deduct') {
    const qty = Math.floor(Number(opts.credits) || 0);
    if (!Number.isFinite(qty) || qty < 1) throw new Error('Credits to deduct must be at least 1');
    target = Math.max(0, current - qty);
  } else {
    throw new Error(`Unknown mode: ${opts.mode}`);
  }

  const delta = target - current;
  const reason = String(opts.reason || '').trim().slice(0, 500) || null;
  const ref = `correction-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (delta === 0) {
    return { account, previousBalance: current, newBalance: current, delta: 0, noop: true };
  }

  const settings = await getResellerSettings();
  await pool.query(
    `UPDATE sms_accounts SET balance = $2, updated_at = NOW() WHERE shop_id = $1`,
    [opts.shopId, target]
  );
  // Reset the low-balance flags so warnings re-fire correctly at the new level.
  await pool.query(
    `UPDATE sms_accounts SET low_balance_notified = false, balance_exhausted_notified = (CASE WHEN $2 = 0 THEN true ELSE false END), updated_at = NOW() WHERE shop_id = $1`,
    [opts.shopId, target]
  );
  await pool.query(
    `INSERT INTO sms_transactions (shop_id, type, credits, amount_tzs, price_per_sms, reference)
     VALUES ($1, 'correction', $2, 0, $3, $4)`,
    [opts.shopId, delta, Number(settings.price_per_sms) || 25, reason ? `${ref} | ${reason}` : ref]
  );

  await notifyOwner(
    opts.shopId,
    'SMS Balance Corrected',
    delta < 0
      ? `Salio lako la SMS limerekebishwa kutoka ${current} hadi ${target} na admin.${reason ? ` Sababu: ${reason}` : ''}`
      : `Salio lako la SMS limerekebishwa kutoka ${current} hadi ${target} na admin.${reason ? ` Sababu: ${reason}` : ''}`
  );

  const updatedAccount = await getShopAccount(opts.shopId);
  return { account: updatedAccount, previousBalance: current, newBalance: target, delta, noop: false };
}

export async function listShopTransactions(shopId: string, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const count = await pool.query(`SELECT COUNT(*) FROM sms_transactions WHERE shop_id = $1`, [shopId]);
  const rows = await pool.query(
    `SELECT * FROM sms_transactions WHERE shop_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [shopId, limit, offset]
  );
  const total = parseInt(count.rows[0].count);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// ─── AUTO SMS ON SALE ────────────────────────────────────────────────────────

export async function handleAutoSmsOnSale(opts: {
  shopId: string;
  customerPhone?: string;
  customerName?: string;
  totalAmount?: number;
  items?: Array<{ name: string; quantity?: number; totalPrice?: number; unitPrice?: number }>;
}) {
  try {
    const { shopId, customerPhone, customerName, totalAmount } = opts;
    if (!customerPhone) return;
    const settings = await getShopSmsSettings(shopId);
    if (!settings.auto_sms_on_sale) return;

    const [reseller, shop, account] = await Promise.all([
      getResellerSettings(),
      pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]),
      getShopAccount(shopId),
    ]);
    if (reseller.sms_enabled === false && reseller.enabled === false) return;
    if (Number(account.balance) < 1) {
      await checkLowBalance(shopId);
      return;
    }

    const sender = await resolveSystemSmsSender(shopId);
    if (!sender?.provider_id) return;

    const shopName = shop.rows[0]?.name || 'Duka';
    const template = settings.auto_sms_message || DEFAULT_SHOP_SMS_SETTINGS.auto_sms_message;
    let itemsText = '';
    if (settings.sale_include_items !== false && Array.isArray(opts.items) && opts.items.length > 0) {
      itemsText = opts.items
        .slice(0, 10)
        .map((it) => `${it.name}${Number(it.quantity) > 1 ? ` x${it.quantity}` : ''}`)
        .join(', ');
    }
    const message = (template || '')
      .replaceAll('{customer_name}', customerName || 'Mteja')
      .replaceAll('{total}', (Number(totalAmount) || 0).toLocaleString())
      .replaceAll('{shop_name}', shopName)
      .replaceAll('{items}', itemsText || 'bidhaa zako');

    await sendUserSms({ shopId, phone: customerPhone, message, senderIdRow: sender, source: 'sale' });
  } catch (e: any) {
    console.warn('[SMS] Auto SMS on sale skipped:', e.message);
  }
}

// ─── AUTO SMS: NEW PRODUCT ───────────────────────────────────────────────────

export async function handleNewProductSms(opts: { shopId: string; productName: string }) {
  try {
    const { shopId, productName } = opts;
    if (!productName) return;
    const settings = await getShopSmsSettings(shopId);
    if (!settings.new_product_enabled) return;

    const [reseller, shop, account] = await Promise.all([
      getResellerSettings(),
      pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]),
      getShopAccount(shopId),
    ]);
    if (reseller.sms_enabled === false && reseller.enabled === false) return;
    if (Number(account.balance) < 1) {
      await checkLowBalance(shopId);
      return;
    }

    const sender = await resolveSystemSmsSender(shopId);
    if (!sender?.provider_id) return;

    // Recipients: everyone in the shop's SMS contact list with a phone number.
    const contacts = await pool.query(
      `SELECT DISTINCT phone FROM sms_contacts WHERE shop_id = $1 AND phone IS NOT NULL`,
      [shopId]
    );
    const phones = contacts.rows.map((r: any) => r.phone);
    if (phones.length === 0) return;

    const shopName = shop.rows[0]?.name || 'Duka';
    const template = settings.new_product_message || DEFAULT_SHOP_SMS_SETTINGS.new_product_message;
    const message = (template || '')
      .replaceAll('{product_name}', productName)
      .replaceAll('{shop_name}', shopName);

    await sendUserBulkSms({ shopId, recipients: phones, message, senderIdRow: sender, source: 'new_product' });
  } catch (e: any) {
    console.warn('[SMS] Auto SMS new product skipped:', e.message);
  }
}

// ─── AUTO SMS: DEBT REMINDERS (scheduled) ────────────────────────────────────

export async function runDebtReminderJob() {
  const shops = await pool.query(`SELECT id FROM shops`);
  let totalSent = 0;
  for (const row of shops.rows) {
    const shopId = row.id;
    try {
      const settings = await getShopSmsSettings(shopId);
      if (!settings.debt_reminder_enabled) continue;
      if (!(await ensureSmsBundleForAutomation(shopId))) continue;
      const days = Math.max(1, Number(settings.debt_reminder_days) || 7);

      // Debtors whose due date is >= N days ago and still unpaid/partial.
      const debtors = await pool.query(
        `SELECT id, customer_name, customer_phone, total_amount, paid_amount, due_date, created_at
         FROM debtors
         WHERE shop_id = $1
           AND status IN ('unpaid', 'partial')
           AND customer_phone IS NOT NULL
           AND (due_date IS NULL OR due_date <= NOW() - ($2 || ' days')::interval)
           AND created_at <= NOW() - ($2 || ' days')::interval
           AND NOT EXISTS (
             SELECT 1 FROM sms_messages sm
             WHERE sm.shop_id = $1
               AND sm.recipient = customer_phone
               AND sm.source = 'debt_reminder'
               AND sm.created_at > COALESCE(debtors.due_date, debtors.created_at)
           )
         LIMIT 100`,
        [shopId, days]
      );
      if (debtors.rows.length === 0) continue;

      const [reseller, shop, sender] = await Promise.all([
        getResellerSettings(),
        pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]),
        resolveSystemSmsSender(shopId),
      ]);
      if (!sender?.provider_id) continue;
      const shopName = shop.rows[0]?.name || 'Duka';
      const template = settings.debt_reminder_message || DEFAULT_SHOP_SMS_SETTINGS.debt_reminder_message;

      for (const d of debtors.rows) {
        const amount = Number(d.total_amount || 0) - Number(d.paid_amount || 0);
        const message = (template || '')
          .replaceAll('{customer_name}', d.customer_name || 'Mteja')
          .replaceAll('{amount}', amount.toLocaleString())
          .replaceAll('{due_date}', d.due_date ? new Date(d.due_date).toLocaleDateString('en-GB') : '')
          .replaceAll('{shop_name}', shopName);
        await sendUserSms({ shopId, phone: d.customer_phone, message, senderIdRow: sender, source: 'debt_reminder' });
        totalSent++;
      }
    } catch (e: any) {
      console.warn(`[SMS] Debt reminder skipped for shop ${shopId}:`, e.message);
    }
  }
  return { totalSent };
}

// ─── AUTO SMS: INVOICE REMINDERS (scheduled) ─────────────────────────────────

export async function runInvoiceReminderJob() {
  const shops = await pool.query(`SELECT id FROM shops`);
  let totalSent = 0;
  for (const row of shops.rows) {
    const shopId = row.id;
    try {
      const settings = await getShopSmsSettings(shopId);
      if (!settings.invoice_reminder_enabled) continue;
      if (!(await ensureSmsBundleForAutomation(shopId))) continue;
      const days = Math.max(1, Number(settings.invoice_reminder_days) || 7);

      const invoices = await pool.query(
        `SELECT id, customer_name, customer_phone, total_amount, amount_paid, created_at
         FROM sales
         WHERE shop_id = $1
           AND sale_type = 'invoice'
           AND payment_status IN ('unpaid', 'partial')
           AND customer_phone IS NOT NULL
           AND created_at <= NOW() - ($2 || ' days')::interval
           AND NOT EXISTS (
             SELECT 1 FROM sms_messages sm
             WHERE sm.shop_id = $1
               AND sm.recipient = sales.customer_phone
               AND sm.source = 'invoice_reminder'
               AND sm.created_at > sales.created_at
           )
         LIMIT 100`,
        [shopId, days]
      );
      if (invoices.rows.length === 0) continue;

      const [reseller, shop, sender] = await Promise.all([
        getResellerSettings(),
        pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]),
        resolveSystemSmsSender(shopId),
      ]);
      if (!sender?.provider_id) continue;
      const shopName = shop.rows[0]?.name || 'Duka';
      const template = settings.invoice_reminder_message || DEFAULT_SHOP_SMS_SETTINGS.invoice_reminder_message;

      for (const inv of invoices.rows) {
        const amount = Number(inv.total_amount || 0) - Number(inv.amount_paid || 0);
        const message = (template || '')
          .replaceAll('{customer_name}', inv.customer_name || 'Mteja')
          .replaceAll('{amount}', amount.toLocaleString())
          .replaceAll('{invoice_date}', new Date(inv.created_at).toLocaleDateString('en-GB'))
          .replaceAll('{shop_name}', shopName);
        await sendUserSms({ shopId, phone: inv.customer_phone, message, senderIdRow: sender, source: 'invoice_reminder' });
        totalSent++;
      }
    } catch (e: any) {
      console.warn(`[SMS] Invoice reminder skipped for shop ${shopId}:`, e.message);
    }
  }
  return { totalSent };
}

// ─── AUTO SMS: PER-SALE NOTICE TO OWNER ──────────────────────────────────────

export async function handleAdminSaleSmsOnSale(opts: {
  shopId: string;
  totalAmount?: number;
  sellerName?: string;
  customerName?: string;
  items?: Array<{ name: string; quantity?: number; totalPrice?: number }>;
}) {
  try {
    const { shopId, totalAmount, sellerName, customerName } = opts;
    const settings = await getShopSmsSettings(shopId);
    if (!settings.admin_sale_sms_enabled) return;

    const [reseller, shop, account, ownerPhone] = await Promise.all([
      getResellerSettings(),
      pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]),
      getShopAccount(shopId),
      getOwnerPhone(shopId),
    ]);
    if (reseller.sms_enabled === false && reseller.enabled === false) return;
    if (!ownerPhone) return;
    if (Number(account.balance) < 1) {
      await checkLowBalance(shopId);
      return;
    }

    const sender = await resolveSystemSmsSender(shopId);
    if (!sender?.provider_id) return;

    const shopName = shop.rows[0]?.name || 'Duka';
    const template = settings.admin_sale_sms_message || DEFAULT_SHOP_SMS_SETTINGS.admin_sale_sms_message;
    let itemsText = '';
    if (Array.isArray(opts.items) && opts.items.length > 0) {
      itemsText = opts.items
        .slice(0, 5)
        .map((it) => `${it.name}${Number(it.quantity) > 1 ? ` x${it.quantity}` : ''}`)
        .join(', ');
    }
    const message = (template || '')
      .replaceAll('{shop_name}', shopName)
      .replaceAll('{total}', (Number(totalAmount) || 0).toLocaleString())
      .replaceAll('{seller_name}', sellerName || 'Muuzaji')
      .replaceAll('{customer_name}', customerName || 'Mteja')
      .replaceAll('{items}', itemsText || 'Mauzo mapya');

    await sendUserSms({ shopId, phone: ownerPhone, message, senderIdRow: sender, source: 'admin_sale' });
  } catch (e: any) {
    console.warn('[SMS] Admin per-sale SMS skipped:', e.message);
  }
}

// ─── AUTO SMS: DAILY SALES SUMMARY (scheduled, aggregates all owner shops) ────

export async function runDailySalesSummaryJob() {
  // Shops that have opted into the daily summary.
  const shops = await pool.query(`SELECT id FROM shops`);
  const owners = new Map<string, { phone: string; shopId: string; time: string; message: string }>();

  for (const row of shops.rows) {
    const shopId = row.id;
    try {
      const settings = await getShopSmsSettings(shopId);
      if (!settings.daily_summary_enabled) continue;
      if (!(await ensureSmsBundleForAutomation(shopId))) continue;
      const phone = await getOwnerPhone(shopId);
      if (!phone) continue;
      if (!owners.has(phone)) {
        owners.set(phone, {
          phone,
          shopId,
          time: settings.daily_summary_time || DEFAULT_SHOP_SMS_SETTINGS.daily_summary_time,
          message: settings.daily_summary_message || DEFAULT_SHOP_SMS_SETTINGS.daily_summary_message,
        });
      }
    } catch (e: any) {
      console.warn(`[SMS] Daily summary scan skipped for shop ${shopId}:`, e.message);
    }
  }

  let totalSent = 0;
  const now = new Date();
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toISOString().slice(0, 10);

  for (const owner of owners.values()) {
    try {
      // Only send at/after the configured daily summary time (e.g. when shops close).
      if (nowHHMM < (owner.time || '20:00')) continue;

      // Already sent today? Dedupe by recipient + source for today.
      const dup = await pool.query(
        `SELECT 1 FROM sms_messages WHERE recipient = $1 AND source = 'daily_summary' AND created_at::date = CURRENT_DATE LIMIT 1`,
        [normalizePhone(owner.phone)]
      );
      if (dup.rows.length > 0) continue;

      // All shops belonging to this owner (tenant).
      const shopsOfOwner = await pool.query(
        `SELECT s.id, s.name, t.tenant_id
         FROM shops s JOIN (
           SELECT tenant_id FROM shops WHERE id = $1
         ) t ON t.tenant_id = s.tenant_id`,
        [owner.shopId]
      );

      let totalSales = 0;
      let totalProfit = 0;
      let totalExpenses = 0;
      let totalOrders = 0;
      const shopLines: string[] = [];

      for (const shop of shopsOfOwner.rows) {
        const [salesRes, profitRes, expensesRes, ordersRes, sellerRes] = await Promise.all([
          pool.query(`SELECT COALESCE(SUM(total_amount), 0) as sales FROM sales WHERE shop_id = $1 AND created_at::date = CURRENT_DATE`, [shop.id]),
          pool.query(`SELECT COALESCE(SUM(si.profit), 0) as profit FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE s.shop_id = $1 AND s.created_at::date = CURRENT_DATE`, [shop.id]),
          pool.query(`SELECT COALESCE(SUM(amount), 0) as expenses FROM expenses WHERE shop_id = $1 AND date = CURRENT_DATE`, [shop.id]),
          pool.query(`SELECT COUNT(*) as orders FROM sales WHERE shop_id = $1 AND created_at::date = CURRENT_DATE`, [shop.id]),
          pool.query(`SELECT u.name as seller_name FROM sales s JOIN "user" u ON u.id = s.seller_id WHERE s.shop_id = $1 AND s.created_at::date = CURRENT_DATE GROUP BY u.name ORDER BY SUM(s.total_amount) DESC LIMIT 1`, [shop.id]),
        ]);
        const sales = parseFloat(salesRes.rows[0].sales);
        const profit = parseFloat(profitRes.rows[0].profit);
        const expenses = parseFloat(expensesRes.rows[0].expenses);
        const orders = parseInt(ordersRes.rows[0].orders);
        const seller = sellerRes.rows[0]?.seller_name || '';

        totalSales += sales;
        totalProfit += profit;
        totalExpenses += expenses;
        totalOrders += orders;
        shopLines.push(
          `${shop.name || 'Duka'} - mauzo ya leo yalikuwa ${sales.toLocaleString()}, faida ni sh ${profit.toLocaleString()}, matumizi sh ${expenses.toLocaleString()}, oda zilikuwa ${orders}${seller ? `, muuzaji ${seller}` : ''}`
        );
      }

      if (shopLines.length === 0) continue;

      const message = (owner.message || '')
        .replaceAll('{date}', today)
        .replaceAll('{shops}', shopLines.join('\n'))
        .replaceAll('{total_sales}', totalSales.toLocaleString())
        .replaceAll('{total_profit}', totalProfit.toLocaleString())
        .replaceAll('{total_expenses}', totalExpenses.toLocaleString())
        .replaceAll('{total_orders}', String(totalOrders));

      // Same sender rule as every other shop SMS: the shop's own approved
      // (admin/shop) sender when it has one, otherwise the ALFEAN ENTERPRISES POS system
      // sender. Credits always come from THIS shop's balance.
      const sender = await resolveSystemSmsSender(owner.shopId);
      if (!sender?.provider_id) continue;

      await sendUserSms({ shopId: owner.shopId, phone: owner.phone, message, senderIdRow: sender, source: 'daily_summary' });
      totalSent++;
    } catch (e: any) {
      console.warn('[SMS] Daily summary skipped:', e.message);
    }
  }
  return { totalSent };
}

// ─── AUTO SMS: LOW STOCK ALERT TO OWNER (scheduled) ─────────────────────────

export async function runLowStockAlertJob() {
  const shops = await pool.query(`SELECT id FROM shops`);
  let totalSent = 0;
  for (const row of shops.rows) {
    const shopId = row.id;
    try {
      const settings = await getShopSmsSettings(shopId);
      if (!settings.low_stock_alert_enabled) continue;
      if (!(await ensureSmsBundleForAutomation(shopId))) continue;

      const lowStock = await pool.query(
        `SELECT name, current_stock, low_stock_threshold
         FROM products
         WHERE shop_id = $1 AND is_active = true
           AND current_stock <= COALESCE(low_stock_threshold, 10)
         ORDER BY current_stock ASC
         LIMIT 10`,
        [shopId]
      );
      if (lowStock.rows.length === 0) continue;

      // Already alerted the owner today? Dedupe by recipient + source for today.
      const ownerPhone = await getOwnerPhone(shopId);
      if (!ownerPhone) continue;
      const dup = await pool.query(
        `SELECT 1 FROM sms_messages WHERE recipient = $1 AND source = 'low_stock_alert' AND created_at::date = CURRENT_DATE LIMIT 1`,
        [normalizePhone(ownerPhone)]
      );
      if (dup.rows.length > 0) continue;

      const [reseller, shop, sender] = await Promise.all([
        getResellerSettings(),
        pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]),
        resolveSystemSmsSender(shopId),
      ]);
      if (!sender?.provider_id) continue;
      const shopName = shop.rows[0]?.name || 'Duka';

      const productsText = lowStock.rows
        .map((p: any) => `${p.name} (${p.current_stock}/${p.low_stock_threshold || 10})`)
        .join(', ');

      const template = settings.low_stock_alert_message || DEFAULT_SHOP_SMS_SETTINGS.low_stock_alert_message;
      const message = (template || '')
        .replaceAll('{products}', productsText)
        .replaceAll('{shop_name}', shopName);

      await sendUserSms({ shopId, phone: ownerPhone, message, senderIdRow: sender, source: 'low_stock_alert' });
      totalSent++;
    } catch (e: any) {
      console.warn(`[SMS] Low stock alert skipped for shop ${shopId}:`, e.message);
    }
  }
  return { totalSent };
}

// ─── AI GENERATOR ────────────────────────────────────────────────────────────

export async function generateMarketingSms(opts: { topic?: string; businessName?: string; message?: string; language?: string }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const language = opts.language === 'en' ? 'English' : 'Swahili';
  const prompt = opts.message
    ? `Rewrite/improve this SMS to be under 160 characters in ${language}, sweet, attractive and professional: "${opts.message}". Include a call to action. Return ONLY JSON: {"message":"..."}`
    : `Generate a sweet, attractive marketing SMS in ${language} for ${opts.businessName || 'the business'}${opts.topic ? ` about ${opts.topic}` : ''}. Max 160 characters. Include a call to action. Return ONLY JSON: {"message":"..."}`;

  if (!apiKey) {
    return { message: opts.message || `Habari mteja! Pata ofa na habari muhimu za ${opts.businessName || 'duka letu'} leo. Wasiliana nasi! - ${opts.businessName || 'ALFEAN ENTERPRISES'}` };
  }

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `You are a marketing copywriter in Tanzania. Generate short ${language} SMS under 160 chars. Return ONLY JSON.` },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.8,
      }),
    });
    if (!response.ok) return { message: opts.message || '' };
    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return { message: parsed.message || '' };
  } catch {
    return { message: opts.message || '' };
  }
}

// ─── DEVELOPER OVERVIEW ──────────────────────────────────────────────────────

export async function getDeveloperOverview() {
  const settings = await getResellerSettings();

  const credits = await pool.query(`
    SELECT
      COALESCE(SUM(balance), 0)::int as total_balance,
      COALESCE(SUM(total_bought), 0)::int as total_bought,
      COALESCE(SUM(total_sent), 0)::int as total_sent
    FROM sms_accounts
  `);
  const revenue = await pool.query(`
    SELECT COALESCE(SUM(amount_tzs), 0)::int as revenue,
           COALESCE(SUM(credits), 0)::int as credits_sold,
           COALESCE(SUM(credits) FILTER (WHERE COALESCE(amount_tzs, 0) > 0), 0)::int as credits_paid,
           COALESCE(SUM(credits) FILTER (WHERE COALESCE(amount_tzs, 0) = 0), 0)::int as credits_free
    FROM sms_transactions WHERE type = 'credit' AND status = 'completed'
  `);
  const shopsWithBalance = await pool.query(`SELECT COUNT(*) FROM sms_accounts WHERE balance > 0`);
  const pendingSenderIds = await pool.query(
    `SELECT s.id, s.sender_id, s.purpose, s.status, s.created_at, s.applied_by, s.applied_email, s.applied_phone,
            s.rejection_notify_sent, s.rejection_notified_at,
            s.approval_notify_sent, s.approval_notified_at, s.approval_notify_count,
            sh.name as shop_name, u.email as applicant_email,
            u.phone as applicant_phone, u.first_name, u.last_name
     FROM sms_sender_ids s JOIN shops sh ON sh.id = s.shop_id
     LEFT JOIN "user" u ON u.id = s.applied_by
     WHERE s.status IN ('pending','submitted') AND s.is_system = false
     ORDER BY s.created_at ASC`
  );
  const recentSenderIds = await pool.query(
    `SELECT s.id, s.sender_id, s.purpose, s.status, s.created_at, s.applied_by, s.applied_email, s.applied_phone,
            s.rejection_notify_sent, s.rejection_notified_at,
            s.approval_notify_sent, s.approval_notified_at, s.approval_notify_count,
            sh.name as shop_name, u.email as applicant_email,
            u.phone as applicant_phone, u.first_name, u.last_name
     FROM sms_sender_ids s JOIN shops sh ON sh.id = s.shop_id
     LEFT JOIN "user" u ON u.id = s.applied_by
     WHERE s.is_system = false
     ORDER BY s.created_at DESC LIMIT 25`
  );
  const recentPurchases = await pool.query(
    `SELECT p.*, sh.name as shop_name FROM sms_purchases p
     JOIN shops sh ON sh.id = p.shop_id
     ORDER BY p.created_at DESC LIMIT 20`
  );
  const transactions = await pool.query(
    `SELECT t.*, sh.name as shop_name FROM sms_transactions t
     JOIN shops sh ON sh.id = t.shop_id
     WHERE t.type = 'credit'
     ORDER BY t.created_at DESC LIMIT 20`
  );

  let providerBalance: number | null = null;
  try {
    providerBalance = await ehub.getWalletBalance();
  } catch { providerBalance = null; }

  const totalSent = parseInt(credits.rows[0].total_sent) || 0;
  const revenueTzs = parseInt(revenue.rows[0].revenue) || 0;
  // Provider cost/profit from the double-entry ledger (real per-purchase 16/9 split)
  const providerLedger = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'spend' THEN amount_tzs ELSE 0 END), 0) as spend,
            COALESCE(SUM(CASE WHEN type = 'spend' THEN sms_quantity ELSE 0 END), 0) as sms_sold
     FROM sms_provider_ledger`
  );
  const providerSpend = parseInt(providerLedger.rows[0].spend) || 0;
  const profit = revenueTzs - providerSpend;
  const providerWallet = await getProviderWalletStatus();

  // ── Clear profit picture ──────────────────────────────────────────────────
  // "Profit" used to compare money collected against the cost of ALL credits
  // ever issued, which looks like a loss while shops still hold unsold SMS.
  // Split it into the numbers a reseller actually checks:
  const totalBalance = parseInt(credits.rows[0].total_balance) || 0;
  const pricePerSms = Number(settings.price_per_sms) || 0;
  const costPerSms = Number(settings.provider_cost) || 0;
  const marginPerSms = pricePerSms - costPerSms;
  // Margin actually EARNED on SMS already sent (the true realized profit).
  const grossProfitOnSent = totalSent * marginPerSms;
  // Cash: collected from shops − provider cost of credits issued.
  const netCash = revenueTzs - providerSpend;
  // Unsold value still owned by the reseller: credits in shop balances +
  // provider float. Cost value is what was paid for them; the shop balances
  // will earn marginPerSms each when they are used.
  const providerFloatSms = Number(providerWallet?.sms_balance) || 0;
  const shopBalanceCost = totalBalance * costPerSms;
  const shopBalanceSell = totalBalance * pricePerSms;
  const floatCost = providerFloatSms * costPerSms;
  const stockCost = shopBalanceCost + floatCost;
  const netPosition = netCash + stockCost;
  const potentialProfitOnBalances = totalBalance * marginPerSms;

  return {
    settings,
    stats: {
      totalBalance,
      totalBought: parseInt(credits.rows[0].total_bought) || 0,
      totalSent,
      revenueTzs,
      creditsSold: parseInt(revenue.rows[0].credits_sold) || 0,
      creditsPaid: parseInt(revenue.rows[0].credits_paid) || 0,
      creditsFree: parseInt(revenue.rows[0].credits_free) || 0,
      providerSpend,
      profit,
      // Clear-profit fields (see comments above)
      pricePerSms,
      costPerSms,
      marginPerSms,
      grossProfitOnSent,
      netCash,
      providerFloatSms,
      shopBalanceCost,
      shopBalanceSell,
      floatCost,
      stockCost,
      netPosition,
      potentialProfitOnBalances,
      smsSoldLedger: parseInt(providerLedger.rows[0].sms_sold) || 0,
      shopsWithBalance: parseInt(shopsWithBalance.rows[0].count) || 0,
      providerBalance,
    },
    providerWallet,
    pendingSenderIds: pendingSenderIds.rows,
    recentSenderIds: recentSenderIds.rows,
    recentPurchases: recentPurchases.rows,
    transactions: transactions.rows,
    providerStatus: ehub.ehubStatus(),
  };
}

// ─── PROVIDER FLOAT / WALLET MONITORING ──────────────────────────────────────

const PROVIDER_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours between alerts

export interface ProviderWalletStatus {
  sms_balance: number;
  tzs_balance: number;
  threshold_tzs: number;
  low: boolean;
  critical: boolean;
  reachable: boolean;
  cost_per_sms: number;
}

export interface ProviderWalletCheckResult extends ProviderWalletStatus {
  alerted: boolean;
  suppressed?: boolean;
  smsSent?: number;
  emailSent?: number;
  phone?: boolean;
  email?: boolean;
}

// Live provider float status (eHub wallet) converted to TZS using provider cost.
export async function getProviderWalletStatus(): Promise<ProviderWalletStatus> {
  const settings = await getResellerSettings();
  let smsBalance = 0;
  let reachable = true;
  try {
    smsBalance = await ehub.getWalletBalance();
  } catch { reachable = false; }

  const thresholdTzs = Number(settings.provider_low_balance_tzs) || 20000;
  const costPerSms = Number(settings.provider_cost) || 16;
  const tzsBalance = Math.round(smsBalance * costPerSms);

  return {
    sms_balance: smsBalance,
    tzs_balance: tzsBalance,
    threshold_tzs: thresholdTzs,
    low: reachable && tzsBalance > 0 && tzsBalance < thresholdTzs,
    critical: reachable && tzsBalance <= 0,
    reachable,
    cost_per_sms: costPerSms,
  };
}

// Alert the developer by SMS + email when the provider float drops below the
// threshold (default TZS 20,000). No auto-top-up / no STK push. Cooldown 12h.
export async function checkProviderWalletAndAlert(): Promise<ProviderWalletCheckResult> {
  const settings = await getResellerSettings();
  const status = await getProviderWalletStatus();

  if (!status.low) {
    // Float recovered (or provider unreachable) — clear the cooldown so the
    // next drop re-alerts.
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('sms_provider_low_notified_at', to_jsonb(''::text))
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb(''::text)`
    );
    return { alerted: false, ...status };
  }

  const last = await pool.query(
    `SELECT value FROM system_settings WHERE key = 'sms_provider_low_notified_at'`
  );
  const lastVal = last.rows[0]?.value;
  if (lastVal) {
    const dt = new Date(lastVal);
    if (!isNaN(dt.getTime()) && Date.now() - dt.getTime() < PROVIDER_ALERT_COOLDOWN_MS) {
      return { alerted: false, suppressed: true, ...status };
    }
  }

  // Alert contacts: explicit settings override, else the first developer user.
  let phone = settings.provider_alert_phone || '';
  let email = settings.provider_alert_email || '';
  if (!phone || !email) {
    const dev = await pool.query(
      `SELECT phone, email FROM "user" WHERE role = 'developer' AND (phone IS NOT NULL OR email IS NOT NULL)
       ORDER BY created_at ASC LIMIT 1`
    );
    if (dev.rows[0]) {
      phone = phone || dev.rows[0].phone || '';
      email = email || dev.rows[0].email || '';
    }
  }

  const tzsFmt = status.tzs_balance.toLocaleString();
  const thresholdFmt = status.threshold_tzs.toLocaleString();
  const subject = `ALFEAN ENTERPRISES SMS Wallet Low - TZS ${tzsFmt}`;
  const smsMsg = `ALFEAN ENTERPRISES: SMS wallet low! Balance TZS ${tzsFmt} (${status.sms_balance} SMS). Top up above TZS ${thresholdFmt} before it runs out.`;
  const emailHtml = `
    <h2 style="color:#b45309; margin:0 0 16px;">SMS Provider Wallet Low</h2>
    <p style="font-size:15px; color:#374151; line-height:1.6;">Your eHub SMS wallet is running low. Top it up before SMS sending stops.</p>
    <table style="background:#fef3c7; border-radius:8px; padding:16px; margin:16px 0; width:100%;">
      <tr><td style="padding:4px 0; font-size:14px; color:#92400e;">Current balance</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#92400e;">TZS ${tzsFmt} (${status.sms_balance} SMS)</td></tr>
      <tr><td style="padding:4px 0; font-size:14px; color:#92400e;">Top up above</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#92400e;">TZS ${thresholdFmt}</td></tr>
    </table>
    <p style="font-size:14px; color:#6b7280; line-height:1.5;">Log in to the developer dashboard &rarr; SMS Reseller Control &rarr; Top Up Provider Wallet to add more SMS.</p>
  `;

  let smsSent = 0;
  let emailSent = 0;
  if (phone) {
    try {
      const r = await sendSms(normalizePhone(phone), smsMsg, undefined);
      if (r.success) smsSent++;
    } catch { /* alert SMS failure is non-fatal */ }
  }
  if (email) {
    try {
      const r = await sendEmail({ to: email, subject, html: emailHtml, name: 'Developer' });
      if (r.success) emailSent++;
    } catch { /* alert email failure is non-fatal */ }
  }

  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('sms_provider_low_notified_at', to_jsonb($1::text))
     ON CONFLICT (key) DO UPDATE SET value = to_jsonb($1::text)`,
    [new Date().toISOString()]
  );

  return { alerted: true, smsSent, emailSent, phone: !!phone, email: !!email, ...status };
}

// ─── DEVELOPER SENDER ID TRACKING ──────────────────────────────────

export async function getAllSenderIds(page = 1, limit = 50, status?: string) {
  const offset = (page - 1) * limit;
  const where: string[] = [`s.is_system = false`];
  const params: any[] = [];
  if (status) {
    params.push(status);
    where.push(`s.status = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const count = await pool.query(`SELECT COUNT(*) FROM sms_sender_ids s ${whereSql}`, params);
  const rows = await pool.query(
    `SELECT s.*, sh.name as shop_name, u.email as applicant_email, u.phone as applicant_phone, u.first_name, u.last_name
     FROM sms_sender_ids s
     JOIN shops sh ON sh.id = s.shop_id
     LEFT JOIN "user" u ON u.id = s.applied_by
     ${whereSql}
     ORDER BY s.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const total = parseInt(count.rows[0].count);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// Per-sender-ID message counts for the developer registry: today, this week
// (Monday → today) and this month (1st → today), plus all-time. Calendar
// boundaries are Tanzania time (EAT): the DB stores UTC wall-clock timestamps
// in the standard UTC container, so +3h gives EAT wall-clock to compare.
// Only messages that actually left ALFEAN ENTERPRISES count — failed ones are excluded
// (queued messages were paid for and will flush, so they count).
export async function getSenderIdUsageStats() {
  const r = await pool.query(`
    SELECT
      UPPER(TRIM(m.sender_id)) AS sender,
      COUNT(*) FILTER (
        WHERE (m.created_at + INTERVAL '3 hours')::date = (NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')::date
      )::int AS today,
      COUNT(*) FILTER (
        WHERE (m.created_at + INTERVAL '3 hours') >= date_trunc('week', NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')
      )::int AS week,
      COUNT(*) FILTER (
        WHERE (m.created_at + INTERVAL '3 hours') >= date_trunc('month', NOW() AT TIME ZONE 'Africa/Dar_es_Salaam')
      )::int AS month,
      COUNT(*)::int AS total,
      COALESCE(SUM(m.credits), 0)::int AS credits_total,
      MAX(m.created_at) AS last_sent_at
    FROM sms_messages m
    WHERE m.sender_id IS NOT NULL AND m.sender_id <> '' AND m.status <> 'failed'
    GROUP BY UPPER(TRIM(m.sender_id))
    ORDER BY month DESC, total DESC
  `);
  return r.rows;
}

export async function getSenderIdById(id: string) {
  const r = await pool.query(
    `SELECT s.*, sh.name as shop_name, sh.id as shop_id, sh.email as shop_email, sh.phone as shop_phone,
            u.email as applicant_email, u.phone as applicant_phone, u.first_name, u.last_name
     FROM sms_sender_ids s
     JOIN shops sh ON sh.id = s.shop_id
     LEFT JOIN "user" u ON u.id = s.applied_by
     WHERE s.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

// ─── DEVELOPER: LINK PROVIDER SENDER IDS TO SHOPS ────────────────────────────
// Sender IDs registered directly in the eHub dashboard (or approved before ALFEAN ENTERPRISES
// tracked them) have no ALFEAN ENTERPRISES row, so the shop that owns them sees "no sender ID"
// in the SMS Center. These helpers let the developer link any provider sender
// to a shop; the shop then sees it, can set it as default, and can choose it
// when sending manually.

function normalizeSenderName(name: any): string {
  return String(name || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11);
}

// A sender ID may belong to exactly ONE shop. Returns the OTHER shop that
// already owns this provider sender (by provider UUID or by name), or null.
// Used to block cross-shop linking from every path — the developer tool AND
// the automatic "name already exists on eHub" linking.
async function findCrossShopSenderOwner(opts: {
  shopId: string;
  senderId?: string | null;
  providerId?: string | null;
  excludeRowId?: string | null;
}): Promise<{ id: string; shop_id: string; sender_id: string; shop_name: string } | null> {
  const name = normalizeSenderName(opts.senderId);
  const params: any[] = [opts.shopId];
  const ors: string[] = [];
  if (opts.providerId) {
    params.push(String(opts.providerId));
    ors.push(`s.provider_id = $${params.length}`);
  }
  if (name) {
    params.push(name);
    ors.push(`UPPER(s.sender_id) = $${params.length}`);
  }
  if (!ors.length) return null;

  let excludeSql = '';
  if (opts.excludeRowId) {
    params.push(opts.excludeRowId);
    excludeSql = `AND s.id <> $${params.length}`;
  }

  const r = await pool.query(
    `SELECT s.id, s.shop_id, s.sender_id, sh.name as shop_name
     FROM sms_sender_ids s
     JOIN shops sh ON sh.id = s.shop_id
     WHERE s.shop_id <> $1 AND s.is_system = false
       AND (${ors.join(' OR ')})
       ${excludeSql}
     LIMIT 1`,
    params
  );
  return r.rows[0] || null;
}

// Every sender ID on the provider account with its ALFEAN ENTERPRISES linkage (matched by
// provider_id first, then by normalized name).
export async function getProviderSenderLinks() {
  let providerSenders: any[] = [];
  try {
    providerSenders = await ehub.getSenderIds();
  } catch (e: any) {
    return { provider: [], error: e.message || 'Provider unreachable' };
  }
  const rows = (
    await pool.query(
      `SELECT s.id as row_id, s.sender_id, s.provider_id, s.shop_id, s.status as local_status, s.is_default,
              s.is_system, sh.name as shop_name
       FROM sms_sender_ids s JOIN shops sh ON sh.id = s.shop_id
       WHERE s.is_system = false`
    )
  ).rows;

  const provider = providerSenders.map((p: any) => {
    const name = normalizeSenderName(p.sender_id || p.senderId || p.name);
    const pid = p.id || p.uuid || null;
    const row = rows.find(
      (r: any) => (pid && r.provider_id && String(r.provider_id) === String(pid)) ||
                  normalizeSenderName(r.sender_id) === name
    );
    return {
      provider_id: pid,
      sender_id: name,
      provider_status: String(p.status || '').toLowerCase() || null,
      purpose: p.purpose || null,
      linked_row_id: row?.row_id || null,
      linked_shop_id: row?.shop_id || null,
      linked_shop_name: row?.shop_name || null,
      linked_status: row?.local_status || null,
      linked_is_default: row?.is_default === true,
    };
  }).filter((p: any) => p.sender_id);

  return { provider };
}

// Link a provider sender ID to a shop as an approved sender (developer action).
// Reuses the shop's existing row for the same name when present — e.g. a
// rejected application whose name is now approved by eHub — so no duplicate
// rows are created and the shop immediately sees it.
export async function linkProviderSenderToShop(opts: {
  shopId: string;
  senderId: string;
  providerId?: string | null;
  purpose?: string | null;
  status?: 'approved' | 'pending';
}) {
  const name = normalizeSenderName(opts.senderId);
  if (!name || name.length < 4) throw new Error('Sender ID name is required (min 4 characters)');
  const shopId = String(opts.shopId || '');
  if (!shopId) throw new Error('Shop is required');
  await assertShopExists(shopId, true);
  const status = opts.status === 'pending' ? 'pending' : 'approved';

  // ISOLATION: a provider sender ID belongs to exactly ONE shop. Another shop
  // can never see or use it; block the link (by provider UUID or by name) and
  // tell the developer who owns it.
  const otherOwner = await findCrossShopSenderOwner({ shopId, senderId: name, providerId: opts.providerId || null });
  if (otherOwner) {
    throw new Error(`Sender ID ${name} is already linked to ${otherOwner.shop_name}. Unlink it there first.`);
  }

  const existing = await pool.query(
    `SELECT * FROM sms_sender_ids WHERE shop_id = $1 AND UPPER(sender_id) = $2 AND is_system = false LIMIT 1`,
    [shopId, name]
  );

  let row: any;
  if (existing.rows[0]) {
    const r = await pool.query(
      `UPDATE sms_sender_ids
       SET status = $2,
           provider_id = COALESCE($3, provider_id),
           provider_status = CASE WHEN $2 = 'approved' THEN 'approved' ELSE provider_status END,
           purpose = COALESCE($4, purpose),
           rejected_reason = NULL, provider_reason = NULL,
           review_reason = NULL, rejection_guidance = NULL, rejected_at = NULL,
           rejection_notify_sent = false, rejection_notified_at = NULL, rejection_notified_reason = NULL,
           submitted_at = COALESCE(submitted_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.rows[0].id, status, opts.providerId || null, opts.purpose || null]
    );
    row = r.rows[0];
  } else {
    const r = await pool.query(
      `INSERT INTO sms_sender_ids (shop_id, sender_id, purpose, status, provider_id, provider_status, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [shopId, name, opts.purpose || 'Business communications', status, opts.providerId || null, status === 'approved' ? 'approved' : null]
    );
    row = r.rows[0];
  }

  // Give the shop a default sender when it has none, so sending works without
  // an extra step; when it already has one, the shop can switch it itself.
  if (status === 'approved') {
    if (await ensureShopDefaultSender(shopId, row.id)) row.is_default = true;
  }

  return row;
}

// Remove the ALFEAN ENTERPRISES link for a provider sender (developer action). The sender ID
// stays on the provider account — the shop just stops seeing it in ALFEAN ENTERPRISES.
export async function unlinkProviderSender(rowId: string) {
  const r = await pool.query(
    `DELETE FROM sms_sender_ids WHERE id = $1 AND is_system = false RETURNING *`,
    [rowId]
  );
  if (r.rows.length === 0) throw new Error('Sender ID link not found');
  return r.rows[0];
}

// ─── DEVELOPER: SHOP SMS ACCOUNTS & PURCHASE HISTORY ─────────────────────────

// List every shop that has (or could have) SMS, with their account balance,
// usage, approved sender IDs, and purchase history summary. Searchable by shop
// name/email/phone or owner user name/email/phone.
export async function getAllSmsAccounts(search?: string, page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  const where: string[] = [];
  const params: any[] = [];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    where.push(`(
      sh.name ILIKE $${params.length} OR sh.email ILIKE $${params.length} OR sh.phone ILIKE $${params.length}
      OR COALESCE(u.name,'') ILIKE $${params.length} OR COALESCE(u.email,'') ILIKE $${params.length}
      OR COALESCE(u.first_name,'') ILIKE $${params.length} OR COALESCE(u.last_name,'') ILIKE $${params.length}
      OR COALESCE(u.phone,'') ILIKE $${params.length}
    )`);
  }
  // Only show shops with an ACTIVE SMS footprint: at least one real sender-ID
  // application (approved/pending/submitted — not the auto-assigned ALFEAN ENTERPRISES system
  // sender) OR an SMS bundle (any purchased credits / remaining balance). Shops
  // that never touched SMS are hidden so the list stays focused on real users.
  where.push(`(
    EXISTS (SELECT 1 FROM sms_sender_ids s WHERE s.shop_id = sh.id AND s.is_system = false AND s.status IN ('approved','pending','submitted'))
    OR COALESCE(acc.balance, 0) > 0
    OR COALESCE(acc.total_bought, 0) > 0
    OR COALESCE(acc.total_sent, 0) > 0
  )`);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const count = await pool.query(
    `SELECT COUNT(*) FROM shops sh
     LEFT JOIN user_shops us ON us.shop_id = sh.id AND us.role = 'owner'
     LEFT JOIN "user" u ON u.id = us.user_id
     LEFT JOIN sms_accounts acc ON acc.shop_id = sh.id
     ${whereSql}`,
    params
  );
  const rows = await pool.query(
    `SELECT
       sh.id as shop_id, sh.name as shop_name, sh.email as shop_email, sh.phone as shop_phone,
       u.id as owner_id, u.name as owner_name, u.first_name, u.last_name,
       u.email as owner_email, u.phone as owner_phone,
       COALESCE(acc.balance, 0)::int as balance,
       COALESCE(acc.total_bought, 0)::int as total_bought,
       COALESCE(acc.total_sent, 0)::int as total_sent,
       COALESCE(acc.low_balance_notified, false) as low_balance_notified,
       acc.updated_at as account_updated_at,
       (SELECT COUNT(*)::int FROM sms_sender_ids s WHERE s.shop_id = sh.id AND s.is_system = false AND s.status = 'approved') as approved_senders,
       (SELECT COUNT(*)::int FROM sms_sender_ids s WHERE s.shop_id = sh.id AND s.is_system = false AND s.status IN ('pending','submitted')) as pending_senders,
       (SELECT COUNT(*)::int FROM sms_messages m WHERE m.shop_id = sh.id AND m.status = 'failed') as failed_messages,
       (SELECT COUNT(*)::int FROM sms_purchases p WHERE p.shop_id = sh.id) as purchase_count,
       (SELECT COUNT(*)::int FROM sms_purchases p WHERE p.shop_id = sh.id AND p.status = 'pending') as pending_purchases,
       (SELECT COUNT(*)::int FROM sms_purchases p WHERE p.shop_id = sh.id AND p.status = 'failed') as failed_purchases,
       (SELECT COUNT(*)::int FROM sms_purchases p WHERE p.shop_id = sh.id AND p.status = 'completed') as completed_purchases,
       (SELECT COALESCE(SUM(p.credits), 0)::int FROM sms_purchases p WHERE p.shop_id = sh.id AND p.status = 'completed') as purchased_credits,
       -- Money this shop has actually PAID for SMS since day one (completed
       -- credit transactions with an amount) = the developer's revenue from
       -- this user. credits_paid counts only credits that were paid for;
       -- credits_issued includes free/manual/test credits.
       (SELECT COALESCE(SUM(t.amount_tzs), 0)::int FROM sms_transactions t
         WHERE t.shop_id = sh.id AND t.type = 'credit' AND t.status = 'completed' AND COALESCE(t.amount_tzs, 0) > 0) as paid_tzs,
       (SELECT COALESCE(SUM(t.credits), 0)::int FROM sms_transactions t
         WHERE t.shop_id = sh.id AND t.type = 'credit' AND t.status = 'completed') as credits_issued,
       (SELECT COALESCE(SUM(t.credits), 0)::int FROM sms_transactions t
         WHERE t.shop_id = sh.id AND t.type = 'credit' AND t.status = 'completed' AND COALESCE(t.amount_tzs, 0) > 0) as credits_paid,
       (SELECT MAX(t.created_at) FROM sms_transactions t
         WHERE t.shop_id = sh.id AND COALESCE(t.amount_tzs, 0) > 0) as last_paid_at,
       (SELECT MAX(p.created_at) FROM sms_purchases p WHERE p.shop_id = sh.id) as last_purchase_at
     FROM shops sh
     LEFT JOIN user_shops us ON us.shop_id = sh.id AND us.role = 'owner'
     LEFT JOIN "user" u ON u.id = us.user_id
     LEFT JOIN sms_accounts acc ON acc.shop_id = sh.id
     ${whereSql}
     ORDER BY COALESCE(acc.updated_at, sh.created_at) DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const total = parseInt(count.rows[0].count);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// Full detail for one shop: account usage, sender IDs, purchase history,
// transactions, recent sent messages, and SMS issues (failed messages / failed
// or pending purchases).
export async function getSmsAccountDetail(shopId: string) {
  const account = await pool.query(
    `SELECT * FROM sms_accounts WHERE shop_id = $1`,
    [shopId]
  );
  const shop = await pool.query(
    `SELECT sh.id, sh.name, sh.email, sh.phone, sh.created_at,
            u.id as owner_id, u.name as owner_name, u.first_name, u.last_name,
            u.email as owner_email, u.phone as owner_phone
     FROM shops sh
     LEFT JOIN user_shops us ON us.shop_id = sh.id AND us.role = 'owner'
     LEFT JOIN "user" u ON u.id = us.user_id
     WHERE sh.id = $1`,
    [shopId]
  );
  const senderIds = await pool.query(
    `SELECT id, sender_id, purpose, status, provider_id, rejected_reason,
            is_default, is_system, applied_by, applied_email, applied_phone,
            rejection_notify_sent, rejection_notified_at, created_at, updated_at
     FROM sms_sender_ids WHERE shop_id = $1 ORDER BY created_at DESC`,
    [shopId]
  );
  const purchases = await pool.query(
    `SELECT id, credits, amount_tzs, price_per_sms, phone_number, snippe_reference,
            status, provider_cost, profit, paid_at, created_at
     FROM sms_purchases WHERE shop_id = $1 ORDER BY created_at DESC`,
    [shopId]
  );
  const transactions = await pool.query(
    `SELECT id, type, credits, amount_tzs, price_per_sms, status, reference,
            snippe_reference, created_at
     FROM sms_transactions WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [shopId]
  );
  const messages = await pool.query(
    `SELECT id, recipient, message, parts, credits, cost, status,
            provider_message_id, sender_id, campaign_id, source, created_at
     FROM sms_messages WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [shopId]
  );
  const failedMessages = await pool.query(
    `SELECT id, recipient, message, parts, credits, cost, status,
            provider_message_id, sender_id, source, created_at
     FROM sms_messages WHERE shop_id = $1 AND status = 'failed'
     ORDER BY created_at DESC LIMIT 100`,
    [shopId]
  );

  return {
    shop: shop.rows[0] || null,
    account: account.rows[0] || { shop_id: shopId, balance: 0, total_bought: 0, total_sent: 0 },
    senderIds: senderIds.rows,
    purchases: purchases.rows,
    transactions: transactions.rows,
    messages: messages.rows,
    failedMessages: failedMessages.rows,
  };
}
