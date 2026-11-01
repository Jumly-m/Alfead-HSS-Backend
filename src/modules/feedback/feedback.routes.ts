import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { sendEmail } from '../../services/email.service.js';

const feedbackRoutes = new Hono();

const DEV_EMAIL = process.env.REPLY_TO_EMAIL || 'webdeveloperinswahili@gmail.com';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';

// POST /feedback - submit feedback (triggered by popup)
feedbackRoutes.post('/', authMiddleware, async (c: any) => {
  const tenantId = c.get('tenantId');
  const user = c.get('user') as any;
  try {
    const { liked, disliked, suggestions } = await c.req.json();
    if (!tenantId) return c.json({ error: 'Tenant required' }, 400);

    // Check existing feedback to avoid duplicates
    const existing = await pool.query(
      `SELECT id FROM user_feedback WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '20 days'`,
      [tenantId]
    );
    if (existing.rows.length > 0) {
      return c.json({ success: true, message: 'Feedback already submitted recently' });
    }

    // Calculate days since tenant creation
    const tenantRes = await pool.query(
      `SELECT created_at FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const daysUsed = tenantRes.rows.length > 0
      ? Math.floor((Date.now() - new Date(tenantRes.rows[0].created_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    const result = await pool.query(
      `INSERT INTO user_feedback (tenant_id, days_used, liked, disliked, suggestions) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, daysUsed, liked || '', disliked || '', suggestions || '']
    );

    // Send email notification to developer
    const tenantName = user?.name || user?.email || 'A user';
    const emailHtml = `
      <h2>New User Feedback</h2>
      <p><strong>User:</strong> ${tenantName}</p>
      <p><strong>Days Used:</strong> ${daysUsed}</p>
      <hr>
      <p><strong>What they like:</strong><br>${liked || '—'}</p>
      <p><strong>What they dislike:</strong><br>${disliked || '—'}</p>
      <p><strong>Suggestions:</strong><br>${suggestions || '—'}</p>
      <hr>
      <p><a href="${APP_URL}/developer?tab=feedback" style="display:inline-block;background:#059669;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">View in Dashboard</a></p>
    `;
    sendEmail({ to: DEV_EMAIL, subject: '💬 New User Feedback Received', html: emailHtml, templateKey: 'feedback_notification' }).catch(e => console.error('[Feedback] Email failed:', e));

    return c.json({ success: true, data: { id: result.rows[0].id } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

const requireDev = async (c: any, next: any) => {
  const role = c.get('userRole');
  if (role !== 'developer') return c.json({ error: 'Developer access required' }, 403);
  await next();
};

// GET /feedback/check - check if user should see the popup (triggered on dashboard)
feedbackRoutes.get('/check', authMiddleware, async (c: any) => {
  const tenantId = c.get('tenantId');
  try {
    if (!tenantId) return c.json({ show: false });

    const tenantRes = await pool.query(`SELECT created_at FROM tenants WHERE id = $1`, [tenantId]);
    if (tenantRes.rows.length === 0) return c.json({ show: false });

    const createdAt = new Date(tenantRes.rows[0].created_at);
    const daysUsed = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

    // Count how many times this user has submitted feedback
    const existing = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM user_feedback WHERE tenant_id = $1`,
      [tenantId]
    );
    const count = existing.rows[0]?.cnt || 0;

    // Already submitted twice -> never show again
    if (count >= 2) return c.json({ show: false, daysUsed });

    // First feedback: show at day 2-3
    if (count === 0 && daysUsed >= 2 && daysUsed <= 3) {
      return c.json({ show: true, daysUsed, round: 1 });
    }

    // Second feedback: show at day 20-22
    if (count === 1 && daysUsed >= 20 && daysUsed <= 22) {
      return c.json({ show: true, daysUsed, round: 2 });
    }

    return c.json({ show: false, daysUsed });
  } catch (e: any) {
    return c.json({ show: false, error: e.message });
  }
});

// GET /admin/feedback - list all feedback (for developer)
feedbackRoutes.get('/admin', authMiddleware, requireDev, async (c: any) => {
  try {
    const status = c.req.query('status') || '';
    let query = `
      SELECT f.id, f.tenant_id, f.days_used, f.liked, f.disliked, f.suggestions,
             f.status, f.created_at, f.reviewed_at,
             t.name as tenant_name, t.email as tenant_email
      FROM user_feedback f
      LEFT JOIN tenants t ON t.id = f.tenant_id
    `;
    const params: any[] = [];
    if (status && ['new', 'reviewed', 'archived'].includes(status)) {
      query += ` WHERE f.status = $1`;
      params.push(status);
    }
    query += ` ORDER BY f.created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// PUT /admin/feedback/:id/review - mark feedback as reviewed
feedbackRoutes.put('/admin/:id/review', authMiddleware, requireDev, async (c: any) => {
  try {
    const id = c.req.param('id');
    await pool.query(
      `UPDATE user_feedback SET status = 'reviewed', reviewed_at = NOW() WHERE id = $1`,
      [id]
    );
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /admin/feedback/analyze - AI analyze all feedback
feedbackRoutes.post('/admin/analyze', authMiddleware, requireDev, async (c: any) => {
  try {
    const result = await pool.query(`
      SELECT liked, disliked, suggestions FROM user_feedback
      WHERE status != 'archived' ORDER BY created_at DESC LIMIT 50
    `);
    if (result.rows.length === 0) {
      return c.json({ success: true, data: { summary: 'No feedback data to analyze yet.' } });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: true, data: { summary: 'DeepSeek API key not configured. Add DEEPSEEK_API_KEY to .env for AI analysis.' } });
    }

    const feedbackText = result.rows.map((r: any, i: number) =>
      `Feedback #${i + 1}:\nLiked: ${r.liked || '—'}\nDisliked: ${r.disliked || '—'}\nSuggestions: ${r.suggestions || '—'}`
    ).join('\n\n');

    const prompt = `You are a product analyst for ALFEAN ENTERPRISES POS system. Analyze the following user feedback and provide a concise actionable summary for the developer.

For each feedback entry, extract:
1. What users like most (top features)
2. What users dislike (pain points)
3. What users request to be added (feature requests)

Then give:
- Top 3 most requested features (with priority: High/Medium/Low)
- Top 3 pain points to fix
- A short recommendation paragraph

User feedback:
${feedbackText}

Format your response in clear markdown with sections.`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    const json: any = await response.json();
    const analysis = json?.choices?.[0]?.message?.content || 'AI analysis failed.';

    return c.json({ success: true, data: { summary: analysis, totalFeedback: result.rows.length } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /admin/feedback/chat - AI chat about feedback
feedbackRoutes.post('/admin/chat', authMiddleware, requireDev, async (c: any) => {
  try {
    const { question } = await c.req.json();
    if (!question?.trim()) return c.json({ error: 'Question required' }, 400);

    const result = await pool.query(`
      SELECT liked, disliked, suggestions, days_used, created_at,
             t.name as tenant_name, t.email as tenant_email
      FROM user_feedback f
      LEFT JOIN tenants t ON t.id = f.tenant_id
      WHERE f.status != 'archived'
      ORDER BY f.created_at DESC LIMIT 50
    `);
    if (result.rows.length === 0) {
      return c.json({ success: true, data: { answer: 'No feedback data available yet.' } });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return c.json({ success: true, data: { answer: 'DeepSeek API key not configured.' } });
    }

    const feedbackText = result.rows.map((r: any, i: number) =>
      `Feedback #${i + 1} (${r.tenant_name || 'Unknown'}, Day ${r.days_used}, ${new Date(r.created_at).toLocaleDateString()}):\nLiked: ${r.liked || '—'}\nDisliked: ${r.disliked || '—'}\nSuggestions: ${r.suggestions || '—'}`
    ).join('\n\n');

    const prompt = `You are a product analyst for ALFEAN ENTERPRISES POS system. Below is the full user feedback dataset.\n\n${feedbackText}\n\nThe developer asks: "${question}"\n\nAnswer concisely based only on this data. If the data is insufficient, say so.`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
      }),
    });

    const json: any = await response.json();
    const answer = json?.choices?.[0]?.message?.content || 'AI analysis failed.';

    return c.json({ success: true, data: { answer } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default feedbackRoutes;
