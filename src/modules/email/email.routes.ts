import { Hono } from "hono";
import { pool } from "../../config/drizzle.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { sendEmail, sendBulkToCustomList } from "../../services/email.service.js";
import axios from "axios";

const emailRoutes = new Hono();

const requireSuperAdmin = async (c: any, next: any) => {
  const role = c.get('userRole');
  if (role !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  await next();
};

emailRoutes.use('/*', authMiddleware, requireSuperAdmin);

// ─── EMAIL TEMPLATES ──────────────────────────────────────────────────────────────
const EMAIL_TEMPLATES = [
  {
    key: 'blank',
    name: 'Blank Email',
    description: 'Start from scratch',
    category: 'general',
    subject: '',
    html: '',
  },
  {
    key: 'welcome',
    name: 'Welcome / Onboarding',
    description: 'Welcome new users to the platform',
    category: 'onboarding',
    subject: 'Welcome to ALFEAN ENTERPRISES - Get Started Today!',
    html: `<h2>Welcome to ALFEAN ENTERPRISES!</h2>
<p>Hi {{name}},</p>
<p>We're excited to have you on board. ALFEAN ENTERPRISES is your complete Hardware Store Management System to manage your business efficiently.</p>
<h3>What you can do:</h3>
<ul>
  <li>Track sales and inventory in real-time</li>
  <li>Manage customers and debts</li>
  <li>Generate detailed reports</li>
  <li>Sell products in fractions (½, ¼, ⅓)</li>
</ul>
<p style="text-align:center; margin-top:24px;">
  <a href="{{app_url}}" style="background:#059669;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Start Selling Now</a>
</p>`,
  },
  {
    key: 'trial_expiring',
    name: 'Trial Expiring Soon',
    description: 'Remind users their trial is ending',
    category: 'retention',
    subject: 'Your ALFEAN ENTERPRISES Free Trial is Ending Soon!',
    html: `<h2>⏰ Your Free Trial is Ending Soon</h2>
<p>Hi {{name}},</p>
<p>Your free trial will expire in <strong>{{days_remaining}} days</strong>. Don't lose access to your business data!</p>
<h3>Upgrade now to keep:</h3>
<ul>
  <li>Unlimited product management</li>
  <li>Sales tracking and reports</li>
  <li>Customer and debt management</li>
  <li>All premium features</li>
</ul>
<p style="text-align:center; margin-top:24px;">
  <a href="{{app_url}}/subscription" style="background:#059669;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View Plans & Upgrade</a>
</p>`,
  },
  {
    key: 'feature_announcement',
    name: 'Feature Announcement',
    description: 'Announce new features to users',
    category: 'marketing',
    subject: '🎉 New Feature: {{feature_name}} is Here!',
    html: `<h2>🎉 Exciting New Feature!</h2>
<p>Hi {{name}},</p>
<p>We're thrilled to announce <strong>{{feature_name}}</strong> is now available in your ALFEAN ENTERPRISES account!</p>
<h3>What's new:</h3>
<p>{{feature_description}}</p>
<h3>How to use it:</h3>
<ol>
  <li>{{step_1}}</li>
  <li>{{step_2}}</li>
  <li>{{step_3}}</li>
</ol>
<p style="text-align:center; margin-top:24px;">
  <a href="{{app_url}}" style="background:#059669;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Try It Now</a>
</p>`,
  },
  {
    key: 'promotional',
    name: 'Promotional / Discount',
    description: 'Send promotional offers and discounts',
    category: 'marketing',
    subject: '🔥 Special Offer: {{discount}} Off ALFEAN ENTERPRISES Plans!',
    html: `<h2>🔥 Special Offer Just for You!</h2>
<p>Hi {{name}},</p>
<p>For a limited time, get <strong style="color:#059669;">{{discount}}</strong> on all ALFEAN ENTERPRISES subscription plans!</p>
<div style="background:#f0fdf4;border:2px solid #059669;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
  <p style="font-size:32px;font-weight:800;color:#059669;margin:0;">{{discount}}</p>
  <p style="margin:8px 0 0 0;color:#374151;">On all plans • Use code: <strong>{{promo_code}}</strong></p>
  <p style="margin:8px 0 0 0;font-size:13px;color:#6b7280;">Valid until {{expiry_date}}</p>
</div>
<p style="text-align:center; margin-top:24px;">
  <a href="{{app_url}}/subscription" style="background:#059669;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Claim Your Discount</a>
</p>`,
  },
  {
    key: 'system_maintenance',
    name: 'System Maintenance Notice',
    description: 'Notify users about planned maintenance',
    category: 'system',
    subject: 'Scheduled Maintenance: {{date}}',
    html: `<h2>🔧 Scheduled Maintenance Notice</h2>
<p>Hi {{name}},</p>
<p>We'll be performing scheduled maintenance to improve ALFEAN ENTERPRISES.</p>
<div style="background:#fef3c7;border-radius:8px;padding:16px;margin:16px 0;">
  <p style="margin:0;"><strong>Date:</strong> {{date}}</p>
  <p style="margin:4px 0 0 0;"><strong>Time:</strong> {{time}}</p>
  <p style="margin:4px 0 0 0;"><strong>Duration:</strong> {{duration}}</p>
  <p style="margin:4px 0 0 0;"><strong>Impact:</strong> {{impact}}</p>
</div>
<p>We apologize for any inconvenience. Thank you for your patience.</p>`,
  },
  {
    key: 're_engagement',
    name: 'Re-engagement / Win Back',
    description: 'Bring back inactive users',
    category: 'retention',
    subject: 'We Miss You! Come Back to ALFEAN ENTERPRISES',
    html: `<h2> We Miss You, {{name}}!</h2>
<p>It's been a while since you last used ALFEAN ENTERPRISES. Your business data is still here waiting for you.</p>
<h3>What you've been missing:</h3>
<ul>
  <li>New fractional selling features</li>
  <li>Improved reporting dashboard</li>
  <li>Better inventory management</li>
</ul>
<p style="text-align:center; margin-top:24px;">
  <a href="{{app_url}}" style="background:#059669;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Come Back Now</a>
</p>
<p style="font-size:13px;color:#6b7280;margin-top:16px;">Need help? Reply to this email or contact our support team.</p>`,
  },
];

emailRoutes.get('/templates', async (c) => {
  return c.json({ success: true, data: EMAIL_TEMPLATES });
});

emailRoutes.get('/templates/:key', async (c) => {
  const key = c.req.param('key');
  const template = EMAIL_TEMPLATES.find(t => t.key === key);
  if (!template) {
    return c.json({ success: false, error: 'Template not found' }, 404);
  }
  return c.json({ success: true, data: template });
});

// ─── RECIPIENT PREVIEW ──────────────────────────────────────────────────────────
emailRoutes.get('/recipients/preview', async (c) => {
  const type = c.req.query('type') || 'all';
  let query = '';
  const params: any[] = [];

  switch (type) {
    case 'all':
      query = `SELECT id, name, email FROM tenants WHERE email IS NOT NULL AND email != '' ORDER BY created_at DESC LIMIT 100`;
      break;
    case 'trial_active':
      query = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND t.trial_activated = true AND t.trial_end > NOW() AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()) ORDER BY t.created_at DESC LIMIT 100`;
      break;
    case 'trial_expired':
      query = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND t.trial_activated = true AND t.trial_end <= NOW() AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()) ORDER BY t.created_at DESC LIMIT 100`;
      break;
    case 'paid_active':
      query = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW()) ORDER BY t.created_at DESC LIMIT 100`;
      break;
    case 'trial_not_activated':
      query = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND (t.trial_activated IS NULL OR t.trial_activated = false) ORDER BY t.created_at DESC LIMIT 100`;
      break;
    default:
      query = `SELECT id, name, email FROM tenants WHERE email IS NOT NULL AND email != '' ORDER BY created_at DESC LIMIT 100`;
  }

  const result = await pool.query(query, params);
  const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM (${query.replace(/LIMIT\s+\d+/i, '')}) sub`, params);

  return c.json({
    success: true,
    data: {
      recipients: result.rows,
      totalCount: parseInt(countResult.rows[0].count),
      previewCount: result.rows.length,
    },
  });
});

// ─── SEND CAMPAIGN ──────────────────────────────────────────────────────────────
// Custom list send — emails may be pasted or uploaded and need NOT exist in the
// system. All sends go through Resend.
emailRoutes.post('/send-custom', async (c: any) => {
  const body = await c.req.json();
  const { subject, html, emails } = body;

  if (!subject || !html) {
    return c.json({ success: false, error: 'Subject and content are required' }, 400);
  }
  if (!Array.isArray(emails) || emails.length === 0) {
    return c.json({ success: false, error: 'At least one email address is required' }, 400);
  }
  if (emails.length > 1000) {
    return c.json({ success: false, error: 'Maximum 1000 recipients per batch' }, 400);
  }

  try {
    const result = await sendBulkToCustomList({
      to: emails,
      subject,
      html,
    });
    return c.json({ success: true, data: result });
  } catch (e: any) {
    console.error('[Email Custom Send] Error:', e.message);
    return c.json({ success: false, error: e.message }, 400);
  }
});

emailRoutes.post('/send', async (c: any) => {
  const adminId = c.get('userId');
  const body = await c.req.json();
  const { subject, html, templateKey, recipientType, testEmail, source } = body;

  if (!subject || !html) {
    return c.json({ success: false, error: 'Subject and content are required' }, 400);
  }

  if (!recipientType && !testEmail) {
    return c.json({ success: false, error: 'Recipient type or test email is required' }, 400);
  }

  try {
    // Test email mode
    if (testEmail) {
      const result = await sendEmail({
        to: testEmail,
        subject: `[TEST] ${subject}`,
        html,
        name: 'Test User',
      });

      return c.json({
        success: result.success,
        data: {
          mode: 'test',
          sentTo: testEmail,
          emailId: result.id,
        },
      });
    }

    // Get recipients
    let recipientsQuery = '';
    switch (recipientType) {
      case 'all':
        recipientsQuery = `SELECT id, name, email FROM tenants WHERE email IS NOT NULL AND email != ''`;
        break;
      case 'trial_active':
        recipientsQuery = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND t.trial_activated = true AND t.trial_end > NOW() AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW())`;
        break;
      case 'trial_expired':
        recipientsQuery = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND t.trial_activated = true AND t.trial_end <= NOW() AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW())`;
        break;
      case 'paid_active':
        recipientsQuery = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW())`;
        break;
      case 'trial_not_activated':
        recipientsQuery = `SELECT t.id, t.name, t.email FROM tenants t WHERE t.email IS NOT NULL AND t.email != '' AND (t.trial_activated IS NULL OR t.trial_activated = false)`;
        break;
      default:
        recipientsQuery = `SELECT id, name, email FROM tenants WHERE email IS NOT NULL AND email != ''`;
    }

    const recipientsResult = await pool.query(recipientsQuery);
    const recipients = recipientsResult.rows;

    if (recipients.length === 0) {
      return c.json({ success: false, error: 'No recipients found for this segment' }, 400);
    }

    // Create campaign record
    const campaignResult = await pool.query(`
      INSERT INTO email_campaigns (admin_id, subject, html_content, template_key, recipient_type, recipient_count, status, source)
      VALUES ($1, $2, $3, $4, $5, $6, 'sending', $7)
      RETURNING id
    `, [adminId, subject, html, templateKey || null, recipientType, recipients.length, source || 'manual']);

    const campaignId = campaignResult.rows[0].id;

    // Create recipient records
    for (const r of recipients) {
      await pool.query(`
        INSERT INTO email_campaign_recipients (campaign_id, tenant_id, email, name, status)
        VALUES ($1, $2, $3, $4, 'pending')
      `, [campaignId, r.id, r.email, r.name]);
    }

    // Send emails (batch with delay to avoid rate limits)
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      try {
        const result = await sendEmail({
          to: recipient.email,
          subject,
          html,
          name: recipient.name,
        });

        await pool.query(`
          UPDATE email_campaign_recipients SET status = $1, sent_at = NOW() WHERE campaign_id = $2 AND email = $3
        `, [result.success ? 'sent' : 'failed', campaignId, recipient.email]);

        if (result.success) {
          sentCount++;
        } else {
          failedCount++;
          await pool.query(`
            UPDATE email_campaign_recipients SET error_message = $1 WHERE campaign_id = $2 AND email = $3
          `, [JSON.stringify(result.error), campaignId, recipient.email]);
        }

        // Small delay between sends
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (e: any) {
        failedCount++;
        await pool.query(`
          UPDATE email_campaign_recipients SET status = 'failed', error_message = $1 WHERE campaign_id = $2 AND email = $3
        `, [e.message, campaignId, recipient.email]);
      }
    }

    // Update campaign status
    await pool.query(`
      UPDATE email_campaigns SET status = 'sent', sent_count = $1, failed_count = $2, sent_at = NOW() WHERE id = $3
    `, [sentCount, failedCount, campaignId]);

    return c.json({
      success: true,
      data: {
        campaignId,
        totalRecipients: recipients.length,
        sentCount,
        failedCount,
        mode: 'campaign',
      },
    });
  } catch (e: any) {
    console.error('[Email Send] Error:', e.message);
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ─── CAMPAIGN HISTORY ───────────────────────────────────────────────────────────
emailRoutes.get('/history', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM email_campaigns`);
  const total = parseInt(countResult.rows[0].count);

  const result = await pool.query(`
    SELECT ec.*, u.email as admin_email
    FROM email_campaigns ec
    LEFT JOIN "user" u ON u.id::text = ec.admin_id
    ORDER BY ec.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const campaigns = result.rows.map((r: any) => ({
    id: r.id,
    subject: r.subject,
    templateKey: r.template_key,
    recipientType: r.recipient_type,
    recipientCount: r.recipient_count,
    sentCount: r.sent_count,
    failedCount: r.failed_count,
    status: r.status,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    adminEmail: r.admin_email,
    source: r.source,
  }));

  return c.json({
    success: true,
    data: campaigns,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ─── CAMPAIGN DETAIL ────────────────────────────────────────────────────────────
emailRoutes.get('/history/:id', async (c: any) => {
  const campaignId = c.req.param('id');

  const campaignResult = await pool.query(`
    SELECT ec.*, u.email as admin_email
    FROM email_campaigns ec
    LEFT JOIN "user" u ON u.id::text = ec.admin_id
    WHERE ec.id = $1
  `, [campaignId]);

  if (campaignResult.rows.length === 0) {
    return c.json({ success: false, error: 'Campaign not found' }, 404);
  }

  const campaign = campaignResult.rows[0];

  const recipientsResult = await pool.query(`
    SELECT email, name, status, error_message, sent_at
    FROM email_campaign_recipients
    WHERE campaign_id = $1
    ORDER BY status ASC, sent_at DESC
    LIMIT 200
  `, [campaignId]);

  return c.json({
    success: true,
    data: {
      campaign: {
        id: campaign.id,
        subject: campaign.subject,
        htmlContent: campaign.html_content,
        templateKey: campaign.template_key,
        recipientType: campaign.recipient_type,
        recipientCount: campaign.recipient_count,
        sentCount: campaign.sent_count,
        failedCount: campaign.failed_count,
        status: campaign.status,
        sentAt: campaign.sent_at,
        createdAt: campaign.created_at,
        adminEmail: campaign.admin_email,
      },
      recipients: recipientsResult.rows,
    },
  });
});

// ─── AI GENERATE EMAIL ──────────────────────────────────────────────────────────
emailRoutes.post('/ai-generate', async (c: any) => {
  try {
    const { prompt, recipientType } = await c.req.json();
    if (!prompt) {
      return c.json({ success: false, error: 'Prompt is required' }, 400);
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: false, error: 'DEEPSEEK_API_KEY not configured' }, 500);
    }

    const audienceDescriptions: Record<string, string> = {
      all: 'all registered users (tenants) of the ALFEAN ENTERPRISES POS system',
      trial_active: 'users currently on a free trial',
      trial_expired: 'users whose free trial has expired',
      paid_active: 'users with an active paid subscription',
      trial_not_activated: 'users who registered but have not activated their trial',
    };

    const audienceDesc = audienceDescriptions[recipientType] || 'users of the ALFEAN ENTERPRISES POS system';

    const systemPrompt = `You are an expert email copywriter for ALFEAN ENTERPRISES, a smart POS and business management system built specifically for hardware and construction supply stores in Tanzania.

SYSTEM FEATURES:
- POS with barcode scanning (camera + manual)
- Dimension-based selling: calculate by length×width for glass, aluminium, tiles, etc. (cm or m)
- Multi-unit selling: SQM, MTR, TON, KG, PCS, ROLL, YARD, PKG, BOX, SET, LTR — with custom unit conversions
- Fractional/decimal quantities for weight/length products
- Customer management with debt/credit tracking
- Inventory & stock management with auto-update on sale
- Multi-shop support (manage multiple store locations)
- Multi-seller support (team members)
- Smart reporting & analytics (sales, profits, expenses, earnings)
- Expense tracking
- Pre-orders management
- Stock take (inventory counting)
- Invoice generation (PDF)
- Offline-capable (PWA — works without internet)
- Full-text search across products
- Dashboard with real-time metrics
- Payment methods: Cash, Lipa Namba (M-Pesa/Airtel/Tigo/HaloTel), Bank Transfer, Debt
- Payment gateway: Snippe (Tanzania)
- Subscription billing automation

PRICING (TZS — Tanzanian Shillings):
- Free 30-day trial with full access
- Basic Monthly: TZS 15,000/month
- 3-Month Plan: TZS 40,500 (save 10%)
- 6-Month Plan: TZS 72,000 (save 20%)
- Annual Plan: TZS 120,000 (save 33% — best value)
- Payment via M-Pesa, Airtel Money, Tigo Pesa, HaloTel, Card, QR

BENEFITS:
- Built specifically for Tanzania hardware/construction stores — not a generic POS
- No internet? No problem — works offline as a PWA
- Sell glass, timber, tiles, steel by dimension — not just by piece
- Track customer debts effortlessly
- Know your profit on every sale
- Works on phone, tablet, or computer
- Instant barcode scanning speeds up checkout

Rules:
- Return ONLY valid JSON with "subject" and "html" fields — no markdown, no code blocks, no extra text
- The HTML must be a complete, self-contained email body (NO <html>/<body> tags, just the content)
- Use inline styles, mobile-friendly, brand green gradient (#059669 → #10b981) for headers/buttons
- Tone: professional, warm, appropriate for Tanzanian business owners (mix of English with simple Swahili where natural like "Karibu", "Habari", "Asante")
- Under 300 words, include a clear CTA button
- Use {{name}} and {{app_url}} placeholders — never hardcode names or URLs
- Do NOT include simu, channel, social media or training-video links
- Signature: "ALFEAN ENTERPRISES Team"`;

    const userPrompt = `Write an email aimed at ${audienceDesc}.

Topic/request: ${prompt}`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const content = response.data.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return c.json({ success: false, error: 'AI returned invalid JSON' }, 500);
    }

    return c.json({
      success: true,
      data: {
        subject: parsed.subject || '',
        html: parsed.html || '',
      },
    });
  } catch (e: any) {
    console.error('[AI Generate] Error:', e.response?.data || e.message);
    return c.json({ success: false, error: e.response?.data?.error?.message || e.message }, 500);
  }
});

// ─── DELETE CAMPAIGN ────────────────────────────────────────────────────────────
emailRoutes.delete('/history/:id', async (c: any) => {
  const campaignId = c.req.param('id');
  await pool.query(`DELETE FROM email_campaigns WHERE id = $1`, [campaignId]);
  return c.json({ success: true });
});

// ─── INBOUND EMAILS ────────────────────────────────────────────────────────────
emailRoutes.get('/inbound', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const offset = (page - 1) * limit;

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM inbound_emails`);
    const totalCount = countResult.rows[0].count;

    const result = await pool.query(`
      SELECT id, email_id, "from", subject, created_at, replied_at
      FROM inbound_emails
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return c.json({
      success: true,
      data: {
        emails: result.rows,
        totalCount,
        page,
        limit,
      },
    });
  } catch (e: any) {
    console.error('[Inbound] List error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

emailRoutes.get('/inbound/:id', async (c: any) => {
  try {
    const id = c.req.param('id');
    const result = await pool.query(`SELECT * FROM inbound_emails WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    return c.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    console.error('[Inbound] Detail error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

emailRoutes.post('/inbound/:id/reply', async (c: any) => {
  try {
    const id = c.req.param('id');
    const { html } = await c.req.json();

    if (!html) {
      return c.json({ success: false, error: 'Reply HTML is required' }, 400);
    }

    const emailResult = await pool.query(`SELECT * FROM inbound_emails WHERE id = $1`, [id]);
    if (emailResult.rows.length === 0) {
      return c.json({ success: false, error: 'Email not found' }, 404);
    }

    const email = emailResult.rows[0];
    const recipientEmail = email.from.match(/<([^>]+)>/)?.[1] || email.from;
    const originalSubject = email.subject || '';
    const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
    const messageId = email.message_id || '';

    const result = await sendEmail({
      to: recipientEmail,
      subject,
      html,
      name: 'Support',
    });

    if (!result.success) {
      return c.json({ success: false, error: 'Failed to send reply' }, 500);
    }

    await pool.query(`
      UPDATE inbound_emails SET replied_at = NOW(), reply_html = $1 WHERE id = $2
    `, [html, id]);

    return c.json({ success: true, data: { sentTo: recipientEmail, subject } });
  } catch (e: any) {
    console.error('[Inbound] Reply error:', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default emailRoutes;

