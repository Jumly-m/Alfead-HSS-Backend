import { Hono } from 'hono';
import { authService } from './auth.service.js';
import { registerSchema, loginSchema } from './auth.schema.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { logActivity, logLogin } from '../../utils/activity-logger.js';
import { pool } from '../../config/drizzle.js';

const router = new Hono();

// ─── Brute-force protection for the legacy login route ───────────────────────
// 10 failed attempts per 5 minutes per IP+email. Successful logins reset it.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginRateLimitKey(c: any, email: string): string {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
  return `${ip}|${String(email || '').toLowerCase()}`;
}

function checkLoginRateLimit(c: any, email: string): boolean {
  const key = loginRateLimitKey(c, email);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(c: any, email: string): void {
  const key = loginRateLimitKey(c, email);
  const entry = loginAttempts.get(key);
  if (entry) entry.count += 1;
  else loginAttempts.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  // Keep the map from growing unbounded.
  if (loginAttempts.size > 5000) {
    for (const [k, v] of loginAttempts) if (Date.now() > v.resetAt) loginAttempts.delete(k);
  }
}

router.post('/register', async (c) => {
  const body = await c.req.json();
  try {
    const result = await authService.register(body);
    
    await logActivity({
      userId: result.user.id,
      userName: result.user.name || body.email,
      userEmail: body.email,
      action: 'user_created',
      entityType: 'user',
      entityId: result.user.id,
      details: {
        email: body.email,
        businessName: body.businessName,
        shopId: result.shop.id
      },
      shopId: result.shop.id
    });
    
    return c.json({ success: true, data: result }, 201);
  } catch (error: any) {
    if (error.message?.includes('unique constraint')) {
      return c.json({ success: false, error: 'Email already registered' }, 409);
    }
    if (error.message?.includes('temporary/disposable')) {
      return c.json({ success: false, error: error.message }, 400);
    }
    throw error;
  }
});

router.post('/login', async (c) => {
  const body = await c.req.json();

  if (!checkLoginRateLimit(c, body?.email)) {
    return c.json({ success: false, error: 'Too many login attempts. Please try again in a few minutes.' }, 429);
  }

  try {
    const result = await authService.login(body);

    // Successful login clears the failure counter for this IP+email.
    loginAttempts.delete(loginRateLimitKey(c, body?.email));
    
    await logLogin({
      userId: result.user.id,
      userEmail: result.user.email,
      userName: result.user.name,
      ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
      userAgent: c.req.header('user-agent')
    });
    
    await pool.query(
      `UPDATE "user" SET last_login_at = NOW() WHERE id = $1`,
      [result.user.id]
    ).catch(() => {});
    
    return c.json({ success: true, data: result });
  } catch (error: any) {
    if (error.message === 'Invalid credentials') {
      recordLoginFailure(c, body?.email);
      return c.json({ success: false, error: 'Invalid email or password' }, 401);
    }
    if (error.message === 'Email not verified') {
      return c.json({ success: false, error: 'Email not verified. Check your inbox for the verification link.', code: 'EMAIL_NOT_VERIFIED' }, 403);
    }
    console.error('Login error:', error);
    throw error;
  }
});

router.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const tenantId = c.get('tenantId');
  const userRole = c.get('userRole');
  const shopIds = c.get('shopIds') as string[] | undefined;
  
  // Primary (main) shop = user.shop_id from the users table. This is what the
  // frontend uses to mark the "Main Shop" and to default the active shop on
  // login before any switch.
  let shopId = null;
  try {
    const r = await pool.query(`SELECT shop_id FROM "user" WHERE id = $1`, [userId]);
    shopId = r.rows[0]?.shop_id || null;
  } catch (e) {
    // fall back to first accessible shop if the column lookup fails
    shopId = shopIds && shopIds.length > 0 ? shopIds[0] : null;
  }
  
  return c.json({
    success: true,
    data: {
      user: {
        id: userId,
        role: userRole,
        tenantId: tenantId,
        shopId: shopId
      }
    }
  });
});

export default router;
