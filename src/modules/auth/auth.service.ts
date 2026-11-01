import { db } from '../../config/database.js';
import { hashPassword, comparePassword, generateTokens } from '../../utils/auth.js';
import { pool } from '../../config/drizzle.js';
import { sendWelcomeEmail } from '../../services/email.service.js';
import { formatPhone } from '../../utils/helpers.js';
import { isDisposableEmail, DISPOSABLE_EMAIL_MESSAGE } from '../../utils/disposable-email.js';
import { REQUIRE_EMAIL_VERIFICATION } from '../../utils/email-policy.js';
import type { z } from 'zod';
import type { registerSchema, loginSchema } from './auth.schema.js';

type RegisterInput = z.infer<typeof registerSchema>;
type LoginInput = z.infer<typeof loginSchema>;

async function getTrialDays(): Promise<number> {
  try {
    const result = await pool.query(`SELECT value FROM system_settings WHERE key = 'trial_settings'`);
    if (result.rows.length > 0) {
      const val = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      return val?.defaultDays ?? 14;
    }
  } catch {}
  return 30;
}

export class AuthService {
  async register(data: RegisterInput) {
    const { businessName, email, password, firstName, lastName, phone } = data;

    // Temporary/disposable inboxes are refused up front (same rule as the
    // Better Auth sign-up hook). Accounts created here also start unverified.
    if (isDisposableEmail(email)) {
      throw new Error(DISPOSABLE_EMAIL_MESSAGE);
    }

    const formattedPhone = phone ? formatPhone(phone) : null;
    const passwordHash = await hashPassword(password);
    
    const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const tenantResult = await client.query(
        `INSERT INTO tenants (name, slug, email, phone) VALUES ($1, $2, $3, $4) RETURNING id, name, slug`,
        [businessName, slug, email, formattedPhone]
      );
      const tenant = tenantResult.rows[0];
      const userId = crypto.randomUUID();
      
      await client.query(
        `INSERT INTO "user" (id, email, name, password_hash, role, tenant_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [userId, email, `${firstName || ''} ${lastName || ''}`.trim(), passwordHash, 'admin', tenant.id]
      );
      
      // Create a shop for the self-registered user (admin gets their own shop)
      const shopCode = slug + '-' + Math.random().toString(36).substring(2, 6);
      const shopResult = await client.query(
        `INSERT INTO shops (tenant_id, name, code) VALUES ($1, $2, $3) RETURNING id`,
        [tenant.id, businessName, shopCode]
      );
      const shopId = shopResult.rows[0].id;
      
      // Assign user to their shop as owner
      await client.query(
        `UPDATE "user" SET shop_id = $1 WHERE id = $2`,
        [shopId, userId]
      );
      await client.query(
        `INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, 'owner')`,
        [userId, shopId]
      );
      
      // Auto-activate free trial for new tenant
      const trialDays = await getTrialDays();
      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setDate(trialEnd.getDate() + trialDays);
      await client.query(
        `UPDATE tenants SET trial_start = $1, trial_end = $2, trial_activated = true WHERE id = $3`,
        [now, trialEnd, tenant.id]
      );
      
      await client.query('COMMIT');
      
      sendWelcomeEmail({ to: email, name: `${firstName || ''} ${lastName || ''}`.trim() || businessName, userId }).catch(err =>
        console.error('[WelcomeEmail] Failed to send:', err.message)
      );
      
      const tokens = generateTokens({ userId: userId, tenantId: tenant.id, role: 'admin', shops: [shopId] });
      
      return { tenant, user: { id: userId, email, name: `${firstName} ${lastName}`.trim(), role: 'admin' }, shop: { id: shopId, name: businessName }, ...tokens, trial: { activated: true, days: trialDays, endDate: trialEnd } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
   
   async login(data: LoginInput) {
    const { email, password } = data;
    
    let result;
    try {
      result = await db.query(
        `SELECT id, email, name, password_hash, role, email_verified FROM "user" WHERE LOWER(email) = LOWER($1)`,
        [email]
      );
    } catch (e: any) {
      console.error('[AuthService.login] Query error:', e.message);
      throw new Error('Invalid credentials');
    }
    
    if (!result?.rowCount) {
      throw new Error('Invalid credentials');
    }
    
    const user = result.rows[0];
    
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) throw new Error('Invalid credentials');

    // Same policy as the Better Auth sign-in path: unverified accounts cannot
    // log in (existing accounts were grandfathered at startup).
    if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
      throw new Error('Email not verified');
    }
    
    // Fetch user's shops
    const shopsResult = await db.query(
      `SELECT s.id, s.name, s.code FROM shops s
       JOIN user_shops us ON us.shop_id = s.id
       WHERE us.user_id = $1`,
      [user.id]
    );
    const shops = shopsResult.rows.map((r: any) => ({ id: r.id, name: r.name, code: r.code }));
    
    // Generate real JWT tokens
    const tokens = generateTokens({ 
      userId: user.id, 
      tenantId: user.tenant_id, 
      role: user.role, 
      shops: shops.map((s: any) => s.id) 
    });
    
    return { 
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role, 
        shops 
      }, 
      shop: shops.length > 0 ? shops[0] : null, 
      ...tokens
    };
  }
   
  async refreshToken(refreshToken: string) {
    const { verifyToken, generateTokens } = await import('../../utils/auth.js');
    const payload = verifyToken(refreshToken);
    return generateTokens({ userId: payload.userId, tenantId: payload.tenantId, role: payload.role, shops: payload.shops });
  }
}

export const authService = new AuthService();

