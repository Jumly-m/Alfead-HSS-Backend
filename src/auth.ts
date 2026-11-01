/**
 * =====================================================
 * BETTER AUTH CONFIGURATION
 * =====================================================
 * 
 * This file configures Better Auth - a modern authentication
 * library for handling user registration, login, and sessions.
 * 
 * WHAT IT DOES:
 * - Email/password authentication (users can sign up and login)
 * - Session management via HTTP-only cookies (secure)
 * - Database adapter to connect with PostgreSQL via Drizzle ORM
 * 
 * KEY CONCEPTS:
 * - Session: A user's logged-in state (lasts 7 days)
 * - Cookie: Stored in browser to remember logged-in user
 * - Adapter: Connects auth to database (PostgreSQL)
 * 
 * FOR DEVELOPERS:
 * - To enable email verification: set requireEmailVerification: true
 * - To change session duration: modify expiresIn (in seconds)
 * - To add social login: add OAuth providers (Google, GitHub, etc.)
 * - Add secret key in production: secret: process.env.BETTER_AUTH_SECRET
 */

import * as schema from "./database/better-auth-schema.js";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { dash } from "@better-auth/infra";
import { db } from "./config/drizzle.js";
import { pool } from "./config/drizzle.js";
import bcrypt from "bcryptjs";
import { verifyPassword as verifyScrypt } from "@better-auth/utils/password";
import { isDisposableEmail, DISPOSABLE_EMAIL_MESSAGE } from "./utils/disposable-email.js";
import { REQUIRE_EMAIL_VERIFICATION, EMAIL_PROVIDER_CONFIGURED } from "./utils/email-policy.js";

// ─── EMAIL VERIFICATION POLICY ───────────────────────────────────────────────
// New accounts must confirm their email before they can sign in. Existing
// accounts are grandfathered as verified once (see index.ts startup backfill),
// so nobody who registered before this feature is locked out.

if (REQUIRE_EMAIL_VERIFICATION && !EMAIL_PROVIDER_CONFIGURED) {
  console.warn('[Auth] REQUIRE_EMAIL_VERIFICATION=true but RESEND_API_KEY is not set — verification emails cannot be delivered!');
}
if (!REQUIRE_EMAIL_VERIFICATION) {
  console.warn('[Auth] Email verification is OFF — new accounts are signed in immediately (set REQUIRE_EMAIL_VERIFICATION=true to enable)');
}

/**
 * Password verifier that accepts BOTH hash formats used by this app:
 *  - scrypt  (better-auth default: "salt:key")  -> used for new signups/admin users
 *  - bcrypt  (legacy auth system + pre-fix admin users) -> "$2a$..." or "bcrypt:..."
 * This guarantees previously-registered users keep working after login.
 *
 * Fallback for migrated legacy accounts: if the credential account's stored
 * password does NOT match the typed password, but the user row still has a
 * legacy bcrypt hash in "user.password_hash", verify against that too. This
 * lets accounts that were registered before better-auth keep logging in with
 * their original password without forcing a password reset.
 */
async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  if (typeof hash !== 'string' || !hash) return false;

  const tryBcrypt = async (candidate: string) => {
    let bcryptHash = candidate;
    if (bcryptHash.startsWith('bcrypt:')) bcryptHash = bcryptHash.slice('bcrypt:'.length);
    if (bcryptHash.startsWith('$2')) {
      try {
        return await bcrypt.compare(password, bcryptHash);
      } catch {
        return false;
      }
    }
    return false;
  };

  // Scrypt format (better-auth): "salt:key"
  if (hash.includes(':')) {
    try {
      if (await verifyScrypt(hash, password)) return true;
    } catch {
      // fall through to legacy checks
    }
  } else if (await tryBcrypt(hash)) {
    return true;
  }

  // Legacy fallback: the account row's hash may be stale/unrelated to the
  // current password, but the user row keeps the original bcrypt hash.
  try {
    const r = await pool.query(
      `SELECT u.password_hash FROM account a JOIN "user" u ON u.id = a.user_id
       WHERE a.password = $1 AND u.password_hash IS NOT NULL AND u.password_hash LIKE '$2%'`,
      [hash]
    );
    for (const row of r.rows) {
      if (await tryBcrypt(row.password_hash)) return true;
    }
  } catch {
    // ignore lookup errors
  }

  return false;
}

/**
 * Main authentication configuration
 * 
 * DATABASE ADAPTER:
 * Uses Drizzle ORM to connect to PostgreSQL. The schema defines
 * tables for: users, sessions, accounts, and verification codes.
 * 
 * SESSION COOKIE SETTINGS:
 * - expiresIn: 7 days (how long user stays logged in)
 * - updateAge: 1 day (refresh session activity each day)
 * - cookieCache: Disabled to prevent sync issues
 * 
 * COOKIE ATTRIBUTES (security):
 * - httpOnly: true - JavaScript cannot read the cookie (prevents XSS)
 * - sameSite: "lax" - Cookie sent only on same-site navigation
 * - path: "/" - Available on all pages
 */
// Local offline desktop runs on http://127.0.0.1. `COOKIE_SECURE=false` must
// override NODE_ENV=production, otherwise Better Auth prefixes the cookie with
// __Secure- and the browser refuses to store/send it over plain HTTP.
const useSecureCookies = process.env.COOKIE_SECURE === 'false'
  ? false
  : (process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true');

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: schema,
  }),
  
  // Additional user fields to accept during signup
  user: {
    additionalFields: {
      phone: {
        type: "string",
        required: false,
      },
    },
  },

  // Email and password login configuration
  emailAndPassword: {
    enabled: true,
    // New accounts must verify their email before signing in (existing accounts
    // are grandfathered — see the startup backfill in index.ts).
    requireEmailVerification: REQUIRE_EMAIL_VERIFICATION,
    password: {
      // Accept scrypt (better-auth) AND legacy bcrypt hashes so all
      // previously-registered accounts can still log in.
      verify: verifyPassword,
    },
    sendResetPassword: async ({ user, url, token }, request) => {
      sendPasswordReset({
        to: user.email,
        tenantName: user.name || user.email.split('@')[0],
        resetLink: url,
      });
    },
    onPasswordReset: async ({ user }, request) => {
      console.log(`[PasswordReset] Password reset completed for user ${user.email}`);
    },
  },

  // Email verification: only active when an operator explicitly turns it on.
  // OFF by default, so sign-up creates the account and signs the user in right
  // away — no "check your email" step and no verification email is sent.
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      // Fire-and-forget on purpose (avoids leaking whether an account exists
      // through response timing). Failures are logged for the operator.
      sendEmailVerification({
        to: user.email,
        name: user.name || undefined,
        verifyLink: url,
      })
        .then((r: any) => {
          if (r && r.success === false) {
            console.warn('[Auth] Verification email not sent:', r.reason || 'unknown');
          }
        })
        .catch((e: any) => console.warn('[Auth] Verification email failed:', e?.message));
    },
    sendOnSignUp: REQUIRE_EMAIL_VERIFICATION,
    sendOnSignIn: REQUIRE_EMAIL_VERIFICATION,
    autoSignInAfterVerification: false,
  },
  
  // Admin plugin for admin role management
  plugins: [admin(), dash()],

  // Database hooks: after user is created by Better Auth, create their shop.
  // Before creation, reject temporary/disposable email providers.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (isDisposableEmail(user.email)) {
            console.warn('[Auth] Blocked disposable email sign-up:', user.email);
            throw new APIError('BAD_REQUEST', { message: DISPOSABLE_EMAIL_MESSAGE });
          }
          return { data: user };
        },
        after: async (user) => {
          const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase();
          
          if (SUPER_ADMIN_EMAIL && user.email?.toLowerCase() === SUPER_ADMIN_EMAIL) {
            await pool.query(
              `UPDATE "user" SET role = 'developer' WHERE LOWER(email) = $1`,
              [SUPER_ADMIN_EMAIL]
            );
            console.log('[Auth] Super admin role set for:', SUPER_ADMIN_EMAIL);
          } else if (user.id && user.email) {
            console.log('[Auth] databaseHook: processing user:', user.id, user.email);
            
            await pool.query(
              `UPDATE "user" SET role = 'admin' WHERE id = $1`,
              [user.id]
            );
            console.log('[Auth] databaseHook: role set to admin for:', user.id);
            
            console.log('[Auth] databaseHook: calling createShopForUser for:', user.id);
            await createShopForUser(user.id, user.email, user.name || user.email.split('@')[0], (user as any).phone);
            console.log('[Auth] databaseHook: createShopForUser completed for:', user.id);
          }
        }
      }
    },

    // ─── ONE ACTIVE DEVICE PER ACCOUNT ─────────────────────────────────────
    // Security rule: an account may only be signed in on ONE device at a time.
    // The newest sign-in wins: right after a session is created, every older
    // session for the same account is deleted. The previous device is logged
    // out automatically — its next request finds no session and is rejected
    // with 401, and the web client detects the dead session, returns to the
    // login screen and explains why. Exceptions:
    //   • developer accounts — the platform operator needs multi-device access;
    //   • impersonated sessions — developer-initiated support sessions.
    session: {
      create: {
        after: async (session) => {
          try {
            if (session.impersonatedBy) return;

            const userRes = await pool.query(`SELECT role FROM "user" WHERE id = $1`, [session.userId]);
            if (userRes.rows[0]?.role === 'developer') return;

            // Keep only the session that was just created.
            const removed = await pool.query(
              `DELETE FROM session WHERE user_id = $1 AND id <> $2`,
              [session.userId, session.id]
            );
            if (removed.rowCount) {
              console.log(`[Auth] Single-device login: ended ${removed.rowCount} previous session(s) for user ${session.userId}`);
            }
          } catch (e) {
            // A DB hiccup must not break an otherwise successful sign-in — the
            // new session is already stored. Log it for the operator.
            console.error('[Auth] single-session cleanup failed:', (e as Error)?.message);
          }
        }
      }
    }
  },
  
  // Advanced settings for IP capture and session tracking
  advanced: {
    // Capture IP address from various headers and fallback to localhost
    ipAddress: {
      disableIpTracking: false,
    },
    // Better Auth 1.6 reads cookie overrides from advanced.cookies. Keep the
    // default names and only set attributes so the client/server cookie names
    // remain compatible across upgrades.
    useSecureCookies,
    cookies: {
      session_token: {
        attributes: {
          sameSite: "lax",
          path: "/",
          httpOnly: true,
          secure: useSecureCookies,
        },
      },
      session_data: {
        attributes: {
          sameSite: "lax",
          path: "/",
          httpOnly: true,
          secure: useSecureCookies,
        },
      },
    },
  },
  
  // Session management settings
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: false,
      maxAge: 60 * 60 * 24,
    },
    storeSessionInDatabase: true,
  },

  // Brute-force protection. Better Auth's default limiter is loose (100/min);
  // auth endpoints get strict per-route limits on top of it.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 5 },
      '/forget-password': { window: 60, max: 5 },
      '/reset-password': { window: 60, max: 10 },
      '/send-verification-email': { window: 60, max: 5 },
    },
  },
  
  // Allowed origins for CORS
  trustedOrigins: process.env.CORS_ORIGIN ? 
    process.env.CORS_ORIGIN.split(',') : 
    ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:47831'],
});

/**
 * Creates a new shop and tenant for a newly registered user
 * 
 * WHY THIS FUNCTION EXISTS:
 * This system is multi-tenant - each business gets their own shop.
 * When a user signs up, we automatically create their shop.
 * 
 * PROCESS FLOW:
 * 1. Generate unique shop code from email (e.g., "johngmail" from john@gmail.com)
 * 2. Create a TENANT (represents a business/organization)
 * 3. Create a SHOP under that tenant
 * 4. Update the user record to:
 *    - Assign them to the new shop (shop_id)
 *    - Set their role to 'admin' (full access)
 *    - Associate with tenant (tenant_id)
 * 5. Add user to user_shops table with 'owner' role
 * 
 * @param userId  - The user's ID from Better Auth (UUID)
 * @param email   - User's email (used to generate unique shop code)
 * @param name    - User's name (used as default shop name)
 * @returns       - Object with created shopId and tenantId
 * 
 * EXAMPLE:
 * User: john@gmail.com, "John Doe"
 * Creates: Tenant "John Doe", Shop "John Doe", Code "johndoeabc1"
 * User role set to: admin
 * 
 * NOTE: This is called from index.ts when a new user logs in
 * without a shop assigned.
 */
import { sendWelcomeEmail, sendPasswordReset, sendVerificationEmail as sendEmailVerification } from "./services/email.service.js";
import { formatPhone } from "./utils/helpers.js";

export async function createShopForUser(userId: string, email: string, name: string, phone?: string | null) {
  console.log('[Auth] createShopForUser START:', userId, email, name);
  const formattedPhone = phone ? formatPhone(phone) : null;
  try {
    // Check if user already has a shop (prevents duplicates). Both references
    // are validated against `shops`: `user_shops.shop_id` and `user.shop_id`
    // had no FK on older databases, so a deleted shop can leave a dead id
    // behind. Returning it would strand the account — every shop-scoped
    // INSERT then fails the shops FK (e.g. SMS sender-ID applications).
    const existingShop = await pool.query(
      'SELECT shop_id FROM user_shops WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (existingShop.rows.length > 0) {
      const shopId = existingShop.rows[0].shop_id;
      const tenantResult = await pool.query('SELECT tenant_id FROM shops WHERE id = $1', [shopId]);
      if (tenantResult.rows.length > 0) {
        console.log('[Auth] User already has a shop (user_shops), skipping creation for:', userId);
        return { shopId, tenantId: tenantResult.rows[0]?.tenant_id || null };
      }
      console.warn('[Auth] Stale user_shops entry for user', userId, '- shop', shopId, 'no longer exists');
      await pool.query('DELETE FROM user_shops WHERE user_id = $1 AND shop_id = $2', [userId, shopId]);
    }

    // Also check user.shop_id in the user table as extra safeguard
    const userHasShop = await pool.query(
      'SELECT shop_id FROM "user" WHERE id = $1 AND shop_id IS NOT NULL LIMIT 1',
      [userId]
    );
    if (userHasShop.rows.length > 0) {
      const shopId = userHasShop.rows[0].shop_id;
      const tenantResult = await pool.query('SELECT tenant_id FROM shops WHERE id = $1', [shopId]);
      if (tenantResult.rows.length > 0) {
        console.log('[Auth] User already has shop_id set, skipping creation for:', userId);
        // Ensure user_shops has the entry too
        await pool.query(
          'INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, \'owner\') ON CONFLICT DO NOTHING',
          [userId, shopId]
        );
        return { shopId, tenantId: tenantResult.rows[0]?.tenant_id || null };
      }
      console.warn('[Auth] Stale user.shop_id for user', userId, '- shop', shopId, 'no longer exists; creating a new shop');
      await pool.query('UPDATE "user" SET shop_id = NULL, updated_at = NOW() WHERE id = $1', [userId]);
    }

    // Step 1: Generate unique shop code from email
    // Takes username part of email, removes special chars, adds random suffix
    // Example: "john.doe@gmail.com" -> "johndoegmail" + "abc1"
    const shopCode = email.split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') + 
      Math.random().toString(36).substring(2, 6);
    
    // Step 2: Find existing tenant by email or create new one
    // Handles case where partial signup left an orphan tenant
    const existingTenant = await pool.query(
      'SELECT id FROM tenants WHERE email = $1 LIMIT 1',
      [email]
    );
    let tenantId: string;
    if (existingTenant.rows.length > 0) {
      tenantId = existingTenant.rows[0].id;
      // Update phone if provided and not already set
      if (formattedPhone) {
        await pool.query(`UPDATE tenants SET phone = $1 WHERE id = $2 AND phone IS NULL`, [formattedPhone, tenantId]);
      }
      console.log('[Auth] Found existing tenant for email:', email, tenantId);
    } else {
      const tenantResult = await pool.query(
        `INSERT INTO tenants (name, slug, email, phone) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id`,
        [name || email.split('@')[0], shopCode, email, formattedPhone]
      );
      tenantId = tenantResult.rows[0].id;
    }
    
    // Step 3: Offline desktop has no subscriptions or trials at all. Every
    // business gets unlimited access immediately.
    if (process.env.OFFLINE_MODE === 'true') {
      await pool.query(
        `UPDATE tenants
         SET plan_type = 'unlimited',
             subscription_enabled = false,
             subscription_required = false,
             trial_activated = false,
             trial_start = NULL,
             trial_end = NULL
         WHERE id = $1`,
        [tenantId]
      );
      console.log(`[Auth] Offline mode: unlimited access enabled for tenant ${tenantId}`);
    } else {
      const trialSettingsRes = await pool.query(`SELECT value FROM system_settings WHERE key = 'trial_settings'`);
      const trialSettings = trialSettingsRes.rows[0]?.value || { enabled: true, defaultDays: 14 };
      const trialDays = trialSettings.defaultDays ?? 14;
      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setDate(trialEnd.getDate() + trialDays);
      await pool.query(
        `UPDATE tenants SET trial_start = $1, trial_end = $2, trial_activated = true WHERE id = $3`,
        [now, trialEnd, tenantId]
      );
      console.log(`[Auth] Auto-activated ${trialDays}-day trial for new tenant ${tenantId}`);
    }
    
    // Step 4: Create shop under the tenant
    const shopResult = await pool.query(
      `INSERT INTO shops (tenant_id, name, code, is_super_admin) 
       VALUES ($1, $2, $3, false) 
       RETURNING id`,
      [tenantId, name || email.split('@')[0], shopCode]
    );
    const shopId = shopResult.rows[0].id;
    
    // Step 5: Update user with their new shop, admin role, and phone
    await pool.query(
      `UPDATE "user" SET shop_id = $1, role = 'admin', tenant_id = $2${formattedPhone ? `, phone = $4` : ''} WHERE id = $3`,
      formattedPhone ? [shopId, tenantId, userId, formattedPhone] : [shopId, tenantId, userId]
    );
    
    // Step 6: Add to user_shops with owner role (full control)
    await pool.query(
      `INSERT INTO user_shops (user_id, shop_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
      [userId, shopId]
    );
    
    console.log('[Auth] Created shop for user:', shopId, 'tenant:', tenantId);

    sendWelcomeEmail({ to: email, name }).catch(err =>
      console.error('[WelcomeEmail] Failed to send:', err.message)
    );

    return { shopId, tenantId };
  } catch (error) {
    console.error('[Auth] Error creating shop for user:', error);
    throw error;
  }
}
