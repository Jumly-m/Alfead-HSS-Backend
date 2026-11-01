import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { sendSlowPageAlert } from '../../services/email.service.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';

const performanceRoutes = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();

const THRESHOLD_MS = 60000;
const DEDUPE_WINDOW_MIN = 10;
const EMAIL_THROTTLE_MIN = 5;
const MAX_PER_IP_DAY = 20;

// Public, unauthenticated telemetry endpoint. The client sends it when a page
// load exceeds the threshold (user may be stuck on login/landing, so no session).
performanceRoutes.post('/slow-page', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const kind = String(body.kind || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    const url = String(body.url || '').slice(0, 500);
    const route = String(body.route || '').slice(0, 200);
    const rawLoadMs = Math.round(Number(body.loadMs) || 0);
    // Guard against a client sending an epoch timestamp (Date.now()) instead of
    // a duration. Durations are relative to page load and never exceed ~10 min;
    // anything bigger is bogus and would overflow the load_ms integer column.
    const loadMs = rawLoadMs > 600000 ? 0 : rawLoadMs;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || '';

    if (loadMs < THRESHOLD_MS) {
      return c.json({ success: true, ignored: true, reason: 'below threshold' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Per-IP daily cap to prevent abuse
      const ipCount = await client.query(
        `SELECT COUNT(*)::int AS n FROM performance_alerts WHERE ip = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [ip]
      );
      if ((ipCount.rows[0]?.n || 0) >= MAX_PER_IP_DAY) {
        await client.query('ROLLBACK');
        return c.json({ success: true, ignored: true, reason: 'ip daily cap reached' });
      }

      // Dedupe: skip email if same url+kind was already alerted recently
      const recent = await client.query(
        `SELECT 1 FROM performance_alerts WHERE url = $1 AND kind = $2 AND created_at > NOW() - ($3::int || ' minutes')::interval LIMIT 1`,
        [url, kind, DEDUPE_WINDOW_MIN]
      );
      const dedupeHit = recent.rows.length > 0;

      // Global throttle: max one alert email every N minutes
      const lastEmail = await client.query(
        `SELECT 1 FROM performance_alerts WHERE emailed = true AND created_at > NOW() - ($1::int || ' minutes')::interval LIMIT 1`,
        [EMAIL_THROTTLE_MIN]
      );
      const throttleHit = lastEmail.rows.length > 0;

      const shouldEmail = !dedupeHit && !throttleHit;

      await client.query(
        `INSERT INTO performance_alerts (kind, url, route, load_ms, payload, ip, emailed) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [kind, url, route, loadMs, JSON.stringify(body).slice(0, 8000), ip, shouldEmail]
      );

      await client.query('COMMIT');

      if (shouldEmail) {
        await sendSlowPageAlert({ kind, url, route, loadMs, payload: body });
      }

      return c.json({ success: true, emailed: shouldEmail });
    } catch (e: any) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) {
    console.error('[SlowPage] Failed:', e.message);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Developer/admin: view recent performance alerts
performanceRoutes.use('/alerts', authMiddleware);
performanceRoutes.get('/alerts', async (c) => {
  const role = c.get('userRole');
  if (role !== 'developer' && role !== 'admin' && role !== 'super_admin') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  try {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
    const result = await pool.query(
      `SELECT id, kind, url, route, load_ms, emailed, created_at
       FROM performance_alerts
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    console.error('[SlowPage] List failed:', e.message);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default performanceRoutes;
