import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { hasPermission } from '../../middleware/rbac.middleware.js';
import * as reseller from '../../services/sms-reseller.service.js';
import { getPaymentStatus, triggerPaymentPush } from '../../services/snippe.service.js';

const smsUserRoutes = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();

// Sellers only reach the SMS Center when the shop admin granted sms:read.
// Admins/owners pass through automatically (full access).
const requireSmsAccess = async (c: any, next: any) => {
  if (c.get('userRole') === 'seller') {
    const shopIds = c.get('shopIds') || [];
    const allowed = await hasPermission(
      c.get('userId'),
      'seller',
      shopIds[0] as string,
      'sms:read',
      c.get('user')?.email
    );
    if (!allowed) {
      return c.json({ success: false, error: 'Forbidden - Insufficient permissions' }, 403);
    }
  }
  await next();
};

smsUserRoutes.use('/*', authMiddleware, requireSmsAccess);

function getShopId(c: any): string {
  const shopIds = c.get('shopIds') || [];
  if (shopIds.length === 0) {
    throw Object.assign(new Error('No shop found for this account'), { status: 400 });
  }
  return shopIds[0];
}

// Applicant contact details (email + phone) used for sender ID review
// notifications — resolved fresh on every application/re-application.
async function getApplicantInfo(c: any): Promise<{ userId?: string; email?: string; phone?: string } | undefined> {
  const userId = c.get('userId');
  if (!userId) return undefined;
  const { pool } = await import('../../config/drizzle.js');
  const u = await pool.query(`SELECT email, phone FROM "user" WHERE id = $1`, [userId]);
  if (!u.rows[0]) return undefined;
  return { userId, email: u.rows[0].email || undefined, phone: u.rows[0].phone || undefined };
}

const handle = (fn: (c: any) => Promise<any>) => async (c: any) => {
  try {
    return await fn(c);
  } catch (e: any) {
    const status = e.status || 400;
    return c.json({ success: false, error: e.message }, status);
  }
};

// ─── SHOP-FACING SANITIZERS ──────────────────────────────────────────────────
// Reseller internals are for the DEVELOPER only. Shops see their sender status,
// their balance, the price THEY pay and their own activity — never how we buy
// SMS from the provider or our margin.
function shopSafeResellerSettings(s: any) {
  return {
    price_per_sms: s?.price_per_sms,
    min_sms_purchase: s?.min_sms_purchase || 50,
    free_sms_bonus: s?.free_sms_bonus,
    low_balance_threshold: s?.low_balance_threshold,
    enabled: s?.enabled,
    sms_enabled: s?.sms_enabled,
  };
}

function shopSafePurchase<T>(row: T): T {
  if (!row) return row;
  const { provider_cost, profit, ...safe } = row as any;
  return safe as T;
}

// ─── STATUS / BALANCE ────────────────────────────────────────────────────────

smsUserRoutes.get('/status', handle(async (c) => {
  const shopId = getShopId(c);
  await reseller.ensureDefaultSender(shopId);
  const [balance, settings, senderIds, shopSettings, queued] = await Promise.all([
    reseller.getSmsBalanceInfo(shopId),
    reseller.getResellerSettings(),
    reseller.listSenderIds(shopId),
    reseller.getShopSmsSettings(shopId),
    (async () => {
      const { pool } = await import('../../config/drizzle.js');
      const q = await pool.query(`SELECT COUNT(*) FROM sms_messages WHERE shop_id = $1 AND status = 'queued'`, [shopId]);
      return parseInt(q.rows[0].count) || 0;
    })(),
  ]);
  return c.json({ success: true, data: { balance, settings: shopSafeResellerSettings(settings), senderIds, shopSettings, queued } });
}));

smsUserRoutes.get('/balance', handle(async (c) => {
  const shopId = getShopId(c);
  const info = await reseller.getSmsBalanceInfo(shopId);
  return c.json({ success: true, data: info });
}));

// ─── SENDER IDS ──────────────────────────────────────────────────────────────

smsUserRoutes.get('/sender-ids', handle(async (c) => {
  const shopId = getShopId(c);
  await reseller.ensureDefaultSender(shopId);
  const rows = await reseller.listSenderIds(shopId);
  const publicSenders = await reseller.getPublicSenders();
  return c.json({ success: true, data: { own: rows, public: publicSenders } });
}));

// Senders a user may actually send from: approved own senders + approved public
// senders (used while their own is still pending approval).
smsUserRoutes.get('/sender-ids/selectable', handle(async (c) => {
  const shopId = getShopId(c);
  const own = await reseller.listSenderIds(shopId);
  const publicSenders = await reseller.getPublicSenders();
  const approvedOwn = own.filter((s: any) => s.status === 'approved' && s.is_system !== true);
  return c.json({
    success: true,
    data: {
      approvedOwn: approvedOwn.map((s: any) => ({ provider_id: s.provider_id, sender_id: s.sender_id, is_default: s.is_default === true })),
      public: publicSenders,
      system: own.filter((s: any) => s.is_system === true).map((s: any) => ({ provider_id: s.provider_id, sender_id: s.sender_id })),
    },
  });
}));

smsUserRoutes.get('/sender-ids/status', handle(async (c) => {
  const shopId = getShopId(c);
  const rows = await reseller.getLiveSenderIdStatuses(shopId);
  return c.json({ success: true, data: rows });
}));

smsUserRoutes.post('/sender-ids/:id/default', handle(async (c) => {
  const shopId = getShopId(c);
  const row = await reseller.setDefaultSender(shopId, c.req.param('id'));
  return c.json({ success: true, data: row, message: 'Default sender ID updated' });
}));

smsUserRoutes.post('/sender-ids', handle(async (c) => {
  const shopId = getShopId(c);
  const { sender_id, purpose, sample } = await c.req.json();
  if (!sender_id) return c.json({ success: false, error: 'Sender ID is required' }, 400);

  const applicantInfo = await getApplicantInfo(c);
  const row = await reseller.requestShopSenderId(shopId, sender_id, purpose, applicantInfo, sample);
  // A rejected sender ID re-applied with the SAME name reuses its row and bumps
  // reapply_count — tell the applicant it is a fresh submission.
  const isReapply = Number(row.reapply_count) > 0 && Boolean(row.last_reapply_at);
  return c.json({
    success: true,
    data: row,
    message: isReapply
      ? 'Sender ID re-submitted for approval — you will be notified of the outcome'
      : 'Sender ID request submitted for approval',
  }, 201);
}));

// AI assistance for sender-ID applications: catches the two reasons eHub
// rejects most applications (personal name / missing sample) BEFORE submit,
// and returns ready business-name + sample suggestions.
smsUserRoutes.post('/sender-id/assist', handle(async (c) => {
  const shopId = getShopId(c);
  const body = await c.req.json().catch(() => ({}));
  const applicantInfo = await getApplicantInfo(c);
  const { pool } = await import('../../config/drizzle.js');
  const [shopRow, userRow, productRow] = await Promise.all([
    pool.query(`SELECT name FROM shops WHERE id = $1`, [shopId]),
    applicantInfo?.userId
      ? pool.query(`SELECT first_name, last_name, name FROM "user" WHERE id = $1`, [applicantInfo.userId])
      : Promise.resolve({ rows: [] as any[] }),
    // The shop's actual products give the AI the business context it needs to
    // suggest names/samples that match what they really sell.
    pool.query(`SELECT name FROM products WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 6`, [shopId])
      .catch(() => ({ rows: [] as any[] })),
  ]);
  const u: any = userRow.rows[0] || {};
  const applicantName = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || '';
  const businessContext = productRow.rows.map((r: any) => r.name).filter(Boolean).join(', ');
  const data = await reseller.assistSenderIdApplication({
    senderId: body.sender_id,
    purpose: body.purpose,
    sample: body.sample,
    shopName: shopRow.rows[0]?.name || '',
    applicantName,
    businessContext,
    language: body.language || 'sw',
  });
  return c.json({ success: true, data });
}));

// Re-apply a rejected sender ID (same name, fresh review cycle). Rejected
// applicants always have room to try again — optionally with a corrected
// purpose/sample. If they want a different name they can simply submit a new
// request above.
smsUserRoutes.post('/sender-ids/:id/reapply', handle(async (c) => {
  const shopId = getShopId(c);
  const { purpose, sample } = await c.req.json().catch(() => ({}));
  const applicantInfo = await getApplicantInfo(c);
  const row = await reseller.reapplySenderId(shopId, c.req.param('id'), purpose, applicantInfo, sample);
  return c.json({ success: true, data: row, message: 'Sender ID re-submitted for approval' });
}));

// ─── SEND ────────────────────────────────────────────────────────────────────

smsUserRoutes.post('/send', handle(async (c) => {
  const shopId = getShopId(c);
  const { phone, message, sender_id } = await c.req.json();
  if (!phone || !message) return c.json({ success: false, error: 'Phone and message are required' }, 400);
  const result = await reseller.sendUserSms({ shopId, phone, message, source: 'manual', preferredProviderId: sender_id || undefined });
  return c.json({ success: true, data: result });
}));

smsUserRoutes.post('/send-bulk', handle(async (c) => {
  const shopId = getShopId(c);
  const { recipients, message, campaignName, sender_id } = await c.req.json();
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return c.json({ success: false, error: 'Recipients are required' }, 400);
  }
  if (!message) return c.json({ success: false, error: 'Message is required' }, 400);
  const result = await reseller.sendUserBulkSms({
    shopId, recipients, message, campaignName, source: 'manual', preferredProviderId: sender_id || undefined,
  });
  return c.json({ success: true, data: result });
}));

// ─── HISTORY ─────────────────────────────────────────────────────────────────

smsUserRoutes.get('/history', handle(async (c) => {
  const shopId = getShopId(c);
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const status = c.req.query('status') || undefined;
  const result = await reseller.getShopSmsHistory(shopId, page, limit, status);
  return c.json({ success: true, ...result });
}));

// Re-send a failed SMS from the shop's own history (one tap retry).
smsUserRoutes.post('/history/:id/resend', handle(async (c) => {
  const shopId = getShopId(c);
  const id = c.req.param('id');
  try {
    const result = await reseller.resendShopSms(shopId, id);
    return c.json({ ...result, success: true, message: 'SMS imetumwa tena' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
}));

// ─── TEMPLATES ───────────────────────────────────────────────────────────────

smsUserRoutes.get('/templates', handle(async (c) => {
  const shopId = getShopId(c);
  const rows = await reseller.listTemplates(shopId);
  return c.json({ success: true, data: rows });
}));

smsUserRoutes.post('/templates', handle(async (c) => {
  const shopId = getShopId(c);
  const { name, message, category, id } = await c.req.json();
  if (!name || !message) return c.json({ success: false, error: 'Name and message are required' }, 400);
  const row = await reseller.saveTemplate(shopId, { name, message, category, id });
  return c.json({ success: true, data: row }, id ? 200 : 201);
}));

smsUserRoutes.delete('/templates/:id', handle(async (c) => {
  const shopId = getShopId(c);
  await reseller.deleteTemplate(shopId, c.req.param('id'));
  return c.json({ success: true });
}));

// ─── CONTACTS & GROUPS ───────────────────────────────────────────────────────

smsUserRoutes.get('/contacts', handle(async (c) => {
  const shopId = getShopId(c);
  const rows = await reseller.listContacts(shopId, c.req.query('search') || undefined);
  return c.json({ success: true, data: rows });
}));

smsUserRoutes.post('/contacts', handle(async (c) => {
  const shopId = getShopId(c);
  const body = await c.req.json();
  const row = await reseller.addContact(shopId, body);
  return c.json({ success: true, data: row }, 201);
}));

// Bulk import phone numbers (pasted or uploaded from a file) so they are saved
// as contacts and reusable for later bulk sends.
smsUserRoutes.post('/contacts/bulk', handle(async (c) => {
  const shopId = getShopId(c);
  const { phones } = await c.req.json();
  if (!Array.isArray(phones) || phones.length === 0) {
    return c.json({ success: false, error: 'No phone numbers provided' }, 400);
  }
  const result = await reseller.bulkAddContacts(shopId, phones);
  return c.json({ success: true, data: result, message: `${result.added} ${result.added === 1 ? 'contact' : 'contacts'} saved` });
}));

smsUserRoutes.delete('/contacts/:id', handle(async (c) => {
  const shopId = getShopId(c);
  await reseller.deleteContact(shopId, c.req.param('id'));
  return c.json({ success: true });
}));

smsUserRoutes.get('/groups', handle(async (c) => {
  const shopId = getShopId(c);
  const rows = await reseller.listGroups(shopId);
  return c.json({ success: true, data: rows });
}));

smsUserRoutes.post('/groups', handle(async (c) => {
  const shopId = getShopId(c);
  const { name } = await c.req.json();
  if (!name) return c.json({ success: false, error: 'Group name is required' }, 400);
  const row = await reseller.addGroup(shopId, name);
  return c.json({ success: true, data: row }, 201);
}));

smsUserRoutes.get('/customers', handle(async (c) => {
  const shopId = getShopId(c);
  const rows = await reseller.listCustomerPhones(shopId);
  return c.json({ success: true, data: rows });
}));

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

smsUserRoutes.get('/campaigns', handle(async (c) => {
  const shopId = getShopId(c);
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const result = await reseller.listUserCampaigns(shopId, page, limit);
  return c.json({ success: true, ...result });
}));

smsUserRoutes.post('/campaigns', handle(async (c) => {
  const shopId = getShopId(c);
  const userId = c.get('userId');
  const body = await c.req.json();
  if (!body.name || !body.message) return c.json({ success: false, error: 'Campaign name and message are required' }, 400);
  const row = await reseller.createUserCampaign(shopId, body, userId);
  return c.json({ success: true, data: row }, 201);
}));

smsUserRoutes.post('/campaigns/:id/send', handle(async (c) => {
  const shopId = getShopId(c);
  const result = await reseller.sendUserCampaignNow(shopId, c.req.param('id'));
  return c.json({ success: true, data: result });
}));

smsUserRoutes.post('/campaigns/:id/cancel', handle(async (c) => {
  const shopId = getShopId(c);
  const row = await reseller.cancelUserCampaign(shopId, c.req.param('id'));
  return c.json({ success: true, data: row });
}));

smsUserRoutes.delete('/campaigns/:id', handle(async (c) => {
  const shopId = getShopId(c);
  await reseller.deleteUserCampaign(shopId, c.req.param('id'));
  return c.json({ success: true });
}));

// ─── AI GENERATOR ────────────────────────────────────────────────────────────

smsUserRoutes.post('/generate-ai', handle(async (c) => {
  const body = await c.req.json();
  const result = await reseller.generateMarketingSms(body);
  return c.json({ success: true, data: result });
}));

// ─── TRANSACTIONS / PURCHASES ────────────────────────────────────────────────

smsUserRoutes.get('/transactions', handle(async (c) => {
  const shopId = getShopId(c);
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const result = await reseller.listShopTransactions(shopId, page, limit);
  return c.json({ success: true, ...result });
}));

smsUserRoutes.get('/purchases', handle(async (c) => {
  const shopId = getShopId(c);
  await reseller.reconcileShopPurchases(shopId);
  const r = await poolQueryPurchases(shopId);
  return c.json({ success: true, data: r.rows });
}));

smsUserRoutes.post('/buy', handle(async (c) => {
  const shopId = getShopId(c);
  const user = { name: c.get('user')?.name, email: c.get('user')?.email };
  const { credits, phone } = await c.req.json();
  if (!credits || credits < 1) return c.json({ success: false, error: 'Enter a valid number of SMS credits' }, 400);
  if (!phone) return c.json({ success: false, error: 'Phone number is required for M-Pesa payment' }, 400);
  const result = await reseller.initiateSmsPurchase(shopId, credits, phone, user);
  return c.json({ success: true, data: { ...result, purchase: shopSafePurchase(result?.purchase) } });
}));

// AI assistant — suggest professional, compliant SMS drafts for the user.
smsUserRoutes.post('/ai-suggest', handle(async (c) => {
  const body = await c.req.json();
  const result = await reseller.aiSmsSuggestions(body);
  return c.json({ success: true, data: result });
}));

smsUserRoutes.get('/purchase/status', handle(async (c) => {
  const reference = c.req.query('reference');
  if (!reference) return c.json({ success: false, error: 'Reference is required' }, 400);
  // Reconcile the local record with the provider first so a purchase never stays
  // stuck as "pending" after the payment actually succeeded.
  const local = await reseller.reconcileSmsPurchase(reference);
  const safeLocal = shopSafePurchase(local);
  try {
    const status = await getPaymentStatus(reference);
    return c.json({ success: true, data: status, local: safeLocal });
  } catch (e: any) {
    // Snippe unreachable/rate-limited — fall back to our reconciled record so
    // the UI still shows completed instead of failing the poll request.
    if (local) return c.json({ success: true, data: { reference, status: local.status }, local: safeLocal });
    throw e;
  }
}));

// Re-send the USSD push when the customer says the payment prompt never
// arrived on their phone.
smsUserRoutes.post('/purchase/push', handle(async (c) => {
  const { reference } = await c.req.json();
  if (!reference) return c.json({ success: false, error: 'Reference is required' }, 400);
  const data = await triggerPaymentPush(reference);
  return c.json({ success: true, data });
}));

// ─── SHOP SETTINGS (auto SMS on sale etc.) ───────────────────────────────────

smsUserRoutes.get('/settings', handle(async (c) => {
  const shopId = getShopId(c);
  const settings = await reseller.getShopSmsSettings(shopId);
  return c.json({ success: true, data: settings });
}));

smsUserRoutes.put('/settings', handle(async (c) => {
  const shopId = getShopId(c);
  const body = await c.req.json();
  const settings = await reseller.saveShopSmsSettings(shopId, body);
  return c.json({ success: true, data: settings });
}));

async function poolQueryPurchases(shopId: string) {
  const { pool } = await import('../../config/drizzle.js');
  // Explicit shop-safe columns — never provider_cost / profit (developer-only).
  return pool.query(
    `SELECT id, credits, amount_tzs, price_per_sms, phone_number, status, created_at, paid_at, snippe_reference
     FROM sms_purchases WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [shopId]
  );
}

export default smsUserRoutes;
