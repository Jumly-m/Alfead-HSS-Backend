import crypto from 'node:crypto';
import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import * as ehub from '../../services/ehub-sms.service.js';
import {
  generateAiMessage,
  sendManualSms,
  sendBulkManualSms,
  getSmsBalance,
  getSmsHistory,
  getBroadcastRecipients,
  generateBroadcastMessage,
  startBroadcast,
  getBroadcastProgress,
  getBroadcastHistory,
} from '../../services/sms.service.js';
import * as reseller from '../../services/sms-reseller.service.js';
import { getSmsAutomationSettings, saveSmsAutomationSettings, SMS_AUTOMATION_JOBS } from '../../services/sms-automation.service.js';

const smsRoutes = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();

smsRoutes.use('/*', authMiddleware);

const requireAdmin = async (c: any, next: any) => {
  const role = c.get('userRole');
  if (role !== 'developer') return c.json({ success: false, error: 'Forbidden' }, 403);
  await next();
};
smsRoutes.use('/*', requireAdmin);

// Send SMS to one recipient
smsRoutes.post('/send', async (c) => {
  try {
    const { phone, message, tenantId } = await c.req.json();
    if (!phone || !message) {
      return c.json({ success: false, error: 'Phone and message are required' }, 400);
    }
    const result = await sendManualSms(phone, message, tenantId || null);
    return c.json({ success: result.success, data: result, message: result.success ? 'SMS sent' : 'Failed to send SMS' }, result.success ? 200 : 400);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Send payment follow-up SMS (AI-generated Swahili with simu link)
smsRoutes.post('/send-payment-followup', async (c) => {
  try {
    const { phone, tenantName, planName, amountTzs, type } = await c.req.json();
    if (!phone) return c.json({ success: false, error: 'Phone is required' }, 400);

    const name = tenantName || 'Mteja';
    const plan = planName || 'usajili';
    const amount = (amountTzs || 0).toLocaleString();
    let message: string;

    if (type === 'failed') {
      const aiPrompt = `Generate a sweet, attractive marketing SMS in Swahili for ${name} telling them their ALFEAN ENTERPRISES ${plan} payment TZS ${amount} failed. Use warm, persuasive language to encourage them to try again. Offer help to pay again via simu. Include the simu link.`;
      message = (await generateAiMessage(aiPrompt)) || `Habari ${name}, malipo yako ya ALFEAN ENTERPRISES ${plan} (TZS ${amount}) hayakufanikiwa. Je tunaweza kukusaidia kulipa? Piga 255775699545 au piga 255775699545. - ALFEAN ENTERPRISES`;
    } else {
      const aiPrompt = `Generate a sweet, attractive marketing SMS in Swahili for ${name} reminding them their ALFEAN ENTERPRISES ${plan} payment TZS ${amount} is still pending. Use warm, persuasive language to encourage payment. Offer help to complete payment via simu. Include the simu link.`;
      message = (await generateAiMessage(aiPrompt)) || `Habari ${name}, malipo yako ya ALFEAN ENTERPRISES ${plan} (TZS ${amount}) bado hayajathibitishwa. Je tunaweza kukusaidia? Piga 255775699545 au piga 255775699545. - ALFEAN ENTERPRISES`;
    }

    const result = await sendManualSms(phone, message, undefined);
    return c.json({ success: result.success, data: { ...result, message }, message: result.success ? 'SMS sent' : 'Failed to send SMS' }, result.success ? 200 : 400);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Bulk SMS
smsRoutes.post('/bulk', async (c) => {
  try {
    const { phones, message } = await c.req.json();
    if (!phones?.length || !message) {
      return c.json({ success: false, error: 'Phones array and message are required' }, 400);
    }
    const result = await sendBulkManualSms(phones, message);
    return c.json({ success: result.success, data: result }, result.success ? 200 : 400);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Check SMS balance + today stats
smsRoutes.get('/balance', async (c) => {
  try {
    const result = await getSmsBalance();
    // Get today's usage stats
    const todayCount = await pool.query(
      `SELECT COUNT(*) as count FROM sms_log WHERE created_at >= CURRENT_DATE`
    );
    const totalSent = await pool.query('SELECT COUNT(*) as count FROM sms_log');
    const totalFailed = await pool.query("SELECT COUNT(*) as count FROM sms_log WHERE status = 'failed'");
    return c.json({
      success: true,
      data: {
        ...result,
        todaySent: parseInt(todayCount.rows[0].count),
        totalSent: parseInt(totalSent.rows[0].count),
        totalFailed: parseInt(totalFailed.rows[0].count),
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// SMS history (system sms_log). Filters: ?status=&q=&page=&limit=
smsRoutes.get('/history', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const status = c.req.query('status') || undefined;
    const q = c.req.query('q') || undefined;
    const result = await getSmsHistory(page, limit, { status, q });
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Trigger trial expiry SMS manually
smsRoutes.post('/trigger/trial-expiry', async (c) => {
  try {
    const { sendTrialExpiringSms } = await import('../../services/sms.service.js');
    const result = await sendTrialExpiringSms();
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Trigger subscription expiry SMS manually
smsRoutes.post('/trigger/subscription-expiry', async (c) => {
  try {
    const { sendSubscriptionExpiringSms } = await import('../../services/sms.service.js');
    const result = await sendSubscriptionExpiringSms();
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Trigger inactive user reminder SMS
smsRoutes.post('/trigger/inactive-reminder', async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '7');
    const { sendInactiveReminderSms } = await import('../../services/sms.service.js');
    const result = await sendInactiveReminderSms(days);
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Send custom SMS to a specific tenant with AI-generated message
smsRoutes.post('/generate-and-send', async (c) => {
  try {
    const { tenantId, phone, messageType } = await c.req.json();
    if (!tenantId) return c.json({ success: false, error: 'tenantId is required' }, 400);

    const tenantResult = await pool.query(`
      SELECT t.id, t.name, t.phone, t.trial_end, t.trial_activated,
        (SELECT u.phone FROM "user" u WHERE u.tenant_id = t.id::text AND u.role IN ('admin','owner') AND u.phone IS NOT NULL LIMIT 1) as user_phone
      FROM tenants t WHERE t.id = $1
    `, [tenantId]);

    if (tenantResult.rows.length === 0) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }

    const tenant = tenantResult.rows[0];
    const targetPhone = phone || tenant.user_phone || tenant.phone;
    if (!targetPhone) return c.json({ success: false, error: 'No phone number for this tenant' }, 400);

    const { generateAiMessage } = await import('../../services/sms.service.js');
    let prompt: string;
    let fallback: string;

    if (messageType === 'trial_ending') {
      const daysLeft = tenant.trial_end
        ? Math.ceil((new Date(tenant.trial_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 7;
      prompt = `Generate a sweet, attractive marketing SMS reminder in Swahili for ${tenant.name}. Their ALFEAN ENTERPRISES free trial ends in ${daysLeft} days. Use warm, persuasive language to encourage subscription.`;
      fallback = `Habari ${tenant.name}, trial yako ya ALFEAN ENTERPRISES inaisha siku ${daysLeft}. Jiandikishe sasa kuendelea. Msaada: 255775699545. - ALFEAN ENTERPRISES`;
    } else if (messageType === 'reminder') {
      prompt = `Generate a sweet, attractive marketing SMS in Swahili for ${tenant.name} reminding them to subscribe to ALFEAN ENTERPRISES. They haven't paid yet. Use warm, persuasive language and offer help to get started.`;
      fallback = `Habari ${tenant.name}, bado hujajiandikisha kwa ALFEAN ENTERPRISES. Tuko tayari kukusaidia kuanza. Wasiliana nasi 255775699545. - ALFEAN ENTERPRISES`;
    } else {
      prompt = `Generate a sweet, attractive marketing SMS in Swahili for ${tenant.name} about ALFEAN ENTERPRISES POS system. Use warm, persuasive language and offer help to get started.`;
      fallback = `Habari ${tenant.name}, karibu ALFEAN ENTERPRISES! Tuko hapa kukusaidia na mfumo wako. Wasiliana nasi 255775699545. - ALFEAN ENTERPRISES`;
    }

    let message = await generateAiMessage(prompt);
    if (!message) message = fallback;

    const result = await sendManualSms(targetPhone, message, tenantId);
    return c.json({ success: result.success, data: { ...result, message, phone: targetPhone } }, result.success ? 200 : 400);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── AI MARKETING SMS GENERATOR ────────────────────────────────────────────
smsRoutes.post('/generate-marketing', async (c) => {
  try {
    const { topic, targetAudience, businessName } = await c.req.json();
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({
        success: true,
        data: { message: `Habari! Karibu ALFEAN ENTERPRISES. Boresha biashara yako na ALFEAN ENTERPRISES POS - mfumo mahiri wa mauzo na usimamizi. Wasiliana nasi leo! - ALFEAN ENTERPRISES` }
      });
    }

    const prompt = `Generate a sweet, attractive marketing SMS in Swahili for ALFEAN ENTERPRISES POS system. Use warm, persuasive language.` +
      (topic ? ` Topic: ${topic}.` : '') +
      (targetAudience ? ` Target: ${targetAudience}.` : '') +
      (businessName ? ` Business: ${businessName}.` : '') +
      ` Max 160 characters. Include a call to action. Sign as "ALFEAN ENTERPRISES". Return ONLY JSON: {"message": "..."}`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a marketing copywriter for ALFEAN ENTERPRISES POS in Tanzania. Generate short Swahili SMS ads under 160 chars. Return ONLY JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.8,
      })
    });

    if (!response.ok) {
      return c.json({ success: true, data: { message: 'ALFEAN ENTERPRISES POS - Boresha biashara yako! Lipia kwa mwezi kuanzia TZS 15,000. Wasiliana nasi leo. - ALFEAN ENTERPRISES' } });
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return c.json({ success: true, data: { message: parsed.message || '' } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── SMS CAMPAIGNS ─────────────────────────────────────────────────────────
smsRoutes.get('/campaigns', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;
    const countResult = await pool.query('SELECT COUNT(*) FROM sms_campaigns');
    const total = parseInt(countResult.rows[0].count);
    const result = await pool.query(
      'SELECT * FROM sms_campaigns ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return c.json({
      success: true,
      data: result.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.post('/campaigns', async (c: any) => {
  try {
    const adminId = c.get('userId');
    const { title, message, recipient_type, scheduled_at } = await c.req.json();
    if (!title || !message) return c.json({ success: false, error: 'Title and message are required' }, 400);

    // Count estimated recipients
    let count = 0;
    if (recipient_type === 'all' || recipient_type === 'non_paying') {
      const r = await pool.query(`
        SELECT COUNT(*) FROM tenants t
        LEFT JOIN "user" u ON u.tenant_id = t.id::text AND u.role IN ('admin','owner')
        WHERE (u.phone IS NOT NULL OR t.phone IS NOT NULL)
          AND ${recipient_type === 'non_paying' ? `NOT EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW())` : '1=1'}
      `);
      count = parseInt(r.rows[0].count);
    } else if (recipient_type === 'trial_expiring') {
      const r = await pool.query(`
        SELECT COUNT(*) FROM tenants t
        LEFT JOIN "user" u ON u.tenant_id = t.id::text AND u.role IN ('admin','owner')
        WHERE (u.phone IS NOT NULL OR t.phone IS NOT NULL)
          AND t.trial_activated = true AND t.trial_end > NOW() AND t.trial_end <= NOW() + INTERVAL '7 days'
      `);
      count = parseInt(r.rows[0].count);
    }

    const result = await pool.query(`
      INSERT INTO sms_campaigns (title, message, recipient_type, recipient_count, status, scheduled_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [title, message, recipient_type || 'all', count, scheduled_at ? 'scheduled' : 'draft', scheduled_at || null, adminId]);

    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

smsRoutes.post('/campaigns/:id/send', async (c: any) => {
  try {
    const campaignId = c.req.param('id');
    const campaignResult = await pool.query(`SELECT * FROM sms_campaigns WHERE id = $1`, [campaignId]);
    if (campaignResult.rows.length === 0) return c.json({ success: false, error: 'Campaign not found' }, 404);
    const campaign = campaignResult.rows[0];
    if (campaign.status === 'sent') return c.json({ success: false, error: 'Campaign already sent' }, 400);

    // Get recipient phones
    let phones: string[] = [];
    if (campaign.recipient_type === 'all' || campaign.recipient_type === 'non_paying') {
      const r = await pool.query(`
        SELECT DISTINCT COALESCE(u.phone, t.phone) as phone FROM tenants t
        LEFT JOIN "user" u ON u.tenant_id = t.id::text AND u.role IN ('admin','owner')
        WHERE (u.phone IS NOT NULL OR t.phone IS NOT NULL)
          AND ${campaign.recipient_type === 'non_paying' ? `NOT EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW())` : '1=1'}
      `);
      phones = r.rows.map((row: any) => row.phone).filter(Boolean);
    } else if (campaign.recipient_type === 'trial_expiring') {
      const r = await pool.query(`
        SELECT DISTINCT COALESCE(u.phone, t.phone) as phone FROM tenants t
        LEFT JOIN "user" u ON u.tenant_id = t.id::text AND u.role IN ('admin','owner')
        WHERE (u.phone IS NOT NULL OR t.phone IS NOT NULL)
          AND t.trial_activated = true AND t.trial_end > NOW() AND t.trial_end <= NOW() + INTERVAL '7 days'
      `);
      phones = r.rows.map((row: any) => row.phone).filter(Boolean);
    }

    if (phones.length === 0) {
      await pool.query(`UPDATE sms_campaigns SET status = 'failed', sent_at = NOW() WHERE id = $1`, [campaignId]);
      return c.json({ success: false, error: 'No recipients found' }, 400);
    }

    // Send bulk
    const { sendBulkSms } = await import('../../services/ehub-sms-adapter.service.js');
    const result = await sendBulkSms(phones, campaign.message);

    await pool.query(`
      UPDATE sms_campaigns SET status = $1, sent_count = $2, failed_count = $3, sent_at = NOW() WHERE id = $4
    `, [
      result.success ? 'sent' : 'failed',
      result.queued || 0,
      result.success ? 0 : phones.length,
      campaignId
    ]);

    return c.json({ success: true, data: { ...result, totalPhones: phones.length } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.post('/campaigns/:id/cancel', async (c: any) => {
  try {
    const id = c.req.param('id');
    await pool.query(`UPDATE sms_campaigns SET status = 'cancelled' WHERE id = $1 AND status = 'scheduled'`, [id]);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── RESELLER CONTROL (SMS Control in developer panel) ───────────────────────

smsRoutes.get('/reseller/overview', async (c) => {
  try {
    const overview = await reseller.getDeveloperOverview();
    return c.json({ success: true, data: overview });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Live provider connection test: proves key + secret + HMAC signing + clock
// sync + network in one call and reports latency, wallet and rate-limit
// headroom. Powers the "Test connection" button in SMS Reseller Control.
smsRoutes.get('/reseller/provider-test', async (c) => {
  try {
    const [test, status] = await Promise.all([ehub.testConnection(), Promise.resolve(ehub.ehubStatus())]);
    return c.json({ success: true, data: { ...test, ...status } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.get('/reseller/settings', async (c) => {
  try {
    const settings = await reseller.getResellerSettings();
    return c.json({ success: true, data: settings });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.put('/reseller/settings', async (c: any) => {
  try {
    const body = await c.req.json();
    const settings = await reseller.saveResellerSettings(body);
    return c.json({ success: true, data: settings });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── AUTOMATED SMS CONTROL (developer kill switches) ─────────────────────────
// Stop/pause any automatic or marketing SMS+email send. Manual sends, the
// "Test/Trigger now" buttons, broadcasts and shop SMS Centers are NOT affected.

smsRoutes.get('/automation', async (c) => {
  try {
    const settings = await getSmsAutomationSettings();
    return c.json({
      success: true,
      data: { settings, jobs: SMS_AUTOMATION_JOBS },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.put('/automation', async (c: any) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const settings = await saveSmsAutomationSettings(body || {});
    return c.json({
      success: true,
      data: settings,
      message: settings.master_enabled
        ? 'Automated SMS settings saved'
        : 'All automated SMS paused',
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: rewrite an auto-message template professionally using AI
smsRoutes.post('/reseller/rewrite-template', async (c) => {
  try {
    const { message, language, kind } = await c.req.json();
    if (!message) return c.json({ success: false, error: 'Message is required' }, 400);
    const result = await reseller.generateMarketingSms({
      message,
      language,
      businessName: 'ALFEAN ENTERPRISES',
    });
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.post('/reseller/sender-ids/:id/submit', async (c: any) => {
  try {
    const id = c.req.param('id');
    const row = await reseller.adminSubmitSenderId(id);
    return c.json({ success: true, data: row, message: 'Sender ID submitted to eHub for provider approval' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, e.status || 400);
  }
});

// Developer: get all sender IDs with applicant details (paginated, filterable)
smsRoutes.get('/reseller/sender-ids/all', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const status = c.req.query('status') || undefined;
    const result = await reseller.getAllSenderIds(page, limit, status);
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Live provider status for ALL sender IDs (reconciles DB statuses from eHub too)
// NOTE: must be registered before /reseller/sender-ids/:id so "live" isn't
// captured as an :id route parameter.
smsRoutes.get('/reseller/sender-ids/live', async (c) => {
  try {
    const rows = await reseller.getLiveSenderIdStatuses();
    return c.json({ success: true, data: rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Per-sender-ID SMS usage: today, this week (Mon → today) and this month
// (1st → today) in Tanzania time, plus all-time. Powers the registry columns.
smsRoutes.get('/reseller/sender-usage', async (c) => {
  try {
    const rows = await reseller.getSenderIdUsageStats();
    return c.json({ success: true, data: rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: get a single sender ID with full applicant details
smsRoutes.get('/reseller/sender-ids/:id', async (c: any) => {
  try {
    const id = c.req.param('id');
    const row = await reseller.getSenderIdById(id);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: row });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: reject a sender ID and notify the applicant via SMS + email.
// `reason` is the applicant-facing reason, `guidance` is the developer's
// "what to do" advice for the next application.
smsRoutes.post('/reseller/sender-ids/:id/reject', async (c: any) => {
  try {
    const id = c.req.param('id');
    const { reason, notifyApplicant, guidance } = await c.req.json().catch(() => ({}));
    const row = await reseller.adminRejectSenderId(id, reason, notifyApplicant !== false, guidance);
    return c.json({ success: true, data: row, message: 'Sender ID rejected and applicant notified' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Developer: save the applicant-facing rejection reason + "what to do" guidance
// without notifying (review first, notify later).
smsRoutes.patch('/reseller/sender-ids/:id/rejection', async (c: any) => {
  try {
    const id = c.req.param('id');
    const { reason, guidance } = await c.req.json().catch(() => ({}));
    const row = await reseller.adminUpdateSenderIdRejection(id, reason, guidance);
    return c.json({ success: true, data: row, message: 'Rejection details saved' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Developer: re-send the rejection notification (SMS + email) to the applicant
smsRoutes.post('/reseller/sender-ids/:id/notify-rejection', async (c: any) => {
  try {
    const id = c.req.param('id');
    const { reason, guidance } = await c.req.json().catch(() => ({}));
    const row = await reseller.notifySenderRejection(id, reason, guidance);
    return c.json({ success: true, data: row, message: 'Rejection notification sent to applicant' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Developer: (re)send the approval + "buy SMS" message (SMS + email) to the
// applicant of an approved sender ID. Marketing nudge: an approved brand only
// earns when the shop tops up SMS in the SMS Center and starts sending.
smsRoutes.post('/reseller/sender-ids/:id/notify-approval', async (c: any) => {
  try {
    const id = c.req.param('id');
    const row = await reseller.notifySenderApproval(id);
    const notification = (row as any).notification || {};
    const channels = [notification.sms && 'SMS', notification.email && 'email'].filter(Boolean).join(' + ');
    if (!notification.hasContact) {
      return c.json({ success: false, error: 'No applicant or shop contact (phone/email) on file for this sender ID' }, 400);
    }
    if (!channels) {
      return c.json({ success: false, error: 'Could not send — SMS provider/email service unavailable. Try again.' }, 502);
    }
    return c.json({ success: true, data: row, message: `Approval + buy-SMS message sent via ${channels}` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, e.status || 400);
  }
});

// Developer: resubmit a rejected sender ID (reset to pending)
smsRoutes.post('/reseller/sender-ids/:id/resubmit', async (c: any) => {
  try {
    const id = c.req.param('id');
    const row = await reseller.adminReopenSenderId(id);
    return c.json({ success: true, data: row, message: 'Sender ID reopened for resubmission' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── DEV/TEST TOOLS (skip provider, for onboarding testing) ───────────────────

smsRoutes.post('/reseller/sender-ids/:id/approve', async (c: any) => {
  try {
    const id = c.req.param('id');
    const row = await reseller.adminForceApproveSenderId(id);
    return c.json({ success: true, data: row, message: 'Sender ID approved (test)' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

smsRoutes.post('/reseller/sender-ids/:id/reopen', async (c: any) => {
  try {
    const id = c.req.param('id');
    const row = await reseller.adminReopenSenderId(id);
    return c.json({ success: true, data: row, message: 'Sender ID reset to pending (test)' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

smsRoutes.post('/reseller/test-credit', async (c: any) => {
  try {
    const { shop_id, credits } = await c.req.json();
    if (!shop_id) return c.json({ success: false, error: 'shop_id is required' }, 400);
    const qty = Math.max(1, Math.floor(Number(credits) || 0));
    await reseller.creditSmsAccount(shop_id, qty, 0, 0, 'test-credit');
    const account = await reseller.getShopAccount(shop_id);
    return c.json({ success: true, data: account, message: `Added ${qty} SMS credit(s) (test)` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: manual grant of SMS to a shop (auto-purchase failed but the shop
// paid manually). Credits land instantly; purchase + ledger rows keep reports
// correct. Body: { shop_id, credits, amount_tzs?, reference?, note? }
smsRoutes.post('/reseller/manual-credit', async (c: any) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const data = await reseller.manualGrantSmsCredits({
      shopId: body?.shop_id,
      credits: body?.credits,
      amountTzs: body?.amount_tzs,
      reference: body?.reference,
      note: body?.note,
    });
    try {
      const { logActivity } = await import('../../utils/activity-logger.js');
      await logActivity({
        userId: c.get('userId'),
        action: 'sms_manual_grant',
        entityType: 'shop',
        entityId: body?.shop_id,
        details: {
          credits: body?.credits, amount_tzs: body?.amount_tzs,
          reference: data.purchase?.snippe_reference, note: body?.note,
          duplicate: data.duplicate,
        },
        ipAddress: c.req.header('x-forwarded-for') || undefined,
        userAgent: c.req.header('user-agent') || undefined,
      });
    } catch { /* audit must never break the grant */ }
    return c.json({
      success: true,
      data,
      message: data.duplicate
        ? 'Already granted for this reference — no double credit'
        : `Granted ${body?.credits} SMS to shop`,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Developer: complete one stuck purchase (pending/failed) manually — marks it
// completed and credits the shop exactly once.
smsRoutes.post('/reseller/purchases/:id/complete', async (c: any) => {
  try {
    const data = await reseller.completePurchaseManually(c.req.param('id'));
    try {
      const { logActivity } = await import('../../utils/activity-logger.js');
      await logActivity({
        userId: c.get('userId'),
        action: 'sms_purchase_manual_complete',
        entityType: 'sms_purchase',
        entityId: c.req.param('id'),
        details: { credits: data.purchase?.credits, amount_tzs: data.purchase?.amount_tzs },
        ipAddress: c.req.header('x-forwarded-for') || undefined,
        userAgent: c.req.header('user-agent') || undefined,
      });
    } catch { /* audit must never break the grant */ }
    return c.json({
      success: true,
      data,
      message: data.alreadyCompleted ? 'Purchase was already completed' : 'Purchase completed and shop credited',
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Developer: correct a shop's SMS balance after an over/under grant.
// Body: { shop_id, mode: 'deduct' | 'set', credits?, balance?, reason? }
smsRoutes.post('/reseller/adjust-credit', async (c: any) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const data = await reseller.adjustSmsBalance({
      shopId: body?.shop_id,
      mode: body?.mode || 'deduct',
      credits: body?.credits,
      balance: body?.balance,
      reason: body?.reason,
    });
    try {
      const { logActivity } = await import('../../utils/activity-logger.js');
      await logActivity({
        userId: c.get('userId'),
        action: 'sms_balance_adjust',
        entityType: 'shop',
        entityId: body?.shop_id,
        details: {
          mode: body?.mode, credits: body?.credits, balance: body?.balance,
          reason: body?.reason, previousBalance: data.previousBalance,
          newBalance: data.newBalance, delta: data.delta,
        },
        ipAddress: c.req.header('x-forwarded-for') || undefined,
        userAgent: c.req.header('user-agent') || undefined,
      });
    } catch { /* audit must never break the adjustment */ }
    return c.json({
      success: true,
      data,
      message: data.noop
        ? 'No change — balance already at that value'
        : `Balance corrected: ${data.previousBalance} → ${data.newBalance} SMS`,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

smsRoutes.post('/reseller/sender-ids/sync', async (c) => {
  try {
    const result = await reseller.adminSyncSenderStatuses();
    return c.json({ success: true, data: result, message: `Synced ${result.synced} sender IDs from provider` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── LINK PROVIDER SENDER IDS TO SHOPS ──────────────────────────────────────
// Sender IDs approved directly on eHub have no ALFEAN ENTERPRISES row, so their shop sees
// "no sender ID". The developer links them here; the shop then sees them,
// can set one as default, and can choose per send.

smsRoutes.get('/reseller/provider-senders', async (c) => {
  try {
    const data = await reseller.getProviderSenderLinks();
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.post('/reseller/provider-senders/link', async (c: any) => {
  try {
    const { shop_id, sender_id, provider_id, purpose, status } = await c.req.json().catch(() => ({}));
    const row = await reseller.linkProviderSenderToShop({
      shopId: shop_id,
      senderId: sender_id,
      providerId: provider_id || null,
      purpose: purpose || null,
      status: status === 'pending' ? 'pending' : 'approved',
    });
    return c.json({ success: true, data: row, message: `Sender ID ${row.sender_id} linked as ${row.status}` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

smsRoutes.delete('/reseller/provider-senders/:rowId', async (c) => {
  try {
    const row = await reseller.unlinkProviderSender(c.req.param('rowId'));
    return c.json({ success: true, data: row, message: `Sender ID ${row.sender_id} unlinked` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

smsRoutes.get('/reseller/sender-ids', async (c) => {
  try {
    const r = await pool.query(`
      SELECT s.*, sh.name as shop_name
      FROM sms_sender_ids s JOIN shops sh ON sh.id = s.shop_id
      ORDER BY s.created_at DESC LIMIT 100
    `);
    return c.json({ success: true, data: r.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.get('/reseller/purchases', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = (page - 1) * limit;

    // Self-heal: reconcile stale pending purchases against the payment provider
    // BEFORE listing, so stuck rows update in real time instead of showing
    // "pending" forever when a webhook is missed. Capped at 5 per request.
    try {
      const stale = await pool.query(`
        SELECT snippe_reference FROM sms_purchases
        WHERE status = 'pending' AND created_at < NOW() - INTERVAL '2 minutes'
        ORDER BY created_at DESC LIMIT 5
      `);
      for (const s of stale.rows) {
        try { await reseller.reconcileSmsPurchase(s.snippe_reference); } catch { /* keep going */ }
      }
    } catch { /* reconciliation must never break the listing */ }

    const count = await pool.query(`SELECT COUNT(*) FROM sms_purchases`);
    const rows = await pool.query(`
      SELECT p.*, sh.name as shop_name
      FROM sms_purchases p JOIN shops sh ON sh.id = p.shop_id
      ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const total = parseInt(count.rows[0].count);
    return c.json({ success: true, data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Live provider float status (eHub wallet in SMS + TZS, low flag)
smsRoutes.get('/reseller/provider-wallet', async (c) => {
  try {
    const data = await reseller.getProviderWalletStatus();
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Force a low-balance check + alert now (for testing the SMS/email alert)
smsRoutes.post('/reseller/provider-wallet/check', async (c) => {
  try {
    const data = await reseller.checkProviderWalletAndAlert();
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Re-send one failed system SMS from the log (developer SMS Control)
smsRoutes.post('/reseller/sms/:id/resend', async (c: any) => {
  try {
    const data = await reseller.resendSmsLog(c.req.param('id'));
    return c.json({ success: true, data, message: 'SMS imetumwa tena' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Bulk retry of every failed system SMS (capped at 50 per run)
smsRoutes.post('/reseller/sms/resend-failed', async (c) => {
  try {
    const data = await reseller.resendAllFailedSms(50);
    return c.json({ success: true, data, message: `Zimetumwa tena ${data.sent}, zilizoshindikana ${data.failed}` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Run the daily sales report now (paid subscribers only). Used by the
// developer to force a real run: marks today as reported so the 22:00 cron
// does not duplicate. Pass ?test=1 to send without marking the day.
smsRoutes.post('/reseller/daily-report/trigger', async (c) => {
  try {
    const test = c.req.query('test') === '1' || c.req.query('test') === 'true';
    const { sendDailySalesReports } = await import('../../jobs/dailySalesReport.js');
    const data = await sendDailySalesReports({ markLog: !test });
    return c.json({
      success: true,
      data,
      message: test
        ? `TEST (haijaandikwa kama imetumwa): ${data.smsSent} SMS, ${data.emailsSent} email (${data.tenants} subscriber, ${data.shops} shop)`
        : `Ripoti: ${data.smsSent} SMS, ${data.emailsSent} email (${data.tenants} subscriber, ${data.shops} shop)`,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Preview ONE shop's report for today (no SMS/email sent). ?shop_id=
smsRoutes.get('/reseller/daily-report/preview', async (c) => {
  try {
    const shopId = c.req.query('shop_id');
    if (!shopId) return c.json({ success: false, error: 'shop_id is required' }, 400);
    const { buildDailyReportForShop } = await import('../../jobs/dailySalesReport.js');
    const preview = await buildDailyReportForShop(shopId);
    if (!preview) return c.json({ success: false, error: 'Shop not found' }, 404);
    return c.json({ success: true, data: preview });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Send ONE shop's report to ONE phone for testing (defaults to the shop owner).
// Never marks daily_report_log, so the real 22:00 report still goes out.
// Body: { shop_id, phone?, dry_run? }
smsRoutes.post('/reseller/daily-report/test', async (c: any) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const shopId = body?.shop_id || c.req.query('shop_id');
    if (!shopId) return c.json({ success: false, error: 'shop_id is required' }, 400);
    const { sendDailyReportTest } = await import('../../jobs/dailySalesReport.js');
    const data = await sendDailyReportTest({
      shopId,
      phone: body?.phone || c.req.query('phone') || undefined,
      dryRun: body?.dry_run === true,
    });
    return c.json({
      success: true,
      data,
      message: data.dryRun
        ? 'Preview tayari — hakuna SMS iliyotumwa'
        : data.sent
          ? `Test SMS imetumwa kwa ${data.to}`
          : `Test SMS haijafanikiwa${data.error ? `: ${data.error}` : ''}`,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Run the 5-day expiry invoice reminders now (normally 10:30 daily)
smsRoutes.post('/reseller/expiry-invoice/trigger', async (c) => {
  try {
    const { sendExpiryInvoiceReminders } = await import('../../jobs/expiryInvoiceReminder.js');
    const data = await sendExpiryInvoiceReminders();
    return c.json({
      success: true,
      data,
      message: `Expiry invoices: ${data.smsSent} SMS, ${data.emailsSent} email (${data.total} due)`,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Run today's promo 5-day blast now (normally 09:30 daily)
smsRoutes.post('/reseller/promo5day/trigger', async (c) => {
  try {
    const { sendPromo5DayBlast } = await import('../../jobs/promo5DayBlast.js');
    const data = await sendPromo5DayBlast();
    return c.json({
      success: true,
      data,
      message: `Promo blast: ${data?.smsSent ?? 0} SMS, ${data?.emailsSent ?? 0} email (${data?.audience ?? 0} recipients)`,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// eHub wallet top-up via the provider payment API (POST /payments/initiate, GET /payments/{ref}/status)
smsRoutes.post('/reseller/provider-topup', async (c: any) => {
  try {
    const { sms_quantity, phone_number } = await c.req.json();
    const qty = Math.floor(Number(sms_quantity));
    if (!Number.isFinite(qty) || qty < 1) {
      return c.json({ success: false, error: 'sms_quantity is required and must be a positive integer' }, 400);
    }
    const phone = String(phone_number || '').replace(/[\s()-]/g, '');
    if (!/^(255|0)[67]\d{8}$/.test(phone)) {
      return c.json({ success: false, error: 'A valid TZ phone number is required (e.g. 2557xxxxxxxx)' }, 400);
    }
    const normalized = phone.startsWith('0') ? `255${phone.slice(1)}` : phone;
    const idempotencyKey = crypto.randomUUID();
    const data = await ehub.initiatePayment(qty, normalized, idempotencyKey);
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

smsRoutes.get('/reseller/provider-payment/:reference/status', async (c: any) => {
  try {
    const reference = c.req.param('reference');
    const data = await ehub.getPaymentStatus(reference);
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: AI review of all user-sent SMS. Filters: ?risk=high&unreviewed=true
smsRoutes.get('/reseller/ai-review', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const risk = c.req.query('risk') || undefined;
    const unreviewed = c.req.query('unreviewed') === 'true';
    const result = await reseller.listAiReviewedMessages({ page, limit, risk, unreviewed });
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: FULL SMS log across ALL shops — every message content, sender,
// status and AI risk. Filters: ?shop=&status=&risk=&q=&page=&limit=
smsRoutes.get('/reseller/messages', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const shop = c.req.query('shop') || undefined;
    const status = c.req.query('status') || undefined;
    const risk = c.req.query('risk') || undefined;
    const q = c.req.query('q') || undefined;
    const result = await reseller.listAllSmsMessages({ page, limit, shop, status, risk, q });
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: aggregated SMS Monitoring counters (total/blocked/high/medium/
// unchecked/queued/failed...) for the monitoring dashboard header.
smsRoutes.get('/reseller/monitoring-stats', async (c) => {
  try {
    const data = await reseller.getSmsMonitoringStats();
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: run the AI classifier over messages still marked "unchecked"
// (e.g. sent while the AI key was missing). Body/query: { limit }.
smsRoutes.post('/reseller/ai-review/run', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const limit = parseInt(String(body?.limit ?? c.req.query('limit') ?? '50'));
    const data = await reseller.reviewUnreviewedSms(limit);
    return c.json({
      success: true,
      data,
      message: `AI review: ${data.reviewed}/${data.scanned} reviewed`,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: manually trigger the queued-SMS flusher (drains queued sends once
// the provider float has balance).
smsRoutes.post('/reseller/flush-queued', async (c) => {
  try {
    const result = await reseller.flushQueuedSms();
    return c.json({ success: true, data: result, message: `Queued SMS flushed: ${result.sent} sent, ${result.failed} failed, ${result.remaining} remaining` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: all shop SMS accounts with balance/usage/approved senders/purchase
// summary. Supports ?search, ?page, ?limit.
smsRoutes.get('/reseller/accounts', async (c: any) => {
  try {
    const search = c.req.query('search') || undefined;
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const data = await reseller.getAllSmsAccounts(search, page, limit);
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Developer: full detail for one shop — account, sender IDs, purchase history,
// transactions, sent messages, and issues.
smsRoutes.get('/reseller/accounts/:id', async (c: any) => {
  try {
    const data = await reseller.getSmsAccountDetail(c.req.param('id'));
    if (!data.shop && !data.account) return c.json({ success: false, error: 'Account not found' }, 404);
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── BROADCAST (developer → all users) ────────────────────────────────────────

// Preview: how many recipients a broadcast will reach. `audience`:
//   all                → every shop owner/admin (default)
//   approved_senders   → shops that have an approved own Sender ID
smsRoutes.get('/reseller/broadcast/preview', async (c) => {
  try {
    const audience = c.req.query('audience') === 'approved_senders' ? 'approved_senders' : 'all';
    const recipients = await getBroadcastRecipients(audience);
    return c.json({ success: true, data: { audience, recipients: recipients.length, sample: recipients.slice(0, 5) } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// AI-generate a ready-to-send announcement about a given topic (e.g. new feature).
smsRoutes.post('/reseller/broadcast/generate', async (c) => {
  try {
    const { topic } = await c.req.json();
    if (!topic) return c.json({ success: false, error: 'Topic is required' }, 400);
    const message = await generateBroadcastMessage(topic);
    if (!message) return c.json({ success: false, error: 'AI generation failed — write the message manually' }, 400);
    return c.json({ success: true, data: { message } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Send the broadcast. Blocks duplicate re-sends of identical text.
// Body: { message, audience?: 'all' | 'approved_senders' }
smsRoutes.post('/reseller/broadcast/send', async (c: any) => {
  try {
    const { message, audience } = await c.req.json();
    const result = await startBroadcast(message, c.get('userId'), audience);
    if (!result.success) return c.json({ success: false, error: result.error, recipients: result.recipients }, 409);
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Poll progress of a broadcast by id (so the UI can show a spinner and disable the button).
smsRoutes.get('/reseller/broadcast/:id/progress', async (c) => {
  try {
    const result = await getBroadcastProgress(c.req.param('id'));
    if (!result.success) return c.json({ success: false, error: result.error }, 404);
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// Recent broadcasts (for the history list).
smsRoutes.get('/reseller/broadcast/history', async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);
    const data = await getBroadcastHistory(limit);
    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default smsRoutes;
