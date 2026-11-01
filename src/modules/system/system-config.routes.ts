/**
 * =====================================================
 * SYSTEM CONFIGURATION & VALIDATION
 * =====================================================
 * 
 * This file validates system configuration and provides
 * a setup check endpoint.
 * 
 * Run: POST /api/system/validate-config
 */

import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';

const router = new Hono();

// ─── SECURITY ────────────────────────────────────────────────────────────────
// This module exposes server configuration and database state — it must never
// be reachable by the public. Every route requires a signed-in DEVELOPER.
// (A previous, unused `POST /create-admin` route was removed: it was
// unauthenticated and could have created a developer account.)
router.use('*', authMiddleware);

const requireDeveloper = async (c: any, next: any) => {
  if (c.get('userRole') !== 'developer') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  await next();
};
router.use('*', requireDeveloper);

// Required environment variables
const REQUIRED_VARS = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'JWT_SECRET',
  'SUPER_ADMIN_EMAIL',
  'CORS_ORIGIN',
];

// Optional but recommended
const RECOMMENDED_VARS = [
  'RESEND_API_KEY',
  'UNOSEND_API_KEY',
  'RESEND_DAILY_LIMIT',
  'EMAIL_FROM_NAME',
  'EMAIL_FROM_ADDRESS',
];

/**
 * Validate configuration - check all required env vars exist
 */
const validateConfig = (env: Record<string, string>) => {
  const missing: string[] = [];
  const warnings: string[] = [];
  
  for (const varName of REQUIRED_VARS) {
    if (!env[varName] || env[varName].length < 5) {
      missing.push(varName);
    }
  }
  
  for (const varName of RECOMMENDED_VARS) {
    if (!env[varName]) {
      warnings.push(varName);
    }
  }
  
  // Validate secret lengths
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32) {
    warnings.push('BETTER_AUTH_SECRET should be at least 32 characters');
  }
  
  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
    warnings.push('JWT_SECRET should be at least 32 characters');
  }
  
  return { missing, warnings };
};

/**
 * POST /system/validate-config
 * Validates environment configuration
 */
router.post('/validate-config', async (c) => {
  try {
    const env = process.env as Record<string, string>;
    const { missing, warnings } = validateConfig(env);
    
    const isValid = missing.length === 0;
    
    return c.json({
      success: isValid,
      configured: !missing.length && warnings.length === 0,
      missing,
      warnings,
      message: isValid 
        ? 'All required configuration present' 
        : `Missing ${missing.length} required variable(s)`,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

/**
 * GET /system/setup-status
 * Returns current setup status for the UI
 */
router.get('/setup-status', async (c) => {
  try {
    const env = process.env as Record<string, string>;
    const { missing, warnings } = validateConfig(env);
    
    // Check database connection
    let dbStatus = 'unknown';
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = 'error';
    }
    
    // Check if admin user exists
    let adminStatus = 'unknown';
    try {
      const adminExists = await pool.query(
        "SELECT email FROM users WHERE role = 'developer' LIMIT 1"
      );
      adminStatus = adminExists.rows.length > 0 ? 'exists' : 'not_created';
    } catch (e) {
      adminStatus = 'error';
    }
    
    const needsSetup = missing.length > 0 || dbStatus !== 'connected';
    
    return c.json({
      needsSetup,
      database: dbStatus,
      admin: adminStatus,
      config: {
        missing,
        warnings,
      },
    });
  } catch (error: any) {
    return c.json({ 
      needsSetup: true,
      error: error.message 
    }, 500);
  }
});

/**
 * NOTE: POST /system/create-admin was removed for security. It was
 * unauthenticated and could create a developer account. Developer accounts are
 * created through the normal sign-up flow + SUPER_ADMIN_EMAIL, or manually in
 * the database.
 */

export default router;