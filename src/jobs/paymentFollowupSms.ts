import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import { sendSms } from '../services/ehub-sms-adapter.service.js';
import { sendEmail } from '../services/email.service.js';
import { generateAiMessage } from '../services/sms.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

const WHATSAPP_LINK = '255775699545';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';

function baseTemplate(content: string) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6; padding:20px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr><td style="background:linear-gradient(135deg,#059669,#10b981); padding:24px 32px; text-align:center;">
          <h1 style="color:#fff; margin:0; font-size:20px; font-weight:700;">ALFEAN ENTERPRISES</h1>
          <p style="color:#d1fae5; margin:4px 0 0; font-size:13px;">Mfumo wa Mauzo na Usimamizi</p>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          ${content}
        </td></tr>
        <tr><td style="background:#f9fafb; padding:16px 32px; text-align:center; border-top:1px solid #e5e7eb;">
          <p style="margin:0; font-size:12px; color:#9ca3af;">
            ALFEAN ENTERPRISES &mdash; 127.0.0.1:47831 &bull; support@localhost<br>
            <a href="${WHATSAPP_LINK}" style="color:#059669; text-decoration:none;">simu: 255775699545</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

export async function sendPaymentFollowupSms() {
  console.log('[PaymentFollowup] Checking for pending/failed payments needing follow-up...');

  const payments = await pool.query(`
    SELECT sp.id, sp.snippe_reference, sp.amount_tzs, sp.status, sp.customer_phone, sp.created_at,
      t.name as tenant_name, t.id as tenant_id, t.email as tenant_email,
      spl.name as plan_name
    FROM subscription_payments sp
    LEFT JOIN tenants t ON t.id = sp.tenant_id
    LEFT JOIN tenant_subscriptions ts ON ts.id = sp.subscription_id
    LEFT JOIN subscription_plans spl ON spl.id = ts.plan_id
    WHERE sp.status IN ('pending', 'failed')
      AND sp.customer_phone IS NOT NULL
      AND (
        SELECT COUNT(*) FROM sms_log sl
        WHERE sl.tenant_id = sp.tenant_id
          AND sl.created_at > sp.created_at
          AND sl.message LIKE '%https://wa.me/%'
      ) = 0
      AND (
        SELECT COUNT(*) FROM email_events ee
        WHERE ee.email = t.email
          AND ee.created_at > sp.created_at
          AND ee.event_type = 'sent'
      ) = 0
    ORDER BY sp.created_at ASC
    LIMIT 10
  `);

  if (payments.rows.length === 0) {
    console.log('[PaymentFollowup] No payments needing follow-up');
    return { smsSent: 0, emailsSent: 0, total: 0 };
  }

  let smsSent = 0;
  let emailsSent = 0;

  for (const p of payments.rows) {
    const amount = Number(p.amount_tzs || 0);
    const amountStr = `TZS ${amount.toLocaleString()}`;
    const name = p.tenant_name || 'Mteja';
    const plan = p.plan_name || 'usajili';

    // ── SMS ────────────────────────────────────────────────────────────────
    const phone = p.customer_phone?.replace(/\D/g, '');
    const normalizedPhone = phone?.startsWith('0') ? `255${phone.slice(1)}` : phone?.startsWith('+') ? phone.slice(1) : phone;
    if (normalizedPhone?.startsWith('255')) {
      if (p.status === 'pending') {
        const aiPrompt = `Generate a sweet, attractive marketing SMS in Swahili for ${name} reminding them their ALFEAN ENTERPRISES ${plan} payment ${amountStr} is still pending. Use warm, persuasive language. Offer help to complete payment via simu. Include the simu link.`;
        let message = await generateAiMessage(aiPrompt);
        if (!message) {
          message = `Habari ${name}, malipo yako ya ALFEAN ENTERPRISES ${plan} ${amountStr} bado hayajathibitishwa. Je tunaweza kukusaidia? Maliza sasa ${WHATSAPP_LINK} au piga 255775699545. - ALFEAN ENTERPRISES`;
        }
        const result = await sendSms(normalizedPhone, message, p.tenant_id);
        if (result.success) smsSent++;
      } else if (p.status === 'failed') {
        const aiPrompt = `Generate a sweet, attractive marketing SMS in Swahili for ${name} telling them their ALFEAN ENTERPRISES ${plan} payment ${amountStr} failed. Use warm, persuasive language to encourage them to try again. Offer help to pay again via simu. Include the simu link.`;
        let message = await generateAiMessage(aiPrompt);
        if (!message) {
          message = `Habari ${name}, malipo yako ya ALFEAN ENTERPRISES ${plan} ${amountStr} hayakufanikiwa. Je tunaweza kukusaidia kulipa? simu ${WHATSAPP_LINK} au piga 255775699545. - ALFEAN ENTERPRISES`;
        }
        const result = await sendSms(normalizedPhone, message, p.tenant_id);
        if (result.success) smsSent++;
      }
    }

    // ── EMAIL ──────────────────────────────────────────────────────────────
    if (p.tenant_email) {
      let subject: string;
      let bodyHtml: string;

      if (p.status === 'pending') {
        subject = `ALFEAN ENTERPRISES - Malipo Yako Bado Hayajathibitishwa`;
        bodyHtml = `
          <h2 style="color:#d97706; margin:0 0 16px;">Malipo Yako Bado Hayajathibitishwa</h2>
          <p style="font-size:15px; color:#374151; line-height:1.6;">Habari <strong>${name}</strong>,</p>
          <p style="font-size:15px; color:#374151; line-height:1.6;">Malipo yako ya <strong>${plan}</strong> (${amountStr}) bado hayajathibitishwa. Je tunaweza kukusaidia kuyakamilisha?</p>
          <table style="background:#fffbeb; border-radius:8px; padding:16px; margin:16px 0; width:100%;">
            <tr><td style="padding:4px 0; font-size:14px; color:#92400e;">Mpango</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#92400e;">${plan}</td></tr>
            <tr><td style="padding:4px 0; font-size:14px; color:#92400e;">Kiasi</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#92400e;">${amountStr}</td></tr>
            <tr><td style="padding:4px 0; font-size:14px; color:#92400e;">Rejea</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#92400e; font-family:monospace;">${p.snippe_reference}</td></tr>
          </table>
          <div style="text-align:center; margin:24px 0;">
            <a href="${APP_URL}/subscription" style="display:inline-block; background:linear-gradient(135deg,#059669,#10b981); color:#fff; text-decoration:none; padding:14px 32px; border-radius:8px; font-weight:700; font-size:15px;">Maliza Malipo Sasa</a>
          </div>
          <p style="font-size:14px; color:#6b7280; line-height:1.5;">Je tunaweza kukusaidia? Wasiliana nasi kwa simu: <a href="${WHATSAPP_LINK}" style="color:#059669; font-weight:600;">${WHATSAPP_LINK}</a> au piga simu 255775699545.</p>
        `;
      } else {
        subject = `ALFEAN ENTERPRISES - Malipo Yako Hayakufanikiwa`;
        bodyHtml = `
          <h2 style="color:#dc2626; margin:0 0 16px;">Malipo Yako Hayakufanikiwa</h2>
          <p style="font-size:15px; color:#374151; line-height:1.6;">Habari <strong>${name}</strong>,</p>
          <p style="font-size:15px; color:#374151; line-height:1.6;">Malipo yako ya <strong>${plan}</strong> (${amountStr}) hayakufanikiwa. Je tunaweza kukusaidia kulipa?</p>
          <table style="background:#fef2f2; border-radius:8px; padding:16px; margin:16px 0; width:100%;">
            <tr><td style="padding:4px 0; font-size:14px; color:#991b1b;">Mpango</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#991b1b;">${plan}</td></tr>
            <tr><td style="padding:4px 0; font-size:14px; color:#991b1b;">Kiasi</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#991b1b;">${amountStr}</td></tr>
            <tr><td style="padding:4px 0; font-size:14px; color:#991b1b;">Rejea</td><td style="padding:4px 0; font-size:14px; font-weight:600; color:#991b1b; font-family:monospace;">${p.snippe_reference}</td></tr>
          </table>
          <div style="text-align:center; margin:24px 0;">
            <a href="${APP_URL}/subscription" style="display:inline-block; background:linear-gradient(135deg,#dc2626,#ef4444); color:#fff; text-decoration:none; padding:14px 32px; border-radius:8px; font-weight:700; font-size:15px;">Jaribu Tena</a>
          </div>
          <p style="font-size:14px; color:#6b7280; line-height:1.5;">Je tunaweza kukusaidia? Wasiliana nasi kwa simu: <a href="${WHATSAPP_LINK}" style="color:#059669; font-weight:600;">${WHATSAPP_LINK}</a> au piga simu 255775699545.</p>
        `;
      }

      const emailResult = await sendEmail({
        to: p.tenant_email,
        subject,
        html: baseTemplate(bodyHtml),
        name,
      });
      if (emailResult.success) emailsSent++;
    }
  }

  console.log(`[PaymentFollowup] Sent ${smsSent} SMS, ${emailsSent} emails for ${payments.rows.length} payments`);
  return { smsSent, emailsSent, total: payments.rows.length };
}

export function startPaymentFollowupCron() {
  cron.schedule('0 */2 * * *', async () => {
    if (!(await isSmsAutomationEnabled('payment_followup'))) {
      console.log('[cron] Payment follow-ups paused by developer — skipped');
      return;
    }
    console.log('[cron] Running payment follow-up check...');
    try {
      await sendPaymentFollowupSms();
    } catch (e: any) {
      console.error('[cron] Payment follow-up error:', e.message);
    }
  });

  console.log('[cron] Payment follow-up job registered (every 2 hours)');
}
