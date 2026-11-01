import { Hono } from 'hono';
import crypto from 'crypto';
import { pool } from '../../config/drizzle.js';
import { verifyWebhookSignature } from '../../services/snippe.service.js';
import { completeSmsPurchase, failSmsPurchase } from '../../services/sms-reseller.service.js';
import { sendSms } from '../../services/ehub-sms-adapter.service.js';
import { Resend } from 'resend';
import { Webhook, WebhookVerificationError } from 'svix';

const webhookRoutes = new Hono();

// ─── eHub SMS DELIVERY REPORTS ───────────────────────────────────────────────
// eHub POSTs a signed JSON payload the moment a message reaches a terminal
// state (delivered / failed). We:
//   1. verify the X-eHub-Signature HMAC (constant-time) against the webhook
//      secret (EHUB_SMS_SIGNING_SECRET),
//   2. update the matching row in sms_messages (shops) and sms_log (system),
//   3. forward the failure to the affected shop owner in real time — SMS +
//      in-app notification — so they know and can re-send in one tap.
webhookRoutes.post('/ehub', async (c) => {
  const rawBody = await c.req.text();

  // Signature check (docs: HMAC-SHA256 of the raw body, hex, X-eHub-Signature)
  const secret = process.env.EHUB_SMS_SIGNING_SECRET || process.env.EHUB_SMS_WEBHOOK_SECRET || '';
  const sig = c.req.header('x-ehub-signature') || '';
  if (secret) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(sig, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn('[webhook:ehub] Invalid signature');
        return c.json({ success: false, error: 'invalid signature' }, 401);
      }
    } catch {
      return c.json({ success: false, error: 'invalid signature' }, 401);
    }
  } else {
    console.warn('[webhook:ehub] EHUB_SMS_SIGNING_SECRET not set — accepting without signature check');
  }

  let payload: any = {};
  try { payload = JSON.parse(rawBody || '{}'); } catch { return c.json({ success: false, error: 'invalid json' }, 400); }

  const messageId = String(payload.message_id || '').trim();
  const status = String(payload.status || '').toLowerCase();
  const errorText = payload.error ? String(payload.error) : null;
  if (!messageId || !status) return c.json({ success: true, ignored: 'missing message_id/status' });

  // Only terminal states are forwarded by eHub, but be defensive.
  const effective = ['delivered', 'sent', 'failed'].includes(status) ? status : null;
  if (!effective) return c.json({ success: true, ignored: `status ${status}` });

  try {
    // 1. Shop-level message (sms_messages) — look up before updating so we know
    //    which shop/recipient failed and can notify.
    const smsMsg = await pool.query(
      `SELECT id, shop_id, recipient, message, status FROM sms_messages WHERE provider_message_id = $1 LIMIT 1`,
      [messageId]
    );
    let updated = false;

    if (smsMsg.rows.length > 0) {
      const row = smsMsg.rows[0];
      if (row.status !== effective) {
        await pool.query(`UPDATE sms_messages SET status = $2, error = $3 WHERE id = $1`, [row.id, effective, errorText]);
        updated = true;
      }

      // 2. Real-time forwarding to the specific user: on failure, tell the shop
      //    owner via SMS so they don't have to watch the dashboard.
      if (effective === 'failed' && updated) {
        try {
          const owner = await pool.query(`
            SELECT u.phone, u.name, s.tenant_id FROM shops s
            LEFT JOIN "user" u ON u.tenant_id = s.tenant_id::text AND u.role IN ('admin','owner') AND u.phone IS NOT NULL
            WHERE s.id = $1 ORDER BY u.created_at ASC LIMIT 1
          `, [row.shop_id]);
          const ownerPhone = owner.rows[0]?.phone;
          const tenantId = owner.rows[0]?.tenant_id || null;

          if (tenantId) {
            await pool.query(
              `INSERT INTO notifications (tenant_id, user_id, title, message, type, action_url)
               VALUES ($1, NULL, $2, $3, 'sms', '/sms')`,
              [tenantId, 'SMS Haikufikishwa', `SMS kwa ${row.recipient} haikufikishwa: ${errorText || 'sababu haijulikani'}. Unaweza kuituma tena kwenye SMS Center.`]
            ).catch(() => {});
          }
          if (ownerPhone) {
            const digits = String(ownerPhone).replace(/[^0-9]/g, '');
            const normalized = digits.startsWith('0') ? `255${digits.slice(1)}` : digits;
            await sendSms(normalized, `ALFEAN ENTERPRISES: SMS yako kwa ${row.recipient} haikufikishwa (${errorText || 'sababu haijulikani'}). Ingia SMS Center > History kuituma tena. - ALFEAN ENTERPRISES`);
          }
        } catch (e: any) {
          console.warn('[webhook:ehub] Failed to forward failure notice:', e.message);
        }
      }
    }

    // 3. System log (sms_log) — trial reminders / payment follow-ups etc.
    const logRes = await pool.query(
      `UPDATE sms_log SET status = $2, error_message = COALESCE($3, error_message) WHERE message_id = $1`,
      [messageId, effective === 'failed' ? 'failed' : effective, errorText]
    );

    console.log(`[webhook:ehub] ${messageId} → ${effective} (messages: ${updated}, log: ${logRes.rowCount})`);
    return c.json({ success: true, status: effective });
  } catch (e: any) {
    console.error('[webhook:ehub] Error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

webhookRoutes.post('/snippe', async (c) => {
  const rawBody = await c.req.text();
  const timestamp = c.req.header('x-webhook-timestamp') ?? '';
  const signature = c.req.header('x-webhook-signature') ?? '';

  let valid = false;
  try {
    valid = verifyWebhookSignature(rawBody, timestamp, signature);
  } catch (e: any) {
    // Missing SNIPPE_WEBHOOK_SECRET must not crash into an opaque 500.
    console.error('[webhook] Signature verification error:', e.message);
  }
  if (!valid) {
    console.warn('[webhook] Invalid signature or stale timestamp');
    return c.text('Unauthorized', 401);
  }

  try {
    await processEvent(rawBody);
  } catch (e: any) {
    // Non-2xx makes Snippe retry with backoff — never ack an event we failed
    // to process, otherwise the completion is lost until the next reconcile.
    console.error('[webhook] Processing failed, requesting retry:', e.message);
    return c.text('Processing failed', 500);
  }
  return c.text('OK', 200);
});

async function processEvent(rawBody: string) {
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return;
  }

  // Current format nests everything under `data` with `type`; the legacy
  // format (api_version 2026-01-01) is flat with `event`. Support both or
  // legacy webhooks are silently dropped (payment stays pending forever).
  const type = String(event.type || event.event || '').toLowerCase();
  const data = event.data && typeof event.data === 'object' ? event.data : event;
  const normalized = { ...event, type, data };

  // Always log accepted events — the only way to prove deliveries arrive and
  // to diagnose stuck purchases from server logs.
  console.log(`[webhook] snippe accepted: ${type} ref=${data?.reference ?? '-'}`);

  if (type === 'payment.completed') {
    await handlePaymentCompleted(normalized);
  } else if (type === 'payment.failed' || type === 'payment.voided' || type === 'payment.expired') {
    await handlePaymentFailed(normalized);
  }
}

async function handlePaymentCompleted(event: any) {
  const data = event.data;
  const reference = data.reference;
  const eventId = event.id ?? null;

  try {
    // SMS credit purchase (reseller flow)
    const smsPurchase = await completeSmsPurchase(reference);
    if (smsPurchase) {
      console.log(`[webhook] SMS credits added: ${smsPurchase.credits} for shop ${smsPurchase.shop_id}`);
      return;
    }

    // Heal an orphaned SMS completion: the customer paid, but our local
    // sms_purchases row was never written (rare insert failure/race). The
    // webhook metadata carries shop_id + credits, so rebuild the row and
    // credit instead of silently dropping the completion.
    const meta = data.metadata;
    if (meta && meta.purpose === 'sms_credits' && meta.shop_id) {
      const credits = Math.floor(Number(meta.credits) || 0);
      const amountTzs = Math.round(Number(data.amount?.value ?? data.amount) || 0);
      if (credits > 0 && amountTzs > 0) {
        await pool.query(
          `INSERT INTO sms_purchases (shop_id, credits, amount_tzs, price_per_sms, phone_number, snippe_reference, status)
           SELECT $1, $2, $3, $4, $5, $6, 'pending'
           WHERE NOT EXISTS (SELECT 1 FROM sms_purchases WHERE snippe_reference = $6)`,
          [String(meta.shop_id), credits, amountTzs, Math.round(amountTzs / credits), data.phone_number ?? '', reference]
        );
        const healed = await completeSmsPurchase(reference);
        if (healed) {
          console.log(`[webhook] SMS purchase healed from metadata: ${healed.credits} credits for shop ${healed.shop_id}`);
          return;
        }
      }
    }

    // No SMS purchase matched, and subscription billing is switched off for
    // this deployment — nothing to activate. Log and acknowledge the event so
    // Snippe stops retrying it.
    console.log('[webhook] No SMS purchase matched reference', reference, '- ignored');
  } catch (e: any) {
    console.error('[webhook] handlePaymentCompleted error:', e.message);
    // Propagate so the route returns 500 and Snippe retries — swallowing here
    // meant a transient DB/SMS error permanently lost the completion event.
    throw e;
  }
}

async function handlePaymentFailed(event: any) {
  const reference = event.data?.reference;
  if (!reference) return;

  try {
    await failSmsPurchase(reference);

    // Subscriptions are switched off — only SMS purchases need failing here.
  } catch (e: any) {
    console.error('[webhook] handlePaymentFailed error:', e.message);
    throw e;
  }
}

// ─── RESEND INBOUND EMAIL WEBHOOK ─────────────────────────────────────────────
function getResend() {
  return new Resend(process.env.RESEND_API_KEY || '');
}

webhookRoutes.post('/resend-receive', async (c) => {
  try {
    const rawBody = await c.req.text();
    const svixId = c.req.header('svix-id') || '';
    const svixTimestamp = c.req.header('svix-timestamp') || '';
    const svixSignature = c.req.header('svix-signature') || '';

    const signingSecret = process.env.RESEND_WEBHOOK_SECRET || '';
    if (signingSecret) {
      try {
        const wh = new Webhook(signingSecret);
        wh.verify(rawBody, {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        });
      } catch (err) {
        if (err instanceof WebhookVerificationError) {
          console.warn('[webhook] Invalid Resend webhook signature');
          return c.text('Unauthorized', 401);
        }
        throw err;
      }
    }

    const event = JSON.parse(rawBody);

    if (event.type !== 'email.received') {
      return c.text('OK', 200);
    }

    const { email_id, message_id, from, to, cc, bcc, subject, attachments: attachmentMeta } = event.data;
    const msgId = message_id || '';

    // Check for duplicates
    const existing = await pool.query(`SELECT id FROM inbound_emails WHERE email_id = $1`, [email_id]);
    if (existing.rows.length > 0) {
      return c.text('OK', 200);
    }

    // Fetch full email content from Resend API
    let htmlBody = '';
    let textBody = '';
    let headers = {};
    let attachments: any[] = [];

    try {
      const resend = getResend();
      const { data: emailData } = await resend.emails.receiving.get(email_id);
      if (emailData) {
        htmlBody = (emailData as any).html || '';
        textBody = (emailData as any).text || '';
        headers = (emailData as any).headers || {};
      }

      // Fetch attachments
      const { data: attachmentData } = await resend.emails.receiving.attachments.list({ emailId: email_id });
      if (attachmentData) {
        attachments = (attachmentData as any) as any[];
      }
    } catch (fetchErr: any) {
      console.error('[webhook] Failed to fetch email content:', fetchErr.message);
    }

    await pool.query(`
      INSERT INTO inbound_emails (email_id, message_id, "from", "to", cc, bcc, subject, html_body, text_body, headers, attachments, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    `, [
      email_id,
      msgId,
      from || '',
      to || [],
      cc || [],
      bcc || [],
      subject || '',
      htmlBody,
      textBody,
      JSON.stringify(headers),
      JSON.stringify(attachments),
    ]);

    console.log(`[webhook] Inbound email stored: "${subject}" from ${from}`);
    return c.text('OK', 200);
  } catch (e: any) {
    console.error('[webhook] Resend receive error:', e.message);
    return c.text('OK', 200);
  }
});

export default webhookRoutes;
