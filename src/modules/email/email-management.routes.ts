import { Hono } from "hono";
import { pool } from "../../config/drizzle.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { sendEmail, sendWelcomeEmail, sendPendingEmails, getEmailProviderStatus } from "../../services/email.service.js";
import axios from "axios";

const router = new Hono();

const requireSuperAdmin = async (c: any, next: any) => {
  const role = c.get('userRole');
  if (role !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  await next();
};

router.use('/*', authMiddleware, requireSuperAdmin);

const DEFAULT_HTML: Record<string, string> = {
  welcome: `<p>Habari {{name}},</p>
<p>Karibu kwenye <strong>ALFEAN ENTERPRISES POS</strong> — mfumo wako wa kisasa wa mauzo na usimamizi wa biashara Tanzania.</p>
<p>Tunayo furaha kukaribisha! ALFEAN ENTERPRISES POS inakupa uwezo wa:</p>
<ul>
<li>Kusimamia mauzo kwa urahisi</li>
<li>Kufuatilia hesabu kwa wakati halisi</li>
<li>Kutoa ripoti za biashara</li>
<li>Kuhudumia wateja wako kwa haraka</li>
</ul>
<p>Anza sasa kuchunguza vipengele vyote. Kama una swali lolote, usisite kuwasiliana nasi.</p>
<div style="text-align:center;margin:24px 0;">
<a href="{{app_url}}" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Ingia kwenye Akaunti Yako</a>
</div>`,

  daily_marketing: `<p>Habari {{name}},</p>
<p>Hii ni <strong>Tip yako ya Leo</strong> kutoka ALFEAN ENTERPRISES POS — kidokezo cha kukusaidia kuendesha biashara yako kwa ufanisi zaidi.</p>
<p>Je, unajua kuwa ALFEAN ENTERPRISES POS inakuwezesha <strong>kufuatilia mauzo na hesabu zako</strong> kwa urahisi? Kwa kubonyeza kitufe kimoja, unaweza kuona:</p>
<ul>
<li>Mauzo ya leo, wiki hii na mwezi huu</li>
<li>Bidhaa zinazouzwa sana na zilizobaki</li>
<li>Faida halisi ya biashara yako</li>
<li>Wateja wanaokopa na kiasi cha deni</li>
</ul>
<p>Endelea kutumia ALFEAN ENTERPRISES POS kila siku na uboreshe biashara yako!</p>
<div style="text-align:center;margin:24px 0;">
<a href="{{app_url}}" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Jaribu Sasa</a>
</div>`,

  trial_expiring: `<p>Habari {{name}},</p>
<p><strong>Majira yako ya majaribio yanaisha siku {{days_left}}!</strong> Usipoteze data na rekodi zako za biashara.</p>
<p>Kwa kujiandikisha, utaendelea kupata:</p>
<ul>
<li>POS yenye barcode scanning — mauzo ya haraka</li>
<li>Usimamizi wa bidhaa na vitengo mbalimbali</li>
<li>Kufuatilia deni la wateja</li>
<li>Ripoti za mauzo na faida</li>
<li>Inafanya kazi bila intaneti (PWA)</li>
</ul>
<div style="text-align:center;margin:24px 0;">
<a href="{{app_url}}/subscription" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Jiandikishe Sasa</a>
</div>`,

  trial_expired: `<p>Habari {{name}},</p>
<p><strong>Majira yako ya majaribio yameisha.</strong> Huna tena ufikiaji wa vipengele vya ALFEAN ENTERPRISES POS.</p>
<p>Usijali! Unaweza kujiandikisha tena na kuendelea kutumia huduma zetu. Kwa kujiandikisha, utapata:</p>
<ul>
<li>POS na barcode scanning</li>
<li>Usimamizi kamili wa bidhaa na hesabu</li>
<li>Ripoti za mauzo na faida kwa wakati halisi</li>
<li>Msaada wa simu moja kwa moja</li>
</ul>
<div style="text-align:center;margin:24px 0;">
<a href="{{app_url}}/subscription" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Jiandikishe Tena</a>
</div>`,

  promotional: `<p>Habari {{name}},</p>
<p>Tuna <strong>ofa maalum</strong> kwako! Jiandikishe sasa na upate punguzo maalum la kujiandikisha kwa mwezi wa kwanza.</p>
<p>Usikose fursa hii ya kuleta biashara yako kwenye mfumo wa kisasa wa ALFEAN ENTERPRISES POS.</p>
<div style="text-align:center;margin:24px 0;">
<a href="{{app_url}}/subscription" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Pata Ofa Sasa</a>
</div>`,

  subscription_reminder: `<p>Habari {{name}},</p>
<p><strong>Usajili wako utaisha karibu.</strong> Tafadhali hakikisha unalipa kabla ya muda kuisha ili kuepuka kukatizwa kwa huduma.</p>
<p>Bado una siku {{days_remaining}} za kusajiliwa tena. usisubiri mpaka mwisho!</p>
<div style="text-align:center;margin:24px 0;">
<a href="{{app_url}}/subscription" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Lipia Sasa</a>
</div>`,
};

const DEFAULT_TEMPLATES: Record<string, any> = {
  welcome: {
    key: 'welcome',
    name: 'Welcome Email',
    description: 'Sent to new users after registration',
    category: 'onboarding',
    subject: 'Karibu ALFEAN ENTERPRISES! Anza Majaribio Yako ya Siku 30',
    html: DEFAULT_HTML.welcome,
    editable: true,
    schedule: 'on-signup',
    active: true,
  },
  daily_marketing: {
    key: 'daily_marketing',
    name: 'Daily Marketing (Tip ya Leo)',
    description: 'Daily AI-generated feature highlight email sent at 8:00 AM',
    category: 'marketing',
    subject: '💡 Tip ya Leo: ALFEAN ENTERPRISES',
    html: DEFAULT_HTML.daily_marketing,
    editable: true,
    schedule: '0 5 * * *',
    scheduleLabel: '8:00 AM (Daily)',
    active: true,
  },
  trial_expiring: {
    key: 'trial_expiring',
    name: 'Trial Expiring Reminder',
    description: 'Sent to users whose free trial is ending within 7 days',
    category: 'retention',
    subject: '⏰ Trial Yako Inaisha — Jiandikishe Sasa!',
    html: DEFAULT_HTML.trial_expiring,
    editable: true,
    schedule: '0 11 * * *',
    scheduleLabel: '11:00 AM (Daily)',
    active: true,
  },
  trial_expired: {
    key: 'trial_expired',
    name: 'Trial Expired - Subscribe Now',
    description: 'Sent to users after trial has expired, prompting them to subscribe',
    category: 'retention',
    subject: 'Trial Yako Imeisha — Jiandikishe Ili Kuendelea',
    html: DEFAULT_HTML.trial_expired,
    editable: true,
    schedule: '0 12 * * *',
    scheduleLabel: '12:00 PM (Daily)',
    active: false,
  },
  promotional: {
    key: 'promotional',
    name: 'Promotional / Offer',
    description: 'Send promotions, discounts and special offers',
    category: 'marketing',
    subject: '🔥 Ofa Maalum Kwako!',
    html: DEFAULT_HTML.promotional,
    editable: true,
    schedule: 'manual',
    scheduleLabel: 'Manual Only',
    active: true,
  },
  subscription_reminder: {
    key: 'subscription_reminder',
    name: 'Subscription Expiring Reminder',
    description: 'Sent to paid users before their subscription expires',
    category: 'retention',
    subject: '⚠️ Usajili Wako Unaisha Karibu',
    html: DEFAULT_HTML.subscription_reminder,
    editable: true,
    schedule: '0 10 * * *',
    scheduleLabel: '10:00 AM (Daily)',
    active: true,
  },
};

// GET /templates - list all email templates
router.get('/templates', async (c) => {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_templates'`);
    let templates = DEFAULT_TEMPLATES;
    if (result.rows.length > 0) {
      const saved = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      templates = { ...DEFAULT_TEMPLATES, ...saved };
    }
    return c.json({ success: true, data: Object.values(templates) });
  } catch (e: any) {
    return c.json({ success: true, data: Object.values(DEFAULT_TEMPLATES) });
  }
});

// GET /templates/:key - get single template
router.get('/templates/:key', async (c) => {
  const key = c.req.param('key');
  const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_templates'`);
  let templates = DEFAULT_TEMPLATES;
  if (result.rows.length > 0) {
    const saved = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
    templates = { ...DEFAULT_TEMPLATES, ...saved };
  }
  const template = templates[key];
  if (!template) return c.json({ success: false, error: 'Template not found' }, 404);
  return c.json({ success: true, data: template });
});

// PUT /templates/:key - update a template
router.put('/templates/:key', async (c) => {
  try {
    const key = c.req.param('key');
    const updates = await c.req.json();
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_templates'`);
    let templates: Record<string, any> = { ...DEFAULT_TEMPLATES };
    if (result.rows.length > 0) {
      const saved = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      templates = { ...DEFAULT_TEMPLATES, ...saved };
    }
    if (!templates[key]) return c.json({ success: false, error: 'Template not found' }, 404);
    templates[key] = { ...templates[key], ...updates, key };
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('email_templates', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(templates)]
    );
    return c.json({ success: true, data: templates[key] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /schedules - get cron schedule info
router.get('/schedules', async (c) => {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_schedules'`);
    let schedules: Record<string, any> = {
      daily_marketing: { key: 'daily_marketing', cron: '0 5 * * *', label: '8:00 AM (Daily)', description: 'Daily marketing email', enabled: true, lastRun: null, nextRun: null },
      trial_expiring: { key: 'trial_expiring', cron: '0 11 * * *', label: '11:00 AM (Daily)', description: 'Trial expiring reminders', enabled: true, lastRun: null, nextRun: null },
      trial_expired: { key: 'trial_expired', cron: '0 12 * * *', label: '12:00 PM (Daily)', description: 'Trial expired follow-up', enabled: false, lastRun: null, nextRun: null },
      subscription_reminder: { key: 'subscription_reminder', cron: '0 10 * * *', label: '10:00 AM (Daily)', description: 'Paid subscription reminders', enabled: true, lastRun: null, nextRun: null },
      subscription_expiry: { key: 'subscription_expiry', cron: '0 9 * * *', label: '9:00 AM (Daily)', description: 'Mark expired subscriptions', enabled: true, lastRun: null, nextRun: null },
    };
    if (result.rows.length > 0) {
      const saved = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      schedules = { ...schedules, ...saved };
    }
    return c.json({ success: true, data: Object.values(schedules) });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// PUT /schedules - update schedule settings
router.put('/schedules', async (c) => {
  try {
    const updates = await c.req.json();
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_schedules'`);
    let schedules: Record<string, any> = {};
    if (result.rows.length > 0) {
      const saved = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      schedules = { ...saved };
    }
    for (const [key, val] of Object.entries(updates)) {
      schedules[key] = { ...(schedules[key] || {}), ...(val as any), key };
    }
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('email_schedules', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(schedules)]
    );
    return c.json({ success: true, data: schedules });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /ai-generate - generate email content via DeepSeek
router.post('/ai-generate', async (c: any) => {
  try {
    const { prompt, templateKey } = await c.req.json();
    if (!prompt) {
      return c.json({ success: false, error: 'Prompt is required' }, 400);
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: false, error: 'DEEPSEEK_API_KEY not configured' }, 500);
    }

    const templateContext = templateKey ? `This is for the "${templateKey}" email template.` : '';
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: `You are an email marketing copywriter for ALFEAN ENTERPRISES POS (http://127.0.0.1:47831). Return ONLY valid JSON with "html" and optionally "subject" fields. Generate professional HTML email body content with inline styles (NOT full page — just inner content). Brand colors: #059669 (emerald green), #10b981. Use Swahili mixed with English where natural. Our email: support@localhost. Our website: http://127.0.0.1:47831. ${templateContext}` },
          { role: 'user', content: prompt },
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
    return c.json({ success: true, data: { html: parsed.html || '', subject: parsed.subject || '' } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /send-test - send a test email
router.post('/send-test', async (c: any) => {
  try {
    const { templateKey, to, subject, html } = await c.req.json();
    if (!to || !subject || !html) {
      return c.json({ success: false, error: 'To, subject, and html are required' }, 400);
    }
    const result = await sendEmail({ to, subject: `[TEST] ${subject}`, html, name: 'Test Admin' });
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /trigger - trigger a scheduled email type now
router.post('/trigger', async (c: any) => {
  try {
    const { type } = await c.req.json();
    let result;
    switch (type) {
      case 'send_pending':
        // Re-send every unsent/pending email (welcome + campaign recipients) via Resend
        result = await sendPendingEmails();
        break;
      default:
        return c.json({ success: false, error: `Unknown email type: ${type}` }, 400);
    }
    return c.json({ success: true, data: result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /stats - email sending stats
router.get('/stats', async (c) => {
  try {
    const daysAgo = parseInt(c.req.query('days') || '7');
    const stats: Record<string, any> = {};

    // Campaign stats
    const campaignResult = await pool.query(`
      SELECT COUNT(*)::int AS total, COALESCE(SUM(sent_count), 0)::int AS sent, COALESCE(SUM(failed_count), 0)::int AS failed
      FROM email_campaigns WHERE created_at >= NOW() - INTERVAL '1 day' * $1
    `, [daysAgo]);
    stats.campaigns = campaignResult.rows[0];

    // Daily sent count (last 7 days)
    const dailyResult = await pool.query(`
      SELECT DATE(created_at) as day, COUNT(*)::int as count
      FROM email_campaigns WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at) ORDER BY day DESC
    `);
    stats.daily = dailyResult.rows;

    // Welcome email stats
    const welcomeResult = await pool.query(`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE welcome_email_sent = true)::int AS sent,
      COUNT(*) FILTER (WHERE welcome_email_sent = false OR welcome_email_sent IS NULL)::int AS pending
      FROM "user" WHERE created_at >= NOW() - INTERVAL '1 day' * $1
    `, [daysAgo]);
    stats.welcome = welcomeResult.rows[0];

    // Total sent all time
    const totalResult = await pool.query(`SELECT COALESCE(SUM(sent_count), 0)::int AS total FROM email_campaigns`);
    stats.totalSent = totalResult.rows[0].total;

    return c.json({ success: true, data: stats });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /provider - daily provider usage + automatic routing status
router.get('/provider', async (c) => {
  try {
    const status = await getEmailProviderStatus();
    return c.json({ success: true, data: status });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /events - every individual email send, flagged by provider (Unosend/Resend).
// Defaults to the last 24h. Filters: provider, range (24h|7d|30d|all), q (search).
router.get('/events', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
    const offset = (page - 1) * limit;
    const provider = (c.req.query('provider') || '').toLowerCase();
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const range = (c.req.query('range') || '24h').toLowerCase();

    const where: string[] = [];
    const params: any[] = [];
    if (provider === 'unosend' || provider === 'resend') {
      params.push(provider);
      where.push(`provider = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(metadata->>'subject','')) LIKE $${params.length} OR LOWER(COALESCE(template_key,'')) LIKE $${params.length})`);
    }
    if (range === '24h') {
      where.push(`created_at >= NOW() - INTERVAL '24 hours'`);
    } else if (range === '7d') {
      where.push(`created_at >= NOW() - INTERVAL '7 days'`);
    } else if (range === '30d') {
      where.push(`created_at >= NOW() - INTERVAL '30 days'`);
    } // 'all' => no time filter
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Summary counts within the filtered range (used for the report cards).
    const summaryRes = await pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE status IN ('bounced','failed','complained'))::int AS failed,
        COUNT(*) FILTER (WHERE status = 'opened')::int AS opened,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
        COUNT(*) FILTER (WHERE COALESCE(provider,'resend') = 'unosend')::int AS unosend,
        COUNT(*) FILTER (WHERE COALESCE(provider,'resend') = 'resend')::int AS resend
      FROM email_events ${whereSql}
    `, params);
    const summary = summaryRes.rows[0] || {};

    const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM email_events ${whereSql}`, params);
    const total = countRes.rows[0]?.total || 0;

    const res = await pool.query(`
      SELECT id, event_type, template_key, email, provider, status, bounce_reason, metadata, created_at
      FROM email_events ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const events = res.rows.map((r: any) => ({
      id: r.id,
      eventType: r.event_type,
      templateKey: r.template_key,
      email: r.email,
      provider: r.provider || 'resend',
      status: r.status || 'sent',
      bounceReason: r.bounce_reason || '',
      subject: r.metadata?.subject || '',
      refId: r.metadata?.unosendId || r.metadata?.resendId || r.metadata?.id || '',
      createdAt: r.created_at,
    }));

    return c.json({
      success: true,
      data: events,
      summary,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// DELETE /events/:id - delete a single email log entry
router.delete('/events/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await pool.query(`DELETE FROM email_events WHERE id = $1`, [id]);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /pending - get pending (pre-generated) content for all templates
router.get('/pending', async (c) => {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_pending'`);
    let pending: Record<string, any> = {};
    if (result.rows.length > 0) {
      pending = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
    }
    return c.json({ success: true, data: pending });
  } catch {
    return c.json({ success: true, data: {} });
  }
});

// PUT /pending/:key - save pending content for a template
router.put('/pending/:key', async (c) => {
  try {
    const key = c.req.param('key');
    const { html, subject, scheduledFor } = await c.req.json();
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_pending'`);
    let pending: Record<string, any> = {};
    if (result.rows.length > 0) {
      pending = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
    }
    pending[key] = { html, subject: subject || '', scheduledFor: scheduledFor || null, updatedAt: new Date().toISOString() };
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('email_pending', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(pending)]
    );
    return c.json({ success: true, data: pending[key] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// DELETE /pending/:key - clear pending content for a template
router.delete('/pending/:key', async (c) => {
  try {
    const key = c.req.param('key');
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'email_pending'`);
    let pending: Record<string, any> = {};
    if (result.rows.length > 0) {
      pending = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
    }
    delete pending[key];
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('email_pending', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(pending)]
    );
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default router;
