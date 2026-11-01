import crypto from 'node:crypto';
import { pool } from '../config/drizzle.js';

const BASE_URL = 'https://sms.ehub.co.tz/api/v1';
const API_PREFIX = '/api/v1';
const MAX_REQUESTS_PER_MINUTE = 120;
const MIN_INTERVAL_MS = Math.ceil(60000 / MAX_REQUESTS_PER_MINUTE);

let lastRequestAt = 0;

function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestAt));
  lastRequestAt = Math.max(now, lastRequestAt + MIN_INTERVAL_MS);
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

function getApiKey(): string {
  return process.env.EHUB_SMS_API_KEY || '';
}

function getApiSecret(): string {
  return process.env.EHUB_SMS_SECRET || process.env.EHUB_SMS_API_SECRET || '';
}

export function isEhubConfigured(): boolean {
  return Boolean(getApiKey() && getApiSecret());
}

export function ehubStatus() {
  return {
    configured: isEhubConfigured(),
    hasKey: Boolean(getApiKey()),
    hasSecret: Boolean(getApiSecret()),
    // Delivery reports (webhook) are only verified when this secret is set;
    // without it the endpoint accepts unsigned payloads (dev fallback).
    webhookSecret: Boolean(process.env.EHUB_SMS_SIGNING_SECRET || process.env.EHUB_SMS_WEBHOOK_SECRET),
  };
}

// Per the eHub docs, the HMAC payload uses the FULL request path including the
// /api/v1 prefix, e.g. "/api/v1/sms/send". Query-string parameters are NOT part
// of the signed path — only the path component is (e.g. "/api/v1/sms/history").
function fullPath(path: string): string {
  const noQuery = path.split('?')[0];
  return `${API_PREFIX}${noQuery.startsWith('/') ? noQuery : `/${noQuery}`}`;
}

// Learned offset between this server's clock and eHub's (from the Date header
// on responses). The HMAC timestamp must be within ±5 minutes of the provider's
// clock, so a drifting VPS clock would otherwise fail every request with 401.
let clockSkewMs = 0;

function sign(method: string, path: string, body: string): { timestamp: number; signature: string } {
  const timestamp = Math.floor((Date.now() + clockSkewMs) / 1000);
  const payload = `${timestamp}\n${method}\n${fullPath(path)}\n${body}`;
  const signature = crypto.createHmac('sha256', getApiSecret()).update(payload).digest('hex');
  return { timestamp, signature };
}

function parseRetryAfter(res: Response): number {
  const h = res.headers.get('retry_after');
  if (!h) return 0;
  const secs = parseInt(h, 10);
  return Number.isFinite(secs) ? Math.min(Math.max(secs, 1), 60) : 0;
}

async function request<T = any>(
  method: string,
  path: string,
  body?: Record<string, any>,
  opts?: { maxRetries?: number }
): Promise<{ ok: boolean; status: number; data: T; message?: string; rateLimit?: any }> {
  if (!isEhubConfigured()) {
    throw new Error('EHUB_SMS_API_KEY and EHUB_SMS_SECRET are not configured');
  }

  const rawBody = body ? JSON.stringify(body) : '';
  const maxRetries = opts?.maxRetries ?? 3;
  let attempts = 0;
  let skewRetried = false;

  for (;;) {
    await throttle();

    const { timestamp, signature } = sign(method.toUpperCase(), path, rawBody);

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getApiKey()}`,
          'X-Timestamp': String(timestamp),
          'X-Signature': signature,
        },
        body: rawBody || undefined,
      });
    } catch (e: any) {
      throw new Error(`eHub SMS network error: ${e.message}`);
    }

    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { success: false, message: `Invalid response: ${text.slice(0, 200)}` };
    }

    // Clock-skew guard: learn the offset from the provider's Date header. If the
    // local clock is off by more than 30s and the request failed auth (401),
    // retry once with the corrected timestamp — a drifting VPS clock must never
    // take SMS down.
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
      const serverMs = Date.parse(dateHeader);
      if (Number.isFinite(serverMs)) {
        const skew = serverMs - Date.now();
        if (Math.abs(skew) > 30_000) {
          clockSkewMs = skew;
          if (res.status === 401 && !skewRetried && attempts < maxRetries) {
            skewRetried = true;
            attempts += 1;
            console.warn(`[eHub] Clock skew ${Math.round(skew / 1000)}s detected — retrying with corrected timestamp`);
            continue;
          }
        }
      }
    }

    const rateLimit = {
      limit: res.headers.get('X-RateLimit-Limit'),
      remaining: res.headers.get('X-RateLimit-Remaining'),
      reset: res.headers.get('X-RateLimit-Reset'),
    };

    // Respect the documented rate limit: back off and retry on 429.
    if (res.status === 429 && attempts < maxRetries) {
      attempts += 1;
      const waitMs = parseRetryAfter(res) * 1000 || Math.min(1000 * Math.pow(2, attempts - 1), 10000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // Transient provider/gateway failures (nginx 500/502/503/504, HTML error
    // pages, gateway timeouts) get a couple of short retries before the error
    // is surfaced — a blip must not fail a paid SMS.
    if (res.status >= 500 && attempts < maxRetries) {
      attempts += 1;
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempts, 5000)));
      continue;
    }

    return {
      ok: res.ok && json.success !== false,
      status: res.status,
      data: json,
      message: json.message || json.error || (json.errors ? JSON.stringify(json.errors) : undefined),
      rateLimit,
    };
  }
}

// ─── SENDER IDS ──────────────────────────────────────────────────────────────

export interface SenderIdInfo {
  id: string;
  sender_id: string;
  status: string;
  [key: string]: any;
}

// The sender list is polled by the background sync job AND by the live status
// endpoints (admin + every shop page). Cache the provider response briefly so
// many concurrent page loads share ONE upstream request instead of hammering
// eHub and hitting its rate limit.
let cachedSenderList: SenderIdInfo[] | null = null;
let cachedSenderListAt = 0;
const SENDER_LIST_CACHE_MS = 60 * 1000;

export async function getSenderIds(): Promise<SenderIdInfo[]> {
  if (cachedSenderList && Date.now() - cachedSenderListAt < SENDER_LIST_CACHE_MS) {
    return cachedSenderList;
  }

  // eHub paginates this endpoint (20 per page by default, max 100) and returns
  // senders grouped: { own:[], shared:[], public:[] } plus pagination.last_page.
  // Fetch EVERY page — with 20+ sender IDs on the account, page 1 alone hid
  // approved senders (their shops showed "no sender ID").
  const combined: SenderIdInfo[] = [];
  const seen = new Set<string>();
  const perPage = 100;
  let page = 1;
  let lastPage = 1;

  do {
    const res = await request('GET', `/sender-ids?limit=${perPage}&page=${page}`);
    if (!res.ok) {
      if (page === 1) throw new Error(res.message || 'Failed to list sender IDs');
      break; // keep what we already collected
    }
    const raw = res.data?.data ?? res.data;
    const groups: any[] = [];
    if (Array.isArray(raw)) {
      groups.push(...raw);
    } else if (raw && typeof raw === 'object') {
      for (const key of ['own', 'shared', 'public']) {
        if (Array.isArray(raw[key])) groups.push(...raw[key]);
      }
      // Some response variants use a flat list key instead of group keys.
      for (const key of ['sender_ids', 'senders', 'items']) {
        if (Array.isArray(raw[key])) groups.push(...raw[key]);
      }
    }

    for (const s of groups.map(normalizeSenderId)) {
      const key = String(s.id || s.sender_id || '').toUpperCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      combined.push(s);
    }

    const pagination =
      (raw && typeof raw === 'object' && raw.pagination) ||
      (res.data && typeof res.data === 'object' && (res.data as any).pagination) ||
      null;
    const reportedLast = Number(pagination?.last_page);
    if (Number.isFinite(reportedLast) && reportedLast > 0) lastPage = reportedLast;

    // Stop when the provider says we are done, a page came back empty, or the
    // safety cap is hit (max 10 pages = 1000 senders).
    if (groups.length === 0 || page >= lastPage || page >= 10) break;
    page++;
  } while (true);

  cachedSenderList = combined;
  cachedSenderListAt = Date.now();
  return combined;
}

// Per-sender detail. eHub returns the admin's review/rejection message on some
// plans only from the detail endpoint, not in the list payload — used as a
// fallback so the provider's reason always lands in the portal. Cached briefly
// because shop pages re-check their sender status every 30s.
const senderDetailCache = new Map<string, { at: number; data: any }>();
const SENDER_DETAIL_CACHE_MS = 5 * 60 * 1000;

export async function getSenderIdDetail(senderId: string): Promise<any> {
  const hit = senderDetailCache.get(senderId);
  if (hit && Date.now() - hit.at < SENDER_DETAIL_CACHE_MS) return hit.data;
  const res = await request('GET', `/sender-ids/${encodeURIComponent(senderId)}`);
  if (!res.ok) throw new Error(res.message || 'Failed to fetch sender ID detail');
  const data = res.data?.data ?? res.data;
  senderDetailCache.set(senderId, { at: Date.now(), data });
  return data;
}

// The API uses `sender_name`; other consumers expect `sender_id`. Normalize the
// shape so getPrimarySenderInfo and the reseller registry agree on field names.
function normalizeSenderId(s: any): SenderIdInfo {
  return {
    ...s,
    sender_id: s.sender_id ?? s.sender_name ?? s.name ?? '',
    name: s.sender_name ?? s.name ?? s.sender_id ?? '',
  };
}

// The provider only accepts these exact purpose values; anything else → Other.
const EHUB_PURPOSES = ['Notification', 'Transactional', 'OTP / Verification', 'Promotional', 'Marketing', 'Alerts & Reminders', 'Other'];
function normalizePurpose(purpose?: string): string {
  const hit = EHUB_PURPOSES.find((p) => p.toLowerCase() === String(purpose || '').toLowerCase());
  return hit || 'Other';
}

export async function requestSenderId(senderId: string, purpose?: string, sample?: string): Promise<any> {
  // `sample` is REQUIRED by eHub (50–250 chars, a realistic example of the
  // messages this sender will carry). Default one satisfies both bounds.
  const fallbackSample =
    `Karibu! Hii ni taarifa kutoka ${senderId.toUpperCase()}: tunakutumia taarifa za bidhaa, bei na matangazo yetu ya mara kwa mara. Asante kwa kutumia huduma yetu. Reply STOP kuacha.`;
  const sampleText = String(sample || '').trim();
  const res = await request('POST', '/sender-ids', {
    sender_id: senderId.toUpperCase(),
    purpose: normalizePurpose(purpose),
    sample: (sampleText.length >= 50 ? sampleText : fallbackSample).slice(0, 250),
  });
  if (!res.ok) {
    throw new Error(res.message || 'Failed to request sender ID');
  }
  return res.data?.data ?? res.data;
}

// Resolves the UUID eHub uses to identify the sender for ALFEAN ENTERPRISES's own/system SMS
// (admin manual sends, campaigns, payment reminders, etc.). Prefers an explicit
// EHUB_SMS_SENDER_ID env var, otherwise picks the first approved sender ID on the
// account and caches it for 5 minutes to avoid hammering the API.
let cachedSenderId: string | null = null;
let cachedSenderAt = 0;
const SENDER_CACHE_MS = 5 * 60 * 1000;

export async function getPrimarySenderId(): Promise<string> {
  const info = await getPrimarySenderInfo();
  return info.id;
}

// Resolves both the UUID and the display name of the ALFEAN ENTERPRISES account's primary
// (system) sender. Used to auto-assign a working default sender to every shop.
// Prefers EHUB_SMS_SENDER_ID + EHUB_SMS_SENDER_NAME, otherwise the first
// approved sender on the account (cached 5 min).
let cachedSenderInfo: { id: string; sender_id: string } | null = null;
let cachedSenderInfoAt = 0;

export async function getPrimarySenderInfo(): Promise<{ id: string; sender_id: string }> {
  const envId = (process.env.EHUB_SMS_SENDER_ID || '').trim();
  const envName = (process.env.EHUB_SMS_SENDER_NAME || '').trim();
  const envConfigured = Boolean(envId || envName);
  if (cachedSenderInfo && Date.now() - cachedSenderInfoAt < SENDER_CACHE_MS) return cachedSenderInfo;

  const norm = (v: any) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const envIdNorm = norm(envId);
  const envNameNorm = norm(envName);
  const isEnabled = (s: any) => {
    const st = String(s.status || '').toLowerCase();
    return st === 'approved' || st === 'active' || st === 'enabled';
  };

  // The provider's sender-list endpoint can be unreachable (network/auth) — in
  // that case do NOT fail every SMS: fall back to the .env sender and/or a
  // provider UUID we already have stored in our own DB.
  let senderIds: SenderIdInfo[] = [];
  try {
    senderIds = await getSenderIds();
  } catch (e: any) {
    console.warn('[SMS] eHub sender list unavailable — using .env/stored fallback:', e.message);
  }

  // Matches the configured system sender. Both variables may hold a UUID or a
  // display name (some deployments set EHUB_SMS_SENDER_ID to the name) — names
  // are compared normalized, so "ALFEAN ENTERPRISES POS" == "JBPOS" == "hss pos".
  const matchesEnvId = (s: any) => {
    const id = String(s.id || '');
    const nameNorm = norm(s.sender_id || s.senderId || s.name);
    return Boolean(envId && (id === envId || (envIdNorm && nameNorm === envIdNorm)));
  };
  const matchesEnvName = (s: any) => {
    const id = String(s.id || '');
    const nameNorm = norm(s.sender_id || s.senderId || s.name);
    return Boolean(envName && (nameNorm === envNameNorm || (id && id === envName)));
  };
  const matchesEnv = (s: any) => matchesEnvId(s) || matchesEnvName(s);

  // 1) The configured sender, when the provider lists it and it is approved.
  //    EHUB_SMS_SENDER_ID wins over EHUB_SMS_SENDER_NAME when both are set.
  const configured =
    senderIds.find((s) => isEnabled(s) && matchesEnvId(s)) ||
    senderIds.find((s) => isEnabled(s) && matchesEnvName(s));

  // Configured but present on eHub without approval: fail loudly instead of
  // silently sending under some other shop's brand.
  if (envConfigured && !configured) {
    const found = senderIds.find((s) => matchesEnv(s));
    if (found) {
      throw new Error(`Configured system sender "${envName || envId}" is on eHub but not approved yet (status: ${found.status || 'unknown'}).`);
    }
  }

  // 2) No .env sender configured → first approved sender (legacy behaviour).
  const approved = configured || (!envConfigured ? senderIds.find((s) => isEnabled(s)) : undefined);

  const id = approved?.id || (isUuid(envId) ? envId : '');
  const senderId = String(approved?.sender_id || approved?.senderId || approved?.name || envName || '').trim();
  if (id) {
    cachedSenderInfo = { id, sender_id: senderId };
    cachedSenderInfoAt = Date.now();
    return cachedSenderInfo;
  }

  // 3) Provider list unavailable: use the provider UUID stored in our own DB
  //    for the configured sender (or ALFEAN ENTERPRISES POS / ALFEAN ENTERPRISES). Never another shop's.
  try {
    const r = await pool.query(`
      SELECT provider_id, sender_id FROM sms_sender_ids
      WHERE provider_id IS NOT NULL AND provider_id <> '' AND provider_id <> 'test-provider'
        AND provider_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          regexp_replace(UPPER(sender_id), '[^A-Z0-9]', '', 'g') = $1
          OR regexp_replace(UPPER(sender_id), '[^A-Z0-9]', '', 'g') = $2
          OR UPPER(sender_id) IN ('ALFEAN ENTERPRISES POS', 'ALFEAN ENTERPRISES')
        )
      ORDER BY CASE
        WHEN regexp_replace(UPPER(sender_id), '[^A-Z0-9]', '', 'g') = $2 THEN 0
        WHEN regexp_replace(UPPER(sender_id), '[^A-Z0-9]', '', 'g') = $1 THEN 1
        ELSE 2 END
      LIMIT 1
    `, [envNameNorm || 'JBPOS', envIdNorm || 'JBPOS']);
    if (r.rows.length > 0) {
      cachedSenderInfo = { id: String(r.rows[0].provider_id), sender_id: String(r.rows[0].sender_id) };
      cachedSenderInfoAt = Date.now();
      console.log(`[SMS] Using stored provider sender UUID for "${r.rows[0].sender_id}" (eHub list unavailable)`);
      return cachedSenderInfo;
    }
  } catch { /* ignore — throw the descriptive error below */ }

  // 4) Explicit UUID in .env: use it even though the list couldn't confirm it.
  if (isUuid(envId)) {
    cachedSenderInfo = { id: envId, sender_id: envName || 'ALFEAN ENTERPRISES POS' };
    cachedSenderInfoAt = Date.now();
    return cachedSenderInfo;
  }

  throw new Error(
    envConfigured
      ? `Configured system sender "${envName || envId}" was not found on eHub. Approve it in the eHub dashboard or fix EHUB_SMS_SENDER_NAME / EHUB_SMS_SENDER_ID.`
      : 'No approved eHub sender ID found. Set EHUB_SMS_SENDER_ID to the sender UUID from your eHub dashboard (Developer → Sender IDs).'
  );
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// ─── SMS ─────────────────────────────────────────────────────────────────────

export async function sendSingleSms(to: string, message: string, senderIdUuid: string): Promise<any> {
  const res = await request('POST', '/sms/send', {
    to,
    message,
    sender_id: senderIdUuid,
  });
  if (!res.ok) {
    throw new Error(res.message ? `eHub HTTP ${res.status}: ${res.message}` : `eHub send failed (HTTP ${res.status})`);
  }
  return res.data?.data ?? res.data;
}

export async function sendBulkSms(
  recipients: string[],
  message: string,
  senderIdUuid: string,
  campaignName?: string,
  scheduledAt?: string | null
): Promise<any> {
  const res = await request('POST', '/sms/send-bulk', {
    recipients,
    message,
    sender_id: senderIdUuid,
    campaign_name: campaignName,
    scheduled_at: scheduledAt || null,
  });
  if (!res.ok) {
    throw new Error(res.message ? `eHub HTTP ${res.status}: ${res.message}` : `eHub bulk send failed (HTTP ${res.status})`);
  }
  return res.data?.data ?? res.data;
}

export async function getSmsHistory(query: Record<string, any> = {}): Promise<any[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  const res = await request('GET', `/sms/history${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(res.message || 'Failed to fetch history');
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

export async function getMessageStatus(messageId: string): Promise<any> {
  const res = await request('GET', `/sms/${messageId}`);
  if (!res.ok) throw new Error(res.message || 'Failed to fetch message status');
  return res.data?.data ?? res.data;
}

// ─── WALLET ──────────────────────────────────────────────────────────────────

export async function getWalletBalance(): Promise<number> {
  const res = await request('GET', '/wallet/balance');
  if (!res.ok) throw new Error(res.message || 'Failed to fetch wallet balance');
  const data = res.data?.data ?? res.data;
  if (typeof data === 'number') return data;
  if (data && typeof data === 'object') {
    // Prefer the SMS credit field. The eHub response also carries a `balance`
    // TZS money amount (e.g. "0.00") which is NOT the SMS credit — read
    // sms_balance / credits FIRST so we don't mistake the wallet cash for SMS.
    const val = data.sms_balance ?? data.smsBalance ?? data.credits ?? data.available ?? data.count ?? data.value ?? data.balance ?? 0;
    return Number(val) || 0;
  }
  return Number(data) || 0;
}

export async function getWalletTransactions(page = 1, limit = 20): Promise<any[]> {
  const res = await request('GET', `/wallet/transactions?page=${page}&limit=${limit}`);
  if (!res.ok) throw new Error(res.message || 'Failed to fetch transactions');
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

export async function getPlans(): Promise<any[]> {
  const res = await request('GET', '/plans');
  if (!res.ok) throw new Error(res.message || 'Failed to fetch plans');
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

// ─── PAYMENTS (TOP-UP) ───────────────────────────────────────────────────────

export async function initiatePayment(
  smsQuantity: number,
  phoneNumber: string,
  idempotencyKey?: string
): Promise<any> {
  const res = await request('POST', '/payments/initiate', {
    sms_quantity: smsQuantity,
    phone_number: phoneNumber,
    idempotency_key: idempotencyKey || undefined,
  });
  if (!res.ok) {
    throw new Error(res.message || 'Failed to initiate payment');
  }
  return res.data?.data ?? res.data;
}

export async function getPaymentStatus(orderReference: string): Promise<any> {
  const res = await request('GET', `/payments/${encodeURIComponent(orderReference)}/status`);
  if (!res.ok) throw new Error(res.message || 'Failed to fetch payment status');
  return res.data?.data ?? res.data;
}

// Paginated purchase history straight from the provider (GET /payments).
export async function getPayments(query: Record<string, any> = {}): Promise<any> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  const res = await request('GET', `/payments${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(res.message || 'Failed to fetch payments');
  return res.data?.data ?? res.data;
}

// ─── CONNECTION HEALTH (developer portal) ────────────────────────────────────
// One lightweight call that proves the whole chain works: API key, HMAC secret,
// timestamp/clock sync, network reachability, wallet read and rate-limit
// headroom. Used by the "Test connection" button in SMS Reseller Control.
export interface EhubConnectionTest {
  ok: boolean;
  configured: boolean;
  status: number | null;
  latencyMs: number;
  message?: string;
  sms_balance?: number;
  tzs_balance?: number | null;
  rateLimit?: { limit: string | null; remaining: string | null; reset: string | null };
  clockSkewMs: number;
}

export async function testConnection(): Promise<EhubConnectionTest> {
  if (!isEhubConfigured()) {
    return {
      ok: false,
      configured: false,
      status: null,
      latencyMs: 0,
      message: 'EHUB_SMS_API_KEY / EHUB_SMS_SECRET are not set on the server',
      clockSkewMs,
    };
  }
  const started = Date.now();
  try {
    const res = await request('GET', '/wallet/balance', undefined, { maxRetries: 0 });
    const latencyMs = Date.now() - started;
    const data = res.data?.data ?? res.data;
    const smsBalance = typeof data === 'number'
      ? data
      : Number(data?.sms_balance ?? data?.smsBalance ?? data?.credits ?? data?.available ?? 0) || 0;
    const tzsBalance = data && typeof data === 'object' && data.balance !== undefined
      ? Number(data.balance)
      : null;
    return {
      ok: res.ok,
      configured: true,
      status: res.status,
      latencyMs,
      message: res.ok ? undefined : (res.message || `HTTP ${res.status}`),
      sms_balance: smsBalance,
      tzs_balance: tzsBalance,
      rateLimit: res.rateLimit,
      clockSkewMs,
    };
  } catch (e: any) {
    return {
      ok: false,
      configured: true,
      status: null,
      latencyMs: Date.now() - started,
      message: e.message,
      clockSkewMs,
    };
  }
}
