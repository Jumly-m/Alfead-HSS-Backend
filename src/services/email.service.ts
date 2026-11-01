import { Resend } from 'resend';
import { pool } from '../config/drizzle.js';
import axios from 'axios';
import { getTodayBlogMarketing } from './blog-marketing.service.js';

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY || 'REPLACE_WITH_KEY');
  return _resend;
}

const FROM_NAME = process.env.EMAIL_FROM_NAME || 'ALFEAN ENTERPRISES';
const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || 'support@localhost';
const REPLY_TO_EMAIL = process.env.REPLY_TO_EMAIL || 'webdeveloperinswahili@gmail.com';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';

// ─── EMAIL PROVIDER: RESEND ONLY ─────────────────────────────────────────────
// Every system email (welcome, password reset, support replies, alerts, expiry
// reminders and campaigns) is sent through Resend. The previous Unosend
// fallback was removed so there is a single provider and a single set of
// credentials to manage.
let _resendDailyLimit: number | null = null;
function getResendDailyLimit(): number {
  if (_resendDailyLimit === null) {
    const n = parseInt(process.env.RESEND_DAILY_LIMIT || '', 10);
    _resendDailyLimit = Number.isNaN(n) ? 90 : n;
  }
  return _resendDailyLimit;
}

// How many emails Resend sent today (from the email_events log). Used by the
// developer portal to show the daily quota usage.
async function getProviderCountToday(provider: 'resend'): Promise<number> {
  try {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS count FROM email_events
       WHERE event_type = 'sent' AND COALESCE(metadata->>'provider', 'resend') = $1
         AND created_at >= CURRENT_DATE`,
      [provider]
    );
    return res.rows[0]?.count || 0;
  } catch (e: any) {
    console.error('[Email] Failed to count today:', e.message);
    return 0;
  }
}

// True when the Resend free-tier daily quota has been reached/overrun.
export async function resendQuotaExhausted(): Promise<boolean> {
  const used = await getProviderCountToday('resend');
  return used >= getResendDailyLimit();
}

async function logEmailEvent(eventType: string, templateKey: string | null, email: string, tenantId?: string, metadata?: Record<string, any>) {
  try {
    const provider = (metadata?.provider as string) || 'resend';
    await pool.query(
      `INSERT INTO email_events (event_type, template_key, email, tenant_id, metadata, provider) VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventType, templateKey, email, tenantId || null, JSON.stringify(metadata || {}), provider]
    );
  } catch (e: any) {
    console.error('[EmailEvent] Failed to log event:', e.message);
  }
}

// Last successful send (and last failure) recorded for Resend, from the send log.
async function providerLastActivity(provider: 'resend') {
  try {
    const r = await pool.query(
      `SELECT
         (SELECT MAX(created_at) FROM email_events WHERE provider = $1 AND event_type = 'sent') AS last_sent_at,
         (SELECT MAX(created_at) FROM email_events WHERE provider = $1 AND event_type = 'failed') AS last_failed_at,
         (SELECT COUNT(*)::int FROM email_events WHERE provider = $1 AND event_type = 'sent') AS total_sent
       `,
      [provider]
    );
    return r.rows[0] || { last_sent_at: null, last_failed_at: null, total_sent: 0 };
  } catch {
    return { last_sent_at: null, last_failed_at: null, total_sent: 0 };
  }
}

export type SendEmailResult = {
  success: boolean;
  id?: string;
  error?: any;
  reason?: string;
  provider?: string;
};

export async function sendEmail({ to, subject, html, name, templateKey }: { to: string; subject: string; html: string; name?: string; templateKey?: string; forceProvider?: string }): Promise<SendEmailResult> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Email] RESEND_API_KEY not set, skipping email to', to);
    return { success: false, reason: 'RESEND_API_KEY not configured' };
  }
  try {
    const trackingPixel = `${APP_URL}/track/open?email=${encodeURIComponent(to)}&key=${templateKey || ''}&t=${Date.now()}`;
    const personalizedHtml = html
      .replace(/\{\{name\}\}/g, name || 'User')
      .replace(/\{\{email\}\}/g, to)
      .replace(/\{\{app_url\}\}/g, APP_URL)
      .replace(/\{\{tracking_pixel\}\}/g, trackingPixel);

    const { data, error } = await getResend().emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      replyTo: REPLY_TO_EMAIL,
      to: [to],
      subject,
      html: personalizedHtml,
    });
    if (error) {
      console.error('[Email] Send failed:', error);
      await logEmailEvent('failed', templateKey || null, to, undefined, {
        provider: 'resend',
        subject,
        error: typeof error === 'string' ? error : JSON.stringify(error),
      });
      return { success: false, error };
    }
    await logEmailEvent('sent', templateKey || null, to, undefined, { provider: 'resend', subject, resendId: data?.id });
    return { success: true, id: data?.id, provider: 'resend' };
  } catch (e: any) {
    console.error('[Email] Exception:', e.message);
    return { success: false, error: e.message };
  }
}

// Provider usage report for the developer portal (Resend only).
export async function getEmailProviderStatus() {
  const [todayResend, limit, resendLast] = await Promise.all([
    getProviderCountToday('resend'),
    getResendDailyLimit(),
    providerLastActivity('resend'),
  ]);
  return {
    resend: {
      label: 'Resend',
      usedToday: todayResend,
      dailyLimit: limit,
      configured: Boolean(process.env.RESEND_API_KEY),
      active: todayResend < limit,
      lastSentAt: resendLast.last_sent_at,
      lastFailedAt: resendLast.last_failed_at,
      totalSent: resendLast.total_sent,
    },
    // Kept as null so older admin UI builds that read status.unosend don't crash.
    unosend: null,
    threshold: limit,
    currentProvider: 'resend',
    totalToday: todayResend,
  };
}

// Send one email to every address in a custom list (that may NOT be registered
// in the system — e.g. pasted or uploaded). All sends go through Resend.
export async function sendBulkToCustomList({
  to, subject, html,
}: { to: string[]; subject: string; html: string; provider?: string }) {
  const results = [];
  let sent = 0;
  let failed = 0;
  const seen = new Set<string>();
  const unique = to
    .map((e) => (e || '').trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    .filter((e) => (!seen.has(e) ? (seen.add(e), true) : false));

  for (const email of unique) {
    try {
      const r = await sendEmail({ to: email, subject, html });
      results.push({ email, success: r.success, id: r.id });
      if (r.success) sent++; else failed++;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (e: any) {
      failed++;
      results.push({ email, success: false, error: e.message });
    }
  }
  return { sent, failed, total: unique.length, unique, results, provider: 'resend' };
}

async function getOrGenerateWelcomeBody(): Promise<string> {
  try {
    const cached = await pool.query(`SELECT value FROM system_settings WHERE key = 'welcome_email_body'`);
    const cacheVersion = await pool.query(`SELECT value FROM system_settings WHERE key = 'welcome_email_body_version'`);
    const currentVersion = 'v3';
    if (cached.rows.length > 0 && cacheVersion.rows[0]?.value === currentVersion) {
      return cached.rows[0].value;
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    const appUrl = APP_URL;

    if (!apiKey) return fallbackWelcomeBody(appUrl);

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: `You are a professional email copywriter for ALFEAN ENTERPRISES POS (http://127.0.0.1:47831), a POS system for hardware stores in Tanzania. Generate welcome email body content in SWAHILI. Return ONLY valid JSON with a "html" field. Do NOT include footers, headers, or copyright notices — just the email body content.` },
          { role: 'user', content: `Write a warm professional welcome email body in Swahili for a new user who just registered for ALFEAN ENTERPRISES POS (http://127.0.0.1:47831).

Requirements:
- Language: Professional, warm Swahili (mix with some English terms where natural)
- Tone: Karibu sana, thank them for joining
- Mention that their account is ready and they have full access to all features (no trial or subscription wording)
- List key features: point-of-sale, inventory management, customer management, debt tracking, reporting, stock management
- CTA button: "Anza Kutumia Sasa" linking to ${appUrl}
- Use inline styles, green brand (#059669 → #10b981)
- Keep under 200 words
- Signature: "Timu ya ALFEAN ENTERPRISES"
- Our email: support@localhost
- Our website: http://127.0.0.1:47831
- Do NOT include simu, social media, channel or training-video links
- Return JSON: {"html": "..."}` },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const content = JSON.parse(response.data.choices[0].message.content);
    const html = content.html || fallbackWelcomeBody(appUrl);

    await pool.query(`INSERT INTO system_settings (key, value) VALUES ('welcome_email_body', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [html]);
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ('welcome_email_body_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [currentVersion]);
    return html;
  } catch {
    return fallbackWelcomeBody(APP_URL);
  }
}

function fallbackWelcomeBody(appUrl: string) {
  return `
    <p style="font-size: 15px; color: #374151; line-height: 1.6;">Habari {{name}},</p>
    <p style="font-size: 15px; color: #374151; line-height: 1.6;">Asante kwa kujiunga na ALFEAN ENTERPRISES! Akaunti yako imeandikishwa — unaweza kutumia vipengele vyote vya mfumo.</p>
    <div style="background: #f0fdf4; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <p style="font-size: 14px; color: #065f46; margin: 0 0 8px;"><strong>Vipengele:</strong></p>
      <ul style="font-size: 13px; color: #065f46; margin: 0; padding-left: 20px;">
        <li>POS — mauzo ya haraka kwa skana ya barcode</li>
        <li>Usimamizi wa bidhaa na vitengo mbalimbali</li>
        <li>Kufuatilia deni la wateja</li>
        <li>Ripoti na takwimu za biashara yako</li>
        <li>Inafanya kazi bila intaneti (PWA)</li>
      </ul>
    </div>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${appUrl}" style="display: inline-block; background: linear-gradient(135deg, #059669, #10b981); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 15px;">Anza Kutumia Sasa</a>
    </div>
  `.trim();
}

export async function sendWelcomeEmail({ to, name, userId, forceProvider }: { to: string; name: string; userId?: string; forceProvider?: string }) {
  const body = await getOrGenerateWelcomeBody();
  const fullHtml = baseTemplate(body.replace(/\{\{name\}\}/g, name || 'Mjumia'));
  const result = await sendEmail({ to, subject: 'Karibu ALFEAN ENTERPRISES! Anza kutumia mfumo', html: fullHtml, name, templateKey: 'welcome' });
  
  if (userId) {
    try {
      await pool.query(
        `UPDATE "user" SET welcome_email_sent = $1, welcome_email_sent_at = $2 WHERE id = $3`,
        [result.success, result.success ? new Date() : null, userId]
      );
    } catch (e: any) {
      console.error('[WelcomeEmail] Failed to update tracking:', e.message);
    }
  }
  
  return result;
}

function baseTemplate(content: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ALFEAN ENTERPRISES</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f8; padding: 24px 16px; }
  .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
  .header { background: linear-gradient(135deg, #059669, #10b981); padding: 32px 24px; text-align: center; color: #ffffff; }
  .header h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
  .header p { opacity: 0.9; font-size: 14px; margin-top: 4px; }
  .body { padding: 32px 24px; color: #1f2937; line-height: 1.6; }
  .body h2 { font-size: 20px; font-weight: 700; color: #111827; margin-bottom: 16px; }
  .body p { margin-bottom: 12px; font-size: 15px; color: #374151; }
  .amount { font-size: 32px; font-weight: 800; color: #059669; text-align: center; margin: 16px 0; }
  .details { background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0; border: 1px solid #e5e7eb; }
  .details table { width: 100%; border-collapse: collapse; }
  .details td { padding: 6px 0; font-size: 14px; }
  .details td:last-child { text-align: right; font-weight: 600; color: #111827; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; }
  .badge-success { background: #d1fae5; color: #065f46; }
  .badge-warning { background: #fef3c7; color: #92400e; }
  .badge-info { background: #dbeafe; color: #1e40af; }
  .badge-danger { background: #fee2e2; color: #991b1b; }
  .btn { display: inline-block; background: linear-gradient(135deg, #059669, #10b981); color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; margin: 8px 4px; }
  .btn-outline { background: transparent; border: 2px solid #059669; color: #059669 !important; }
  .footer { background: #f9fafb; padding: 20px 24px; text-align: center; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; }
  .footer a { color: #059669; text-decoration: none; }
  .footer .email { color: #6b7280; }
  @media (max-width: 480px) { .body { padding: 24px 16px; } .amount { font-size: 28px; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${FROM_NAME}</h1>
    <p>Smart POS for Growing Businesses</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    &copy; ${new Date().getFullYear()} ${FROM_NAME}. All rights reserved.<br>
    <a href="${APP_URL}">${APP_URL.replace(/^https?:\/\//, '')}</a>
  </div>
</div>
<img src="{{tracking_pixel}}" alt="" width="1" height="1" style="display:none;" />
</body>
</html>`;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    active: '<span class="badge badge-success">Active</span>',
    pending: '<span class="badge badge-warning">Pending</span>',
    expired: '<span class="badge badge-danger">Expired</span>',
    cancelled: '<span class="badge badge-danger">Cancelled</span>',
    completed: '<span class="badge badge-success">Completed</span>',
    open: '<span class="badge badge-info">Open</span>',
    'in-progress': '<span class="badge badge-warning">In Progress</span>',
    resolved: '<span class="badge badge-success">Resolved</span>',
  };
  return map[status] ?? `<span class="badge badge-info">${status}</span>`;
}

// ─── PAYMENT RECEIPT ───────────────────────────────────────────────────────────
export async function sendPaymentReceipt(opts: {
  to: string;
  tenantName: string;
  planName: string;
  amountTzs: number;
  reference: string;
  paymentType: string;
  paidAt: Date;
  expiryDate: Date;
}) {
  const { to, tenantName, planName, amountTzs, reference, paymentType, paidAt, expiryDate } = opts;
  const content = `
    <h2>Payment Confirmed!</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Your subscription payment has been received. Welcome to ALFEAN ENTERPRISES!</p>
    <div class="amount">TZS ${amountTzs.toLocaleString()}</div>
    <div class="details">
      <table>
        <tr><td>Reference</td><td>${reference}</td></tr>
        <tr><td>Plan</td><td>${planName}</td></tr>
        <tr><td>Payment Method</td><td>${paymentType === 'card' ? 'Card' : 'Mobile Money'}</td></tr>
        <tr><td>Paid On</td><td>${paidAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</td></tr>
        <tr><td>Subscription Expires</td><td>${expiryDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</td></tr>
        <tr><td>Status</td><td>${statusBadge('active')}</td></tr>
      </table>
    </div>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}" class="btn">Open Your Dashboard</a>
    </p>
    <p style="font-size:13px; color:#9ca3af; text-align:center; margin-top:8px;">Receipt ID: ${reference}</p>
  `;
  return sendEmail({ to, subject: `Payment Receipt - ${planName} (${reference})`, html: baseTemplate(content) });
}

// ─── SUBSCRIPTION CONFIRMED ────────────────────────────────────────────────────────────────
export async function sendSubscriptionConfirmed(opts: {
  to: string;
  tenantName: string;
  planName: string;
  durationDays: number;
  expiryDate: Date;
}) {
  const { to, tenantName, planName, durationDays, expiryDate } = opts;
  const content = `
    <h2>Subscription Activated!</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Your <strong>${planName}</strong> subscription is now active. Your access is valid until:</p>
    <div class="amount" style="font-size:24px;">${expiryDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
    <p>You now have full access to all ALFEAN ENTERPRISES features including:</p>
    <ul style="margin: 12px 0 12px 24px; font-size: 14px; color: #374151;">
      <li>Unlimited products &amp; sales tracking</li>
      <li>Customer management &amp; debt tracking</li>
      <li>Smart reporting &amp; analytics</li>
      <li>Multi-shop support</li>
    </ul>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}" class="btn">Get Started</a>
      <a href="${APP_URL}/subscription" class="btn btn-outline">Manage Plan</a>
    </p>
  `;
  return sendEmail({ to, subject: `Welcome to ALFEAN ENTERPRISES - ${planName} Activated!`, html: baseTemplate(content) });
}

// ─── SUBSCRIPTION EXPIRING REMINDER ────────────────────────────────────────────────
export async function sendExpirationReminder(opts: {
  to: string;
  tenantName: string;
  planName: string;
  daysRemaining: number;
  expiryDate: Date;
}) {
  const { to, tenantName, planName, daysRemaining, expiryDate } = opts;
  const urgent = daysRemaining <= 3;
  const content = `
    <h2 style="color: ${urgent ? '#dc2626' : '#d97706'};">${urgent ? '⚠️ Subscription Expiring TODAY!' : `⏰ Subscription Expires in ${daysRemaining} Days`}</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Your <strong>${planName}</strong> subscription is set to expire on:</p>
    <div class="amount" style="font-size: 24px; color: ${urgent ? '#dc2626' : '#d97706'};">
      ${expiryDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}
    </div>
    ${urgent ? '<p style="background:#fee2e2; padding:12px; border-radius:8px; color:#991b1b; font-size:14px; margin:16px 0;">Your access will be suspended if you do not renew. Please pay urgently to avoid interruption.</p>' : ''}
    <p>Renew now to keep uninterrupted access to all ALFEAN ENTERPRISES features.</p>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}/subscription" class="btn">Renew Subscription</a>
    </p>
  `;
  return sendEmail({
    to,
    subject: urgent ? `⚠️ ALFEAN ENTERPRISES Subscription Expiring Today!` : `⏰ ALFEAN ENTERPRISES: ${daysRemaining} days until renewal needed`,
    html: baseTemplate(content),
  });
}

// ─── SUBSCRIPTION EXPIRED ────────────────────────────────────────────────────────────
export async function sendSubscriptionExpired(opts: {
  to: string;
  tenantName: string;
  planName: string;
}) {
  const { to, tenantName, planName } = opts;
  const content = `
    <h2 style="color:#dc2626;">Subscription Expired</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Your <strong>${planName}</strong> subscription has expired and your access to ALFEAN ENTERPRISES has been restricted.</p>
    <p style="background:#fef2f2; padding:12px; border-radius:8px; color:#991b1b; font-size:14px; margin:16px 0;">
      You can still log in to view your data, but you cannot create new sales or manage inventory until you renew.
    </p>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}/subscription" class="btn">Renew Now</a>
    </p>
  `;
  return sendEmail({ to, subject: `ALFEAN ENTERPRISES Subscription Expired - Action Required`, html: baseTemplate(content) });
}

// ─── FREE TRIAL STARTED ──────────────────────────────────────────────────────────────
export async function sendFreeTrialStarted(opts: {
  to: string;
  tenantName: string;
  startDate: Date;
  endDate: Date;
}) {
  const { to, tenantName, startDate, endDate } = opts;
  const content = `
    <h2>🎉 Your Free Trial is Active!</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Welcome to ALFEAN ENTERPRISES! Your <strong>7-day free trial</strong> has started. You have full access to all features.</p>
    <div class="details">
      <table>
        <tr><td>Trial Start</td><td>${startDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</td></tr>
        <tr><td>Trial Ends</td><td>${endDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</td></tr>
        <tr><td>Status</td><td>${statusBadge('active')}</td></tr>
      </table>
    </div>
    <p>During your trial you can:</p>
    <ul style="margin: 12px 0 12px 24px; font-size: 14px; color: #374151;">
      <li>Add unlimited products &amp; track sales</li>
      <li>Manage customers &amp; track debts</li>
      <li>Generate reports &amp; analytics</li>
      <li>Use POS with fractional selling</li>
    </ul>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}" class="btn">Start Selling Now</a>
      <a href="${APP_URL}/subscription" class="btn btn-outline">View Plans</a>
    </p>
    <p style="font-size:13px; color:#6b7280; text-align:center; margin-top:12px;">No payment required during trial. Upgrade anytime to keep access.</p>
  `;
  return sendEmail({ to, subject: `Welcome! Your 7-Day Free Trial is Active`, html: baseTemplate(content) });
}

// ─── PLAN PURCHASED (with savings) ────────────────────────────────────────────────────
export async function sendPlanPurchased(opts: {
  to: string;
  tenantName: string;
  planName: string;
  durationDays: number;
  amountPaid: number;
  fullPrice: number;
  savings: number;
  discountPercent: number;
  startDate: Date;
  endDate: Date;
  reference: string;
  paymentType: string;
}) {
  const { to, tenantName, planName, durationDays, amountPaid, fullPrice, savings, discountPercent, startDate, endDate, reference, paymentType } = opts;
  const hasSavings = savings > 0;
  const content = `
    <h2>🎉 Plan Activated Successfully!</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Your <strong>${planName}</strong> subscription is now active. Thank you for choosing ALFEAN ENTERPRISES!</p>
    <div class="amount">TZS ${amountPaid.toLocaleString()}</div>
    <div class="details">
      <table>
        <tr><td>Plan</td><td>${planName}</td></tr>
        <tr><td>Duration</td><td>${durationDays} days</td></tr>
        <tr><td>Start Date</td><td>${startDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</td></tr>
        <tr><td>End Date</td><td>${endDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</td></tr>
        <tr><td>Payment Method</td><td>${paymentType === 'card' ? '💳 Card' : '📱 Mobile Money'}</td></tr>
        <tr><td>Reference</td><td>${reference}</td></tr>
        <tr><td>Status</td><td>${statusBadge('active')}</td></tr>
        ${hasSavings ? `<tr><td style="color:#059669; font-weight:700;">You Saved</td><td style="color:#059669; font-weight:700;">TZS ${savings.toLocaleString()} (${discountPercent}%)</td></tr>` : ''}
      </table>
    </div>
    ${hasSavings ? `<p style="background:#d1fae5; padding:12px; border-radius:8px; color:#065f46; font-size:14px; margin:16px 0; text-align:center;">🎊 Great deal! You saved <strong>TZS ${savings.toLocaleString()}</strong> by choosing the ${planName} plan!</p>` : ''}
    <p>You now have full access to all ALFEAN ENTERPRISES features:</p>
    <ul style="margin: 12px 0 12px 24px; font-size: 14px; color: #374151;">
      <li>Unlimited products &amp; sales tracking</li>
      <li>Customer management &amp; debt tracking</li>
      <li>Smart reporting &amp; analytics</li>
      <li>Multi-shop support</li>
      <li>Fractional selling (½, ¼, ⅓)</li>
    </ul>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}" class="btn">Open Your Dashboard</a>
      <a href="${APP_URL}/subscription" class="btn btn-outline">Manage Plan</a>
    </p>
    <p style="font-size:13px; color:#9ca3af; text-align:center; margin-top:8px;">Receipt ID: ${reference}</p>
  `;
  return sendEmail({ to, subject: `Subscription Confirmed - ${planName} (Saved TZS ${savings.toLocaleString()})`, html: baseTemplate(content) });
}

// ─── SUBSCRIPTION CONFIRMED (legacy) ────────────────────────────────────────────────────────────────
export async function sendPaymentFailed(opts: {
  to: string;
  tenantName: string;
  planName: string;
  amountTzs: number;
  reason?: string;
}) {
  const { to, tenantName, planName, amountTzs, reason } = opts;
  const content = `
    <h2 style="color:#dc2626;">Payment Failed</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Unfortunately, your payment for <strong>${planName}</strong> could not be processed.</p>
    ${reason ? `<p style="background:#fef2f2; padding:12px; border-radius:8px; color:#991b1b; font-size:14px; margin:16px 0;">Reason: ${reason}</p>` : ''}
    <p>Please check your Mobile Money balance and payment details, then try again.</p>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}/subscription" class="btn">Try Again</a>
      <a href="${APP_URL}/support" class="btn btn-outline">Contact Support</a>
    </p>
  `;
  return sendEmail({ to, subject: `ALFEAN ENTERPRISES Payment Failed - Please Retry`, html: baseTemplate(content) });
}

// ─── SUPPORT TICKET REPLY ───────────────────────────────────────────────────
export async function sendSupportReply(opts: {
  to: string;
  tenantName: string;
  ticketSubject: string;
  ticketId: string;
  reply: string;
  status: string;
}) {
  const { to, tenantName, ticketSubject, ticketId, reply, status } = opts;
  const content = `
    <h2>New Reply on Your Support Ticket</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>There's a new reply to your support ticket:</p>
    <div class="details">
      <p style="font-weight:600; font-size:15px; margin-bottom:4px;">${ticketSubject}</p>
      <p style="font-size:13px; color:#6b7280;">Ticket #${ticketId} &middot; Status: ${statusBadge(status)}</p>
    </div>
    <div style="background:#f9fafb; border-radius:8px; padding:16px; border-left:4px solid #059669; margin:16px 0; font-size:14px; color:#374151; line-height:1.6;">
      ${reply.replace(/\n/g, '<br>')}
    </div>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}/support" class="btn">View Ticket</a>
    </p>
  `;
  return sendEmail({ to, subject: `Re: [Ticket #${ticketId}] ${ticketSubject}`, html: baseTemplate(content) });
}

// ─── SUPPORT TICKET CREATED ────────────────────────────────────────────────────
export async function sendSupportTicketCreated(opts: {
  to: string;
  tenantName: string;
  subject: string;
  ticketId: string;
  priority: string;
}) {
  const { to, tenantName, subject, ticketId, priority } = opts;
  const content = `
    <h2>Support Ticket Received</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>We've received your support ticket. Our team will respond within 24 hours.</p>
    <div class="details">
      <p style="font-weight:600; font-size:15px; margin-bottom:4px;">${subject}</p>
      <p style="font-size:13px; color:#6b7280;">Ticket #${ticketId} &middot; Priority: ${statusBadge(priority)}</p>
    </div>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}/support" class="btn">View Ticket</a>
    </p>
  `;
  return sendEmail({ to, subject: `[Ticket #${ticketId}] ${subject}`, html: baseTemplate(content) });
}

// ─── SUPPORT CHAT ALERT TO DEVELOPER ────────────────────────────────────────
// Fired the moment a customer sends a live-chat message so the developer can
// jump in fast. Includes who they are, their shop and whether they pay.
export async function sendSupportMessageAlert(opts: {
  userName?: string;
  userEmail?: string;
  userPhone?: string;
  shopName?: string;
  tenantName?: string;
  accountStatus?: string;
  subject?: string;
  message: string;
  chatId: string;
  isFirstMessage?: boolean;
  aiFailed?: boolean;
}) {
  const {
    userName, userEmail, userPhone, shopName, tenantName,
    accountStatus, subject, message, chatId, isFirstMessage, aiFailed,
  } = opts;
  const adminEmail = process.env.SUPPORT_ALERT_EMAIL || process.env.ERROR_ALERT_EMAIL || process.env.SUPER_ADMIN_EMAIL || REPLY_TO_EMAIL;
  const esc = (v?: string) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[ch]);

  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto;">
      <div style="background: #059669; padding: 18px 20px; border-radius: 8px 8px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 19px;">💬 ${isFirstMessage ? 'New support chat' : 'New support message'}</h1>
        <p style="color: #d1fae5; margin: 4px 0 0; font-size: 13px;">
          ${aiFailed ? '⚠️ AI haikuweza kujibu — mteja anahitaji msaada wa binadamu' : 'Reply from the Developer Dashboard → Support chat'}
        </p>
      </div>
      <div style="background: #fff; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600; width: 130px;">Customer</td><td style="padding: 6px 0; color: #111827; font-weight: 600;">${esc(userName) || 'Unknown'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">Email</td><td style="padding: 6px 0; color: #111827;">${esc(userEmail) || '-'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">Phone</td><td style="padding: 6px 0; color: #111827;">${esc(userPhone) || '-'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">Shop</td><td style="padding: 6px 0; color: #111827;">${esc(shopName) || esc(tenantName) || '-'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">Account</td><td style="padding: 6px 0; color: #111827;">${esc(accountStatus) || 'Unknown'}</td></tr>
          ${subject ? `<tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">Subject</td><td style="padding: 6px 0; color: #111827;">${esc(subject)}</td></tr>` : ''}
        </table>
        <div style="background: #f9fafb; border-left: 4px solid #059669; border-radius: 6px; padding: 14px; margin: 14px 0;">
          <p style="margin: 0 0 6px; font-size: 12px; color: #6b7280; font-weight: 600;">Message:</p>
          <p style="margin: 0; font-size: 14px; color: #111827; white-space: pre-wrap; word-break: break-word;">${esc(message)}</p>
        </div>
        <p style="text-align:center; margin-top: 18px;">
          <a href="${APP_URL}/developer" style="display:inline-block; background:#059669; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:600; font-size:14px;">Open Support Chat</a>
        </p>
        <p style="font-size: 11px; color:#9ca3af; text-align:center; margin-top: 14px;">Automated alert from ALFEAN ENTERPRISES live chat · Chat #${esc(String(chatId).slice(0, 8))}</p>
      </div>
    </div>`;

  return sendEmail({
    to: adminEmail,
    subject: `💬 [ALFEAN ENTERPRISES Support] ${userName || 'Customer'}${shopName ? ` (${shopName})` : ''} — ${String(subject || message).slice(0, 60)}`,
    html: content,
  });
}

// ─── PASSWORD RESET ───────────────────────────────────────────────────────────────
export async function sendPasswordReset(opts: {
  to: string;
  tenantName: string;
  resetLink: string;
}) {
  const { to, tenantName, resetLink } = opts;
  const content = `
    <h2>Password Reset Request</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>We received a request to reset your ALFEAN ENTERPRISES password. Click the button below to set a new password:</p>
    <p style="text-align:center; margin: 24px 0;">
      <a href="${resetLink}" class="btn">Reset Password</a>
    </p>
    <p style="font-size:13px; color:#9ca3af;">This link expires in 1 hour. If you didn't request this, please ignore this email.</p>
  `;
  return sendEmail({ to, subject: `Reset Your ALFEAN ENTERPRISES Password`, html: baseTemplate(content) });
}

// ─── EMAIL VERIFICATION ──────────────────────────────────────────────────────
// Sent on sign-up (and again if an unverified user tries to sign in). The link
// points at Better Auth's verify endpoint and returns the user to the login
// page with a success flag.
export async function sendVerificationEmail(opts: {
  to: string;
  name?: string;
  verifyLink: string;
}) {
  const { to, name, verifyLink } = opts;
  const content = `
    <h2>Verify Your Email</h2>
    <p>Hi <strong>${name || to.split('@')[0]}</strong>,</p>
    <p>Welcome to ALFEAN ENTERPRISES! Please confirm this email address to activate your account:</p>
    <p style="text-align:center; margin: 24px 0;">
      <a href="${verifyLink}" class="btn">Verify Email</a>
    </p>
    <p style="font-size:13px; color:#9ca3af;">This link expires in 1 hour. If you didn't create an ALFEAN ENTERPRISES account, you can safely ignore this email.</p>
  `;
  return sendEmail({
    to,
    subject: 'Verify your ALFEAN ENTERPRISES email address',
    html: baseTemplate(content),
    name,
    templateKey: 'email_verification',
  });
}

// ─── ERROR ALERT EMAIL ─────────────────────────────────────────────────────────────
export async function sendErrorAlert(opts: {
  errorType: string;
  message: string;
  requestPath?: string;
  requestMethod?: string;
  userId?: string;
  stackTrace?: string;
}) {
  const { errorType, message, requestPath, requestMethod, userId, stackTrace } = opts;
  const adminEmail = process.env.ERROR_ALERT_EMAIL || process.env.SUPER_ADMIN_EMAIL || 'admin@gmail.com';
  
  const content = `
    <div style="font-family: monospace; max-width: 600px; margin: 0 auto;">
      <div style="background: #dc2626; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 20px;">⚠️ System Error Alert</h1>
        <p style="color: #fecaca; margin: 4px 0 0; font-size: 13px;">Action required — review and fix</p>
      </div>
      <div style="background: #fff; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600; width: 120px;">Type</td><td style="padding: 6px 0; color: #111827;"><span style="background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">${errorType}</span></td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">Path</td><td style="padding: 6px 0; color: #111827; font-family: monospace;">${requestMethod || '?'} ${requestPath || '/'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">Time</td><td style="padding: 6px 0; color: #111827;">${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam' })} EAT</td></tr>
          <tr><td style="padding: 6px 0; color: #6b7280; font-weight: 600;">User ID</td><td style="padding: 6px 0; color: #111827; font-family: monospace; font-size: 11px;">${userId || 'anonymous'}</td></tr>
        </table>
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px; margin: 12px 0;">
          <p style="margin: 0 0 4px; font-size: 12px; color: #991b1b; font-weight: 600;">Error Message:</p>
          <p style="margin: 0; font-size: 12px; color: #b91c1c; font-family: monospace; white-space: pre-wrap; word-break: break-all;">${(message || 'No message').substring(0, 1000)}</p>
        </div>
        ${stackTrace ? `
        <details style="margin: 8px 0;">
          <summary style="font-size: 12px; color: #6b7280; cursor: pointer;">View Stack Trace</summary>
          <pre style="background: #1f2937; color: #d1d5db; padding: 12px; border-radius: 6px; font-size: 11px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; margin-top: 8px;">${stackTrace.substring(0, 2000)}</pre>
        </details>` : ''}
        <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 12px; margin: 12px 0;">
          <p style="margin: 0; font-size: 12px; color: #9a3412;">To view all errors: <a href="${APP_URL}/" style="color: #059669;">Log in to Developer Dashboard</a> &rarr; System Health tab</p>
        </div>
        <p style="font-size: 11px; color: #9ca3af; text-align: center; margin-top: 16px;">This is an automated alert from ALFEAN ENTERPRISES. Errors are debounced — repeated errors are grouped.</p>
      </div>
    </div>`;

  return sendEmail({
    to: adminEmail,
    subject: `⚠️ [ALFEAN ENTERPRISES Error] ${errorType} — ${requestPath || ''}`,
    html: content,
  });
}

// ─── SLOW PAGE ALERT EMAIL ─────────────────────────────────────────────────────
export async function sendSlowPageAlert(opts: {
  kind: string;
  url: string;
  route: string;
  loadMs: number;
  payload?: any;
}) {
  const { kind, url, route, loadMs, payload = {} } = opts;

  const kindLabels: Record<string, string> = {
    'initial-load': 'Initial page load was slow',
    'app-ready': 'App took too long to become ready',
    'app-stuck': 'App never became ready (stuck/white screen)',
    'dashboard-data': 'Dashboard data stuck loading',
  };
  const label = kindLabels[kind] || kind;

  const user = payload.user || {};
  const breakdown = payload.breakdown || {};
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(String(payload.userAgent || ''));
  const deviceEmoji = isMobile ? '📱' : '🖥️';

  const content = `
    <h2 style="color:#d97706;">🐢 Slow Page Alert</h2>
    <p><strong>${label}</strong> — a user's page took over <strong>1 minute</strong> to load.</p>
    <div style="background:#fff7ed; border:1px solid #fed7aa; border-radius:6px; padding:12px; margin:12px 0;">
      <p style="margin:0; font-size:13px; color:#9a3412;">Page: <a href="${url}" style="color:#059669;">${url || '/'}</a></p>
      <p style="margin:4px 0 0; font-size:13px; color:#9a3412;">Load time: <strong>${(loadMs / 1000).toFixed(1)}s</strong> (threshold 60s)</p>
    </div>
    <div class="details">
      <table>
        <tr><td>Route</td><td style="font-family:monospace;">${route || '/'}</td></tr>
        <tr><td>Kind</td><td>${kind}</td></tr>
        <tr><td>Time</td><td>${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam' })} EAT</td></tr>
        <tr><td>User</td><td>${user.name ? `${user.name} (${user.email || 'no email'})` : 'anonymous'}</td></tr>
        <tr><td>Role</td><td>${user.role || 'unknown'}</td></tr>
        <tr><td>User ID</td><td style="font-family:monospace; font-size:11px;">${user.id || '—'}</td></tr>
        <tr><td>Tenant</td><td>${payload.tenantName || payload.tenantId || '—'}</td></tr>
        <tr><td>Shop</td><td>${payload.shopName || payload.shopId || '—'}</td></tr>
        <tr><td>Device</td><td>${deviceEmoji} ${isMobile ? 'Mobile' : 'Desktop'}</td></tr>
      </table>
    </div>
    ${Object.keys(breakdown).length ? `
    <div style="background:#f9fafb; border-radius:8px; padding:12px; margin:12px 0; font-size:12px;">
      <p style="margin:0 0 6px; font-weight:600; color:#374151;">Timing breakdown:</p>
      <table style="width:100%; border-collapse:collapse;">
        ${Object.entries(breakdown).map(([k, v]) =>
          `<tr><td style="padding:2px 0; color:#6b7280;">${k}</td><td style="padding:2px 0; text-align:right; color:#111827; font-family:monospace;">${Number(v) > 1000 ? (Number(v) / 1000).toFixed(1) + 's' : v}</td></tr>`
        ).join('')}
      </table>
    </div>` : ''}
    <p style="font-size:12px; color:#6b7280; margin:4px 0;">UA: <span style="font-family:monospace; word-break:break-all;">${String(payload.userAgent || '—').substring(0, 300)}</span></p>
    ${payload.onLine === false ? '<p style="font-size:12px; color:#b91c1c;">⚠️ Device was <strong>offline</strong> when this was reported.</p>' : ''}
    ${payload.effectiveType ? `<p style="font-size:12px; color:#6b7280;">Connection: ${payload.effectiveType}${payload.deviceMemory ? ` · Device memory: ${payload.deviceMemory}GB` : ''}</p>` : ''}
    ${payload.storageBytes ? `<p style="font-size:12px; color:#6b7280;">localStorage usage: ${(payload.storageBytes / 1024).toFixed(1)} KB</p>` : ''}
    <p style="font-size:11px; color:#9ca3af; text-align:center; margin-top:16px;">Automated performance alert from ALFEAN ENTERPRISES. Reports are deduplicated — repeated slow loads for the same page are grouped.</p>
  `;

  return sendEmail({
    to: process.env.PERFORMANCE_ALERT_EMAIL || process.env.ERROR_ALERT_EMAIL || process.env.SUPER_ADMIN_EMAIL || REPLY_TO_EMAIL,
    subject: `🐢 [ALFEAN ENTERPRISES Slow Page] ${route || url || '/'} — ${(loadMs / 1000).toFixed(0)}s`,
    html: baseTemplate(content),
    templateKey: 'slow_page',
  });
}

// ─── WELCOME EMAIL ───────────────────────────────────────────────────────────────
export async function sendWelcome(opts: {
  to: string;
  tenantName: string;
  shopName: string;
}) {
  const { to, tenantName, shopName } = opts;
  const content = `
    <h2>Welcome to ALFEAN ENTERPRISES!</h2>
    <p>Hi <strong>${tenantName}</strong>,</p>
    <p>Thank you for joining ALFEAN ENTERPRISES. Your shop <strong>${shopName}</strong> is ready to use!</p>
    <p>Here's what you can do next:</p>
    <ul style="margin: 12px 0 12px 24px; font-size: 14px; color: #374151;">
      <li>Add your products and services</li>
      <li>Invite your team members</li>
      <li>Start recording sales</li>
      <li>Track your business performance</li>
    </ul>
    <p style="text-align:center; margin-top: 20px;">
      <a href="${APP_URL}" class="btn">Start Using ALFEAN ENTERPRISES</a>
    </p>
  `;
  return sendEmail({ to, subject: `Welcome to ALFEAN ENTERPRISES!`, html: baseTemplate(content) });
}

// ─── CRON: Expiration Reminders ──────────────────────────────────────────────
export async function sendExpirationReminders() {
  const now = new Date();
  const in10Days = new Date(now);
  in10Days.setDate(in10Days.getDate() + 10);
  const in3Days = new Date(now);
  in3Days.setDate(in3Days.getDate() + 3);
  const in1Day = new Date(now);
  in1Day.setDate(in1Day.getDate() + 1);

  const subs = await pool.query(`
    SELECT ts.id, ts.current_period_end, ts.status,
           t.name as tenant_name, t.email as tenant_email,
           sp.name as plan_name, sp.duration_days
    FROM tenant_subscriptions ts
    JOIN tenants t ON t.id = ts.tenant_id
    JOIN subscription_plans sp ON sp.id = ts.plan_id
    WHERE ts.status = 'active'
      AND t.email IS NOT NULL
      AND t.email != ''
  `);

  let sent = 0;
  for (const sub of subs.rows) {
    const expiry = new Date(sub.current_period_end);
    const daysRemaining = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysRemaining === 10) {
      await sendExpirationReminder({
        to: sub.tenant_email,
        tenantName: sub.tenant_name,
        planName: sub.plan_name,
        daysRemaining: 10,
        expiryDate: expiry,
      });
      sent++;
    } else if (daysRemaining === 3) {
      await sendExpirationReminder({
        to: sub.tenant_email,
        tenantName: sub.tenant_name,
        planName: sub.plan_name,
        daysRemaining: 3,
        expiryDate: expiry,
      });
      sent++;
    } else if (daysRemaining === 1) {
      await sendExpirationReminder({
        to: sub.tenant_email,
        tenantName: sub.tenant_name,
        planName: sub.plan_name,
        daysRemaining: 1,
        expiryDate: expiry,
      });
      sent++;
    }
  }

  return { sent };
}

// ─── CRON: Expire Subscriptions ──────────────────────────────────────────────
export async function expireSubscriptions() {
  const now = new Date();
  const result = await pool.query(`
    UPDATE tenant_subscriptions
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active' AND current_period_end < $1
    RETURNING id, tenant_id
  `, [now]);

  return { expired: result.rowCount ?? 0 };
}

async function generateDailyMarketingContent(day: number): Promise<string> {
  const appUrl = APP_URL;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return '';

  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: 'You are a marketing email copywriter for ALFEAN ENTERPRISES POS. Return ONLY JSON with "html".' },
          { role: 'user', content: `Write a marketing email (day ${day} of a daily series) highlighting ONE unique feature of ALFEAN ENTERPRISES POS system for hardware stores in Tanzania.

Rotate through the FULL feature catalog below in order (use feature at index ${day} % ${JB_FEATURES.length} = ${day % JB_FEATURES.length}). Every feature must eventually be covered — never skip one.

Feature catalog:
${JB_FEATURES.map((f, i) => `${i + 1}. ${f.title}: ${f.desc}`).join('\n')}

Write email in Swahili (mix with English where natural). Include:
- Short intro about the feature
- Why it matters for hardware store owners
- A concrete tip on how to use it in the app

- CTA: "Jaribu Sasa" → ${appUrl}
- Use inline styles, green brand (#059669 → #10b981)
- Keep under 200 words
- Subject field
- Return JSON: {"subject": "...", "html": "..."}` },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    const parsed = JSON.parse(response.data.choices[0].message.content);
    return parsed.html || '';
  } catch (e: any) {
    console.error('[DailyMarketing] AI generation failed:', e.message);
    return '';
  }
}

// ─── FULL FEATURE CATALOG (NEWEST FIRST) ─────────────────────────────────────────────
// Ordered so the daily email rotation starts with the biggest/most recent features.
// Keep every capability of the system listed here so nothing is left out of the emails.
// Bump MARKETING_CATALOG_VERSION whenever you add/reorder features so the rotation
// restarts from the top (newest features first) for all tenants.
const MARKETING_CATALOG_VERSION = 1;
const JB_FEATURES = [
  {
    title: 'Advanced Permission & Role Control',
    desc: 'Admin anaweza kuamua hasa kila muuzaji anaweza kuona na kufanya nini — faida, mapato, bei za kununulia, ripoti, mapato (earnings), SMS, kuongeza/kuhariri bidhaa, na kubadilisha stock. Huduma kwa kila mwajiri, usalama kwa kila duka.',
  },
  {
    title: 'AI Intelligence',
    desc: 'Akili bandia inachambua biashara yako: utabiri wa mauzo ya siku zijazo, muhtasari wa faida na gharama, na onyo la mabadiliko yasiyo ya kawaida kwenye duka lako.',
  },
  {
    title: 'AI Advisor (AI Coach)',
    desc: 'Muulize AI coach swali lolote la biashara yako na upate jibu sahihi kulingana na data halisi ya duka lako, pamoja na ripoti ya kila siku inayotengenezwa na AI.',
  },
  {
    title: 'SMS Center (Bulk SMS)',
    desc: 'Tuma ujumbe kwa wateja wengi mara moja: ukumbusho wa madeni, matangazo ya bidhaa mpya, na taarifa za duka kupitia SMS.',
  },
  {
    title: 'Earnings Page',
    desc: 'Fuatilia mapato na faida kwa kila kipindi kwa mtazamo wazi — ni biashara gani inaleta faida zaidi na wapi unaweza kuboresha.',
  },
  {
    title: 'In-App Support Chat',
    desc: 'Zungumza moja kwa moja na timu ya msaada wa ALFEAN ENTERPRISES ndani ya mfumo — tatizo lolote, suluhisho la haraka bila kuacha kazi yako.',
  },
  {
    title: 'Smart Notifications',
    desc: 'Pokea arifa za wakati halisi: stock imepungua, madeni yamebaki, mauzo makubwa na mambo mengine muhimu ya duka lako.',
  },
  {
    title: 'Stock Take',
    desc: 'Hesabu hesabu ya bidhaa kwa utaratibu na uthibitisho (approval) — hakuna bidhaa inayopotea bila kujulikana.',
  },
  {
    title: 'Pre-Orders Management',
    desc: 'Pokea na fuatilia maagizo ya wateja kabla ya bidhaa kufika — hakuna agizo linalopotea, kila mteja anaridhika.',
  },
  {
    title: 'Invoice Generation (PDF)',
    desc: 'Tengeneza ankara za kitaalamu kwa PDF kwa kubofya moja — muonekano wa kibiashara kwa wateja wako.',
  },
  {
    title: 'Customer Debt Tracking',
    desc: 'Rekodi na fuatilia madeni ya wateja kwa urahisi — unaweza kuona nani anadaiwa kiasi gani na lini.',
  },
  {
    title: 'Expense Tracking',
    desc: 'Fuatilia gharama zote za duka: kodi, mishahara, usafiri na zaidi — ujue faida halisi ya biashara yako.',
  },
  {
    title: 'Multi-Shop & Multi-Seller',
    desc: 'Simamia maduka na wauzaji wengi kutoka sehemu moja — kila mfanyakazi anaweza kuwa na ruhusa zake.',
  },
  {
    title: 'Smart Reporting & Analytics',
    desc: 'Ripoti za mauzo, faida, gharama na bidhaa zinazouza sana kwa grafu na michoro zinazoeleweka kwa urahisi.',
  },
  {
    title: 'Fast POS (Point of Sale)',
    desc: 'Fanya mauzo kwa haraka na mikono michache tu — mteja asikae kusubiri, biashara iende kasi.',
  },
  {
    title: 'Dimension-Based Selling',
    desc: 'Uza kwa vipimo: urefu × upana kwa glasi, vigae na alumini — hesabu inajitengeneza yenyewe, kosa linaondolewa.',
  },
  {
    title: 'Barcode Scanning',
    desc: 'Skana barcode kwa kamera au uingie mwenyewe, na chapisha barcode za bidhaa zako — mauzo ya haraka na sahihi.',
  },
  {
    title: 'Multi-Unit Selling',
    desc: 'Uza kwa SQM, MTR, KG, PCS, ROLL na vitengo vingine vilivyo na ubadilishaji wa kawaida — wewe tuamue, mfumo uhesabu.',
  },
  {
    title: 'Fractional Quantities',
    desc: 'Uza sehemu za bidhaa: nusu, robo kwa bidhaa za uzani na urefu (mabati, mabomba, nyaya).',
  },
  {
    title: 'Full-Text Product Search',
    desc: 'Tafuta bidhaa yoyote kwa sekunde — kwa jina, barcode au sehemu ya jina, hata kwenye orodha kubwa.',
  },
  {
    title: 'Multiple Payment Methods',
    desc: 'Kubali malipo kwa Cash, Lipa Namba (M-Pesa), Benki na mkopo (debt) — wateja walipie namna inavyowafaa.',
  },
  {
    title: 'Offline-Capable PWA',
    desc: 'Endeleza mauzo hata bila internet — mfumo unafanya kazi nje ya mtandao na kusawazisha data inaporudia.',
  },
  {
    title: 'Product Import & Export (CSV)',
    desc: 'Ongeza bidhaa nyingi kwa pamoja kutoka faili ya CSV, na hifadhi nakala za bidhaa zako kwa kusafirisha.',
  },
  {
    title: 'Low-Stock Alerts',
    desc: 'Pata onyo bidhaa inapokaribia kuisha — usikose uuzaji kwa sababu ya ukosefu wa bidhaa.',
  },
  {
    title: 'Subscription & Billing',
    desc: 'Lipia mfumo kwa mwezi au mwaka kwa urahisi na uone hali ya usajili wako wakati wowote.',
  },
  {
    title: 'Automatic Backups',
    desc: 'Data yako inahifadhiwa kiotomatiki — biashara yako iko salama hata kama kifaa kitaharibika.',
  },
];

async function savePendingContent(key: string, html: string, subject: string) {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_pending'`);
    let pending: Record<string, any> = {};
    if (result.rows.length > 0) {
      pending = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
    }
    pending[key] = { html, subject, scheduledFor: null, updatedAt: new Date().toISOString() };
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('email_pending', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(pending)]
    );
  } catch (e: any) {
    console.error(`[PendingContent] Failed to save for ${key}:`, e.message);
  }
}

async function consumePendingContent(key: string): Promise<{ html: string; subject: string } | null> {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_pending'`);
    if (!result.rows.length) return null;
    const pending = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
    const content = pending[key];
    if (!content) return null;

    // Remove consumed content
    delete pending[key];
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('email_pending', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(pending)]
    );
    return content;
  } catch {
    return null;
  }
}

// Send every unsent/pending email via Resend:
//  1) pending WELCOME emails (users with welcome_email_sent = false)
//  2) pending CAMPAIGN recipients (email_campaign_recipients status = 'pending')
export async function sendPendingEmails(): Promise<{
  attempted: number;
  sent: number;
  failed: number;
  welcome: { attempted: number; sent: number; failed: number };
  campaign: { attempted: number; sent: number; failed: number };
}> {
  const summary = {
    sent: 0, failed: 0, attempted: 0,
    welcome: { attempted: 0, sent: 0, failed: 0 },
    campaign: { attempted: 0, sent: 0, failed: 0 },
  };

  // 1) Pending welcome emails
  try {
    const usersRes = await pool.query(`
      SELECT id, email, name FROM "user"
      WHERE email IS NOT NULL AND email != ''
        AND (welcome_email_sent IS NULL OR welcome_email_sent = false)
      LIMIT 500
    `);
    for (const u of usersRes.rows) {
      summary.welcome.attempted++;
      summary.attempted++;
      try {
        const result = await sendWelcomeEmail({ to: u.email, name: u.name, userId: u.id });
        if (result.success) { summary.sent++; summary.welcome.sent++; }
        else { summary.failed++; summary.welcome.failed++; }
      } catch {
        summary.failed++; summary.welcome.failed++;
      }
    }
  } catch (e: any) {
    console.error('[Email] Failed to query pending welcome users:', e.message);
  }

  // 2) Pending campaign recipients
  try {
    const pendRes = await pool.query(`
      SELECT ecr.id, ecr.campaign_id, ecr.email, ecr.name, ec.subject, ec.html_content
      FROM email_campaign_recipients ecr
      JOIN email_campaigns ec ON ec.id = ecr.campaign_id
      WHERE ecr.status = 'pending'
      LIMIT 500
    `);
    for (const r of pendRes.rows) {
      summary.campaign.attempted++;
      summary.attempted++;
      try {
        const result = await sendEmail({ to: r.email, subject: r.subject, html: r.html_content, name: r.name });
        if (result.success) {
          summary.sent++; summary.campaign.sent++;
          await pool.query(`UPDATE email_campaign_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1`, [r.id]);
        } else {
          summary.failed++; summary.campaign.failed++;
          await pool.query(`UPDATE email_campaign_recipients SET status = 'failed', error_message = $1 WHERE id = $2`,
            [JSON.stringify(result.error), r.id]);
        }
      } catch (e: any) {
        summary.failed++; summary.campaign.failed++;
        await pool.query(`UPDATE email_campaign_recipients SET status = 'failed', error_message = $1 WHERE id = $2`, [e.message, r.id]);
      }
    }
  } catch (e: any) {
    console.error('[Email] Failed to query pending campaign recipients:', e.message);
  }

  return summary;
}

export async function sendDailyMarketingEmail() {
  try {
    const appUrl = APP_URL;

    // Get feature day
    const dayResult = await pool.query(`SELECT value FROM system_settings WHERE key = 'marketing_email_day'`);
    let day = 1;
    if (dayResult.rows.length > 0) {
      day = parseInt(dayResult.rows[0].value, 10) || 1;
    }

    // When the feature catalog grows/changes, restart the rotation from the
    // newest features so the new capabilities surface first for everyone.
    const versionRes = await pool.query(`SELECT value FROM system_settings WHERE key = 'marketing_catalog_version'`);
    const storedVersion = parseInt(versionRes.rows[0]?.value, 10) || 0;
    if (storedVersion < MARKETING_CATALOG_VERSION) {
      day = 1;
      await pool.query(
        `INSERT INTO system_settings (key, value) VALUES ('marketing_catalog_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [String(MARKETING_CATALOG_VERSION)]
      );
    }

    // 1) Prefer TODAY'S BLOG ARTICLE — ONE topic per day: the blog post is the
    //    advanced, detailed version; this email carries only the key points
    //    with a "Soma zaidi kuelewa zaidi" button to the full article. This is
    //    what stops the same topic producing two separate AI emails.
    let html = '';
    let subject = `💡 Tip ya Leo: ALFEAN ENTERPRISES`;
    let fromBlog = false;
    try {
      const blogMarketing = await getTodayBlogMarketing();
      if (blogMarketing) {
        html = blogMarketing.html;
        subject = blogMarketing.subject;
        fromBlog = true;
        console.log(`[DailyMarketing] Using today's blog article: ${blogMarketing.slug}`);
      }
    } catch { /* fall through to the legacy flow */ }

    if (!html) {
      // 2) Legacy flow: pending content first, then generate on the fly.
      const pending = await consumePendingContent('daily_marketing');
      html = pending?.html || '';
      subject = pending?.subject || subject;
      if (!html) {
        html = await generateDailyMarketingContent(day);
      }
    }

    if (!html) {
      console.log('[DailyMarketing] No content, skipping today');
      return { sent: 0, featureDay: day };
    }

    const recipients = await pool.query(
      `SELECT id, name, email FROM tenants WHERE email IS NOT NULL AND email != ''`
    );

    if (recipients.rows.length === 0) {
      console.log('[DailyMarketing] No recipients found');
      return { sent: 0, featureDay: day };
    }

    let sent = 0;
    for (const r of recipients.rows) {
      try {
        const personalizedHtml = html.replace(/\{\{name\}\}/g, r.name || 'Mteja');
        await sendEmail({
          to: r.email,
          subject,
          // The blog email is already a complete, fully-inlined document —
          // wrapping it again in baseTemplate would break the design.
          html: fromBlog ? personalizedHtml : baseTemplate(personalizedHtml),
          name: r.name,
          templateKey: 'daily_marketing',
        });
        sent++;
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (e: any) {
        console.error(`[DailyMarketing] Failed to send to ${r.email}:`, e.message);
      }
    }

    const nextDay = day + 1;
    // Pre-generate tomorrow's tip ONLY when today was not the blog summary —
    // the blog writer already generates one advanced article every morning,
    // so generating another here would double the AI cost and the topic.
    if (!fromBlog) {
      const nextContent = await generateDailyMarketingContent(nextDay);
      if (nextContent) {
        await savePendingContent('daily_marketing', nextContent, `💡 Tip ya Leo: ALFEAN ENTERPRISES`);
      }
    }

    // Save next day
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('marketing_email_day', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(nextDay)]
    );

    console.log(`[DailyMarketing] Sent ${sent}/${recipients.rows.length} emails (day ${day})`);
    return { sent, total: recipients.rows.length, featureDay: day };
  } catch (e: any) {
    console.error('[DailyMarketing] Error:', e.message);
    return { sent: 0, error: e.message };
  }
}

// ─── TRIAL EXPIRING EMAILS (AI-GENERATED) ────────────────────────────────────────────
export async function sendTrialExpiringEmails() {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const appUrl = APP_URL;

    // Get tenants whose trial expires in the next 7 days, no active paid sub
    const tenantsResult = await pool.query(`
      SELECT t.id, t.name, t.email, t.trial_end
      FROM tenants t
      WHERE t.email IS NOT NULL AND t.email != ''
        AND t.trial_activated = true
        AND t.trial_end IS NOT NULL
        AND t.trial_end > NOW()
        AND t.trial_end <= NOW() + INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM tenant_subscriptions ts
          WHERE ts.tenant_id = t.id AND ts.status = 'active'
        )
      ORDER BY t.trial_end ASC
    `);

    if (tenantsResult.rows.length === 0) {
      console.log('[TrialExpiring] No tenants with expiring trials found');
      return { sent: 0 };
    }

    console.log(`[TrialExpiring] Found ${tenantsResult.rows.length} tenant(s) with expiring trials`);
    let sent = 0;

    // Get pricing info for the email
    const plansResult = await pool.query(
      `SELECT name, price_tzs, duration_days, description FROM subscription_plans WHERE is_active = true ORDER BY duration_days ASC`
    );
    const plans = plansResult.rows;

    for (const tenant of tenantsResult.rows) {
      try {
        const daysLeft = Math.ceil((new Date(tenant.trial_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        const planList = plans.map((p: any) => `- ${p.name}: TZS ${Number(p.price_tzs).toLocaleString()} (${p.description || `${p.duration_days} days`})`).join('\n');

        let html = '';
        if (apiKey) {
          try {
            const response = await axios.post(
              'https://api.deepseek.com/chat/completions',
              {
                model: 'deepseek-flash',
                messages: [
                  {
                    role: 'system',
                    content: `You are a marketing email copywriter for ALFEAN ENTERPRISES POS system. Return ONLY valid JSON with a "html" field — no markdown, no code blocks.`
                  },
                  {
                    role: 'user',
                    content: `Write a friendly, persuasive email in Swahili (mix with English where natural) to a hardware store owner whose free trial is ending in ${daysLeft} days.

Context:
- Their trial expires in ${daysLeft} days
- They used ALFEAN ENTERPRISES POS for their hardware/construction store
- They need to subscribe to continue

Pricing:
${planList}

Key features to highlight:
- POS with barcode scanning
- Inventory & stock management
- Customer debt tracking
- Sales reports & profit analytics
- Works offline (PWA)
- Multi-shop & multi-seller support

Requirements:
- Friendly but urgent tone (trial ending soon)
- Explain what they'll lose access to if they don't subscribe
- Highlight key features to convince them
- Include pricing mention
- CTA button: "Subscribe Now → ${appUrl}/subscription"

- Use inline styles, green brand (#059669 → #10b981)
- Under 250 words
- Use {{name}} placeholder
- Return JSON: {"html": "..."}`
                  }
                ],
                response_format: { type: 'json_object' },
                stream: false,
              },
              {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                timeout: 30000,
              }
            );
            const parsed = JSON.parse(response.data.choices[0].message.content);
            html = parsed.html || '';
          } catch (e: any) {
            console.error(`[TrialExpiring] AI generation failed for ${tenant.email}:`, e.message);
          }
        }

        if (!html) {
          // Fallback template if AI fails
          const planRows = plans.map((p: any) =>
            `<tr><td style="padding:8px 0;font-size:14px;">${p.name}</td><td style="padding:8px 0;font-size:14px;font-weight:600;text-align:right;">TZS ${Number(p.price_tzs).toLocaleString()}</td></tr>`
          ).join('');

          html = `
            <h2 style="color:#dc2626;">⏰ Your Free Trial Ends in ${daysLeft} Days</h2>
            <p>Hi {{name}},</p>
            <p>Your <strong>free trial</strong> of ALFEAN ENTERPRISES POS is ending in <strong>${daysLeft} days</strong>. Don't lose access to your business data and sales records!</p>
            <div style="background:#f0fdf4;border-radius:8px;padding:16px;margin:16px 0;">
              <p style="font-size:14px;color:#065f46;margin:0 0 8px;"><strong>What you'll keep with a subscription:</strong></p>
              <ul style="font-size:13px;color:#065f46;margin:0;padding-left:20px;">
                <li>POS with barcode scanning — fast checkout</li>
                <li>Inventory & stock management — never run out</li>
                <li>Customer debt tracking — know who owes you</li>
                <li>Sales reports & profit analytics — grow your business</li>
                <li>Works offline — no internet needed</li>
              </ul>
            </div>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              ${planRows}
            </table>
            <div style="text-align:center;margin:24px 0;">
              <a href="${appUrl}/subscription" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Subscribe Now</a>
            </div>
          `.trim();
        }

        const personalizedHtml = html.replace(/\{\{name\}\}/g, tenant.name || 'Mteja');
        await sendEmail({
          to: tenant.email,
          subject: `⏰ Trial Yako Inaisha siku ${daysLeft} — Jiandikishe Sasa!`,
          html: baseTemplate(personalizedHtml),
          name: tenant.name,
        });
        sent++;

        // Log this reminder was sent
        await pool.query(
          `INSERT INTO system_settings (key, value) VALUES ('trial_reminder_sent_${tenant.id}_${Math.floor(Date.now() / 86400000)}', $1) ON CONFLICT DO NOTHING`,
          [JSON.stringify({ sentAt: new Date(), daysRemaining: daysLeft })]
        );

        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (e: any) {
        console.error(`[TrialExpiring] Failed to send to ${tenant.email}:`, e.message);
      }
    }

    console.log(`[TrialExpiring] Sent ${sent}/${tenantsResult.rows.length} trial-expiring emails`);
    return { sent, total: tenantsResult.rows.length };
  } catch (e: any) {
    console.error('[TrialExpiring] Error:', e.message);
    return { sent: 0, error: e.message };
  }
}