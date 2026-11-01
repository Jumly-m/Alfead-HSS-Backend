import crypto from 'node:crypto';
import { pool } from '../config/drizzle.js';
import { sendSms, sendBulkSms, checkBalance } from './ehub-sms-adapter.service.js';

// ─── AI GENERATION ──────────────────────────────────────────────────────────

export async function generateAiMessage(prompt: string): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are ALFEAN ENTERPRISES (Hardware Store System) — a POS and business system in Tanzania.
Generate a short SMS message in Swahili (mix with English where natural).

Rules:
- Max 160 characters (1 SMS)
- Use sweet, attractive, marketing language — be warm, persuasive, and encouraging
- Friendly, clear, not pushy
- Include the business name if provided
- Always offer help: "Je tunaweza kukusaidia?" or "Pata msaada kwa simu 255775699545"

- Always sign "ALFEAN ENTERPRISES"
- Return ONLY valid JSON: {"message": "..."}`,
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    if (!response.ok) return null;
    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return parsed.message || null;
  } catch {
    return null;
  }
}

// ─── TRIAL EXPIRING SMS ─────────────────────────────────────────────────────

export async function sendTrialExpiringSms() {
  const tenants = await pool.query(`
    SELECT t.id, t.name, t.phone, t.trial_end,
      (SELECT u.phone FROM "user" u WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner') AND u.phone IS NOT NULL LIMIT 1) as user_phone
    FROM tenants t
    WHERE t.trial_activated = true
      AND t.trial_end > NOW()
      AND t.trial_end <= NOW() + INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM tenant_subscriptions ts
        WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()
      )
    ORDER BY t.trial_end ASC
  `);

  let sent = 0;
  for (const tenant of tenants.rows) {
    const phone = tenant.user_phone || tenant.phone;
    if (!phone) continue;

    const daysLeft = Math.ceil((new Date(tenant.trial_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const aiPrompt = `Generate a sweet, attractive marketing SMS reminder in Swahili for ${tenant.name}. Their ALFEAN ENTERPRISES free trial ends in ${daysLeft} days. Use warm, persuasive language to encourage them to subscribe. Include the simu link.`;

    let message = await generateAiMessage(aiPrompt);
    if (!message) {
      message = `Habari ${tenant.name}, trial yako ya ALFEAN ENTERPRISES inaisha siku ${daysLeft}. Jiandikishe sasa kuendelea. Je tunaweza kukusaidia? Piga 255775699545 au piga 255775699545. - ALFEAN ENTERPRISES`;
    }

    const result = await sendSms(phone, message, tenant.id);
    if (result.success) sent++;
  }

  return { sent, total: tenants.rows.length };
}

// ─── SUBSCRIPTION EXPIRING SMS ──────────────────────────────────────────────

export async function sendSubscriptionExpiringSms() {
  const subs = await pool.query(`
    SELECT ts.id, ts.current_period_end, t.id as tenant_id, t.name, t.phone,
      (SELECT u.phone FROM "user" u WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner') AND u.phone IS NOT NULL LIMIT 1) as user_phone,
      sp.name as plan_name
    FROM tenant_subscriptions ts
    JOIN tenants t ON t.id = ts.tenant_id
    JOIN subscription_plans sp ON sp.id = ts.plan_id
    WHERE ts.status = 'active'
      AND ts.current_period_end > NOW()
      AND ts.current_period_end <= NOW() + INTERVAL '3 days'
  `);

  let sent = 0;
  for (const sub of subs.rows) {
    const phone = sub.user_phone || sub.phone;
    if (!phone) continue;

    const daysLeft = Math.ceil((new Date(sub.current_period_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const aiPrompt = `Generate a sweet, attractive marketing SMS reminder in Swahili for ${sub.name}. Their ALFEAN ENTERPRISES ${sub.plan_name} subscription ends in ${daysLeft} days. Use warm, persuasive language to encourage renewal. Include the simu link.`;

    let message = await generateAiMessage(aiPrompt);
    if (!message) {
      message = `Habari ${sub.name}, usajili wako wa ALFEAN ENTERPRISES (${sub.plan_name}) unaisha siku ${daysLeft}. Lipia kuendelea. Je tunaweza kukusaidia? Piga 255775699545 au piga 255775699545. - ALFEAN ENTERPRISES`;
    }

    const result = await sendSms(phone, message, sub.tenant_id);
    if (result.success) sent++;
  }

  return { sent, total: subs.rows.length };
}

// ─── PAYMENT THANKS SMS ─────────────────────────────────────────────────────

export async function sendPaymentThanksSms(opts: {
  tenantId: string;
  tenantName: string;
  phone: string;
  planName: string;
  amountPaid: number;
  endDate: Date;
}) {
  const { tenantId, tenantName, phone, planName, amountPaid, endDate } = opts;
  if (!phone) return { success: false, error: 'No phone number' };

  const endStr = endDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const aiPrompt = `Generate a sweet, attractive congratulatory SMS in Swahili welcoming ${tenantName} who just paid TZS ${amountPaid.toLocaleString()} for ALFEAN ENTERPRISES ${planName}. Use warm, persuasive marketing language. Congratulate them, say their subscription is active until ${endStr}, and offer help via simu to get started with the system. Include the simu link.`;

  let message = await generateAiMessage(aiPrompt);
  if (!message) {
    message = `Karibu ${tenantName}! Malipo yako ya ALFEAN ENTERPRISES ${planName} (TZS ${amountPaid.toLocaleString()}) yamekubaliwa. Usajili wako unaisha ${endStr}. Je tunaweza kukusaidia kuanza? Piga 255775699545 au piga 255775699545. - ALFEAN ENTERPRISES`;
  }

  return sendSms(phone, message, tenantId);
}

// ─── PAYMENT FAILED SMS ─────────────────────────────────────────────────────

export async function sendPaymentFailedSms(opts: {
  tenantId: string;
  tenantName: string;
  phone: string;
  planName: string;
  amountPaid?: number;
}) {
  const { tenantId, tenantName, phone, planName, amountPaid } = opts;
  if (!phone) return { success: false, error: 'No phone number' };

  const amountStr = amountPaid ? `TZS ${amountPaid.toLocaleString()}` : '';
  const aiPrompt = `Generate a sweet, attractive marketing SMS in Swahili for ${tenantName} telling them their ALFEAN ENTERPRISES ${planName} payment ${amountStr} failed. Use warm, persuasive language to encourage them to try again. Offer help to pay via simu. Include the simu link.`;
  let message = await generateAiMessage(aiPrompt);
  if (!message) {
    message = `Habari ${tenantName}, malipo yako ya ALFEAN ENTERPRISES ${planName} ${amountStr} hayakufanikiwa. Je tunaweza kukusaidia kulipa? Piga 255775699545 au piga 255775699545. - ALFEAN ENTERPRISES`;
  }
  return sendSms(phone, message, tenantId);
}

// ─── MANUAL SEND (admin) ────────────────────────────────────────────────────

export async function sendManualSms(phone: string, message: string, tenantId?: string) {
  return sendSms(phone, message, tenantId);
}

// ─── BULK SEND (admin) ──────────────────────────────────────────────────────

export async function sendBulkManualSms(phones: string[], message: string) {
  return sendBulkSms(phones, message);
}

// ─── BROADCAST (developer → selected audience) ────────────────────────────────
// Lets the developer advertise new features / SMS packages inside the system by
// sending one SMS to an audience:
//   all              — every shop owner/admin user (default)
//   approved_senders — only shops that have an approved own Sender ID, to
//                      encourage them to start using the SMS service
// Re-sending the exact same message is blocked so a double-click can never
// flood recipients with duplicated SMS.

export type BroadcastAudience = 'all' | 'approved_senders';

export async function getBroadcastRecipients(audience: BroadcastAudience = 'all'): Promise<string[]> {
  let rows: any[] = [];
  if (audience === 'approved_senders') {
    // Owner/admin users of shops with at least one APPROVED own sender ID
    // (the ALFEAN ENTERPRISES system sender never counts). Matched via user_shops membership
    // or the tenant-level owner for legacy shops.
    const r = await pool.query(`
      SELECT u.phone, u.email
      FROM "user" u
      WHERE u.role IN ('admin','owner') AND u.phone IS NOT NULL AND u.phone <> ''
        AND (
          EXISTS (
            SELECT 1 FROM user_shops us
            JOIN sms_sender_ids s ON s.shop_id = us.shop_id
            WHERE us.user_id = u.id AND s.is_system = false AND s.status = 'approved'
          )
          OR EXISTS (
            SELECT 1 FROM shops sh
            JOIN sms_sender_ids s ON s.shop_id = sh.id
            WHERE sh.tenant_id::text = u.tenant_id AND s.is_system = false AND s.status = 'approved'
          )
        )
    `);
    rows = r.rows;
  } else {
    const r = await pool.query(`
      SELECT phone FROM (
        SELECT u.phone, u.email, row_number() OVER (PARTITION BY COALESCE(NULLIF(u.phone,''), u.email) ORDER BY u.created_at) AS rn
        FROM "user" u
        WHERE u.role IN ('admin','owner') AND u.phone IS NOT NULL AND u.phone <> ''
      ) t WHERE t.rn = 1
    `);
    rows = r.rows;
  }
  const phones = rows.map((x: any) => String(x.phone || '').replace(/[^0-9+]/g, '')).filter((p) => /^(\+?255|0)[0-9]{9}$/.test(p));
  return [...new Set(phones)];
}

export async function generateBroadcastMessage(topic: string): Promise<string | null> {
  const prompt = `Topic: ${topic}. Generate a single promotional announcement SMS in Swahili telling ALFEAN ENTERPRISES users about a new feature or SMS package. Keep it under 160 characters, warm and persuasive, offer help via simu, include the simu link 255775699545, and sign "ALFEAN ENTERPRISES".`;
  return generateAiMessage(prompt);
}

const activeBroadcasts = new Map<string, { total: number; sent: number; status: string; error?: string }>();

export async function startBroadcast(message: string, createdBy?: string, audience: BroadcastAudience = 'all') {
  const trimmed = String(message || '').trim();
  if (!trimmed) return { success: false, error: 'Message is required' };

  const normalizedAudience: BroadcastAudience = audience === 'approved_senders' ? 'approved_senders' : 'all';
  const messageHash = crypto.createHash('sha256').update(trimmed).digest('hex');
  const recipients = await getBroadcastRecipients(normalizedAudience);
  if (recipients.length === 0) return { success: false, error: 'No recipients found' };

  // Dedup guard: block an identical message that was already sent recently
  // (or is currently still running) so the same SMS cannot be broadcast twice.
  const dup = await pool.query(
    `SELECT id, status, recipient_count, sent_count, created_at FROM sms_broadcasts
     WHERE message_hash = $1 AND (status = 'running' OR created_at > NOW() - INTERVAL '24 hours')
     ORDER BY created_at DESC LIMIT 1`,
    [messageHash]
  );
  if (dup.rows.length > 0) {
    const d = dup.rows[0];
    if (d.status === 'running') {
      return { success: false, error: `Broadcast already in progress (${d.sent_count}/${d.recipient_count} sent). Wait for it to finish — it may still be sending.` };
    }
    return { success: false, error: `This exact message was already broadcast ${d.recipient_count} recipients recently. Duplicate sends are blocked to avoid flooding users.` };
  }

  const inserted = await pool.query(
    `INSERT INTO sms_broadcasts (message, message_hash, recipient_count, created_by, status, audience)
     VALUES ($1, $2, $3, $4, 'running', $5)
     RETURNING id`,
    [trimmed, messageHash, recipients.length, createdBy || null, normalizedAudience]
  );
  const broadcastId = inserted.rows[0].id as string;
  activeBroadcasts.set(broadcastId, { total: recipients.length, sent: 0, status: 'running' });

  // Fire and forget: send in chunks so the HTTP call returns instantly with the
  // broadcast id, and progress can be polled via /broadcast/:id/progress.
  (async () => {
    try {
      const result = await sendBulkSms(recipients, trimmed);
      const sent = result?.queued ?? (result?.success ? recipients.length : 0);
      activeBroadcasts.set(broadcastId, { total: recipients.length, sent, status: result?.success ? 'completed' : 'failed', error: result?.errors?.[0] });
      await pool.query(
        `UPDATE sms_broadcasts SET status = $1, sent_count = $2, completed_at = NOW(), error = $3 WHERE id = $4`,
        [result?.success ? 'completed' : 'failed', sent, result?.errors?.[0] || null, broadcastId]
      );
      console.log(`[SMS-Broadcast] ${broadcastId} → ${result?.success ? 'completed' : 'failed'} (${sent}/${recipients.length})`);
    } catch (e: any) {
      activeBroadcasts.set(broadcastId, { total: recipients.length, sent: 0, status: 'failed', error: e.message });
      await pool.query(`UPDATE sms_broadcasts SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`, [e.message, broadcastId]);
    }
  })();

  return { success: true, broadcastId, recipients: recipients.length };
}

export async function getBroadcastProgress(broadcastId: string) {
  const live = activeBroadcasts.get(broadcastId);
  if (live) return { success: true, ...live, live: true };
  const r = await pool.query(
    `SELECT status, recipient_count as total, sent_count as sent, error, created_at, completed_at FROM sms_broadcasts WHERE id = $1`,
    [broadcastId]
  );
  if (r.rows.length === 0) return { success: false, error: 'Broadcast not found' };
  const row = r.rows[0];
  return { success: true, total: row.total, sent: row.sent, status: row.status, error: row.error, created_at: row.created_at, completed_at: row.completed_at, live: false };
}

export async function getBroadcastHistory(limit = 10) {
  try {
    const r = await pool.query(
      `SELECT id, message, recipient_count, sent_count, status, error, created_by, created_at, completed_at,
              COALESCE(audience, 'all') as audience
       FROM sms_broadcasts ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows;
  } catch (e: any) {
    // Older DBs without the audience column (self-heals on next boot) —
    // retry without it instead of returning a 500.
    if (String(e.message || '').includes('audience')) {
      try {
        const r = await pool.query(
          `SELECT id, message, recipient_count, sent_count, status, error, created_by, created_at, completed_at
           FROM sms_broadcasts ORDER BY created_at DESC LIMIT $1`,
          [limit]
        );
        return r.rows.map((row: any) => ({ ...row, audience: 'all' }));
      } catch { /* fall through */ }
    }
    // Table may not exist yet on older DBs — return empty history instead of a 500.
    if (String(e.message || '').includes('does not exist')) return [];
    throw e;
  }
}

// ─── BALANCE ────────────────────────────────────────────────────────────────

export async function getSmsBalance() {
  return checkBalance();
}

// ─── HISTORY ────────────────────────────────────────────────────────────────

export async function getSmsHistory(page = 1, limit = 50, opts: { status?: string; q?: string } = {}) {
  const offset = (page - 1) * limit;
  const where: string[] = [];
  const params: any[] = [];
  if (opts.status && opts.status !== 'all') {
    params.push(opts.status);
    where.push(`sl.status = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    where.push(`(sl.phone ILIKE $${params.length} OR sl.message ILIKE $${params.length} OR t.name ILIKE $${params.length} OR COALESCE(sl.error_message, '') ILIKE $${params.length})`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM sms_log sl LEFT JOIN tenants t ON t.id = sl.tenant_id ${whereSql}`,
    params
  );
  const total = parseInt(countResult.rows[0].count);

  const result = await pool.query(`
    SELECT sl.*, t.name as tenant_name
    FROM sms_log sl
    LEFT JOIN tenants t ON t.id = sl.tenant_id
    ${whereSql}
    ORDER BY sl.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  return { data: result.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// ─── INACTIVE USER REMINDER SMS ────────────────────────────────────────────

export async function sendInactiveReminderSms(days: number = 7) {
  const tenants = await pool.query(`
    SELECT DISTINCT ON (t.id)
      t.id as tenant_id, t.name as tenant_name, t.phone as tenant_phone,
      u.name as user_name, u.email, u.phone as user_phone,
      u.last_login_at
    FROM "user" u
    JOIN tenants t ON t.id::text = u.tenant_id
    WHERE u.role IN ('admin', 'owner')
      AND (u.last_login_at IS NULL OR u.last_login_at < NOW() - ($1 || ' days')::INTERVAL)
      AND (u.phone IS NOT NULL OR t.phone IS NOT NULL)
    ORDER BY t.id, u.last_login_at DESC NULLS LAST
  `, [String(days)]);

  let sent = 0;
  const errors: string[] = [];

  for (const tenant of tenants.rows) {
    const phone = tenant.user_phone || tenant.phone;
    if (!phone) continue;

    const daysAgo = tenant.last_login_at
      ? Math.floor((Date.now() - new Date(tenant.last_login_at).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const aiPrompt = `Generate a sweet, attractive re-engagement SMS in Swahili for ${tenant.tenant_name || tenant.user_name || 'Mteja'} who hasn't used ALFEAN ENTERPRISES in ${daysAgo ? `${daysAgo} days` : 'a while'}. Warmly remind them about the great features: easy POS, inventory management, debts tracking, sales reports. Encourage them to come back and use the system. Offer help via simu. Include the simu link. Max 160 characters.`;

    let message = await generateAiMessage(aiPrompt);
    if (!message) {
      const name = tenant.tenant_name || tenant.user_name || 'Mteja';
      message = `Habari ${name}! Tunakukumbusha kurudi ALFEAN ENTERPRISES. Tumia POS yetu, simamia bidhaa, madeni na mauzo kwa urahisi. Tuko tayari kukusaidia. Piga 255775699545. - ALFEAN ENTERPRISES`;
    }

    const result = await sendSms(phone, message, tenant.tenant_id);
    if (result.success) sent++;
    else errors.push(`${phone}: ${result.error}`);
  }

  return { sent, total: tenants.rows.length, errors: errors.length > 0 ? errors : undefined };
}
