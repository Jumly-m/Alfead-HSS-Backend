/**
 * Referral system — invite friends, earn 10% one-time commission when they pay.
 *
 * Flow:
 *  1. Every user gets a shareable referral code (auto-generated).
 *  2. New user signs up via the link → POST /api/referrals/claim links them.
 *  3. When the referred user's FIRST payment completes
 *     (activateSubscriptionByReference → awardReferralCommission), the
 *     referrer earns percentage (default 10%) of the amount paid — ONE TIME.
 *  4. Referrer can withdraw (admin reviews + marks paid) or use the balance as
 *     a discount on their own next package purchase.
 *
 * Developer controls: enable/disable, percentage, min withdrawal.
 */
import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { sendEmail } from '../../services/email.service.js';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';
const fmtTZS = (n: number) => `TZS ${Number(n || 0).toLocaleString()}`;

// ─── Config (system_settings key 'referral') ─────────────────────────────────

export async function getReferralConfig(): Promise<{ enabled: boolean; percent: number; min_withdrawal: number }> {
  try {
    const r = await pool.query(`SELECT value FROM system_settings WHERE key = 'referral' LIMIT 1`);
    const v = r.rows[0]?.value;
    const cfg = typeof v === 'string' ? JSON.parse(v) : (v || {});
    return {
      enabled: cfg.enabled !== false,
      percent: Number(cfg.percent ?? 10) || 10,
      min_withdrawal: Number(cfg.min_withdrawal ?? 1000) || 1000,
    };
  } catch {
    return { enabled: true, percent: 10, min_withdrawal: 1000 };
  }
}

export async function saveReferralConfig(cfg: { enabled?: boolean; percent?: number; min_withdrawal?: number }) {
  const current = await getReferralConfig();
  const next = {
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : current.enabled,
    percent: cfg.percent !== undefined ? Math.max(0, Math.min(50, Number(cfg.percent) || 0)) : current.percent,
    min_withdrawal: cfg.min_withdrawal !== undefined ? Math.max(0, Number(cfg.min_withdrawal) || 0) : current.min_withdrawal,
  };
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('referral', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(next)]
  );
  return next;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

export async function ensureReferralSchema(): Promise<void> {
  try {
    await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS user_referral_code_unique ON "user" (UPPER(referral_code)) WHERE referral_code IS NOT NULL`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_user_id VARCHAR(255) NOT NULL,
        referred_user_id VARCHAR(255) NOT NULL UNIQUE,
        referred_name VARCHAR(255),
        referred_email VARCHAR(255),
        tenant_id UUID,
        status VARCHAR(20) NOT NULL DEFAULT 'signed_up',
        commission_tzs DECIMAL(12,2) DEFAULT 0,
        commission_paid_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_earnings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        referral_id UUID,
        amount DECIMAL(12,2) NOT NULL,
        type VARCHAR(30) NOT NULL DEFAULT 'commission',
        note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_withdrawals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMP,
        processed_by VARCHAR(255)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS referral_earnings_user_idx ON referral_earnings(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS referral_withdrawals_user_idx ON referral_withdrawals(user_id)`);
    console.log('✅ Referral tables ready');
  } catch (e: any) {
    console.log('⚠️  Referral schema check:', e.message);
  }
}

// ─── Codes & balances ────────────────────────────────────────────────────────

export async function ensureUserReferralCode(userId: string): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT referral_code FROM "user" WHERE id = $1`, [userId]);
    if (r.rows.length === 0) return null;
    if (r.rows[0].referral_code) return r.rows[0].referral_code;

    // Deterministic, readable code: ALFEAN ENTERPRISES + first 6 of the user id (uppercased)
    let code = 'ALFEAN ENTERPRISES' + String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
    // Ensure uniqueness (rare collision fallback)
    for (let i = 0; i < 5; i++) {
      const exists = await pool.query(`SELECT 1 FROM "user" WHERE UPPER(referral_code) = $1`, [code]);
      if (exists.rows.length === 0) break;
      code = 'ALFEAN ENTERPRISES' + String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
    }
    await pool.query(`UPDATE "user" SET referral_code = $1 WHERE id = $2`, [code, userId]);
    return code;
  } catch (e: any) {
    console.error('[Referral] code error:', e.message);
    return null;
  }
}

export async function getAvailableBalance(userId: string): Promise<number> {
  try {
    const earned = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_earnings WHERE user_id = $1`,
      [userId]
    );
    const pending = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_withdrawals WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    return Math.max(0, Number(earned.rows[0].total) - Number(pending.rows[0].total));
  } catch {
    return 0;
  }
}

/** Balance for the owner user of a tenant (used at subscription checkout). */
export async function getTenantOwnerReferralBalance(tenantId: string): Promise<{ userId: string | null; balance: number }> {
  try {
    const u = await pool.query(
      `SELECT id FROM "user" WHERE tenant_id = $1 AND role IN ('admin','owner') ORDER BY created_at ASC LIMIT 1`,
      [tenantId]
    );
    if (u.rows.length === 0) return { userId: null, balance: 0 };
    const userId = u.rows[0].id;
    return { userId, balance: await getAvailableBalance(userId) };
  } catch {
    return { userId: null, balance: 0 };
  }
}

export async function addReferralLedger(userId: string, amount: number, type: string, note: string, referralId?: string | null) {
  await pool.query(
    `INSERT INTO referral_earnings (user_id, referral_id, amount, type, note) VALUES ($1, $2, $3, $4, $5)`,
    [userId, referralId || null, amount, type, note]
  );
}

// ─── Claim (called right after signup with ?ref= code) ───────────────────────

export async function claimReferral(userId: string, code: string): Promise<{ success: boolean; reason?: string }> {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean || !userId) return { success: false, reason: 'invalid' };

  const cfg = await getReferralConfig();
  if (!cfg.enabled) return { success: false, reason: 'disabled' };

  try {
    const referrer = await pool.query(
      `SELECT id, name, email FROM "user" WHERE UPPER(referral_code) = $1 LIMIT 1`,
      [clean]
    );
    if (referrer.rows.length === 0) return { success: false, reason: 'no_referrer' };
    const ref = referrer.rows[0];
    if (String(ref.id) === String(userId)) return { success: false, reason: 'self' };

    // One referrer per user, ever
    const existing = await pool.query(`SELECT 1 FROM referrals WHERE referred_user_id = $1`, [userId]);
    if (existing.rows.length > 0) return { success: false, reason: 'already_claimed' };

    const me = await pool.query(`SELECT name, email, tenant_id FROM "user" WHERE id = $1`, [userId]);
    const mine = me.rows[0] || {};
    const tenantId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(mine.tenant_id || '')) ? mine.tenant_id : null;

    await pool.query(
      `INSERT INTO referrals (referrer_user_id, referred_user_id, referred_name, referred_email, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (referred_user_id) DO NOTHING`,
      [ref.id, userId, mine.name || null, mine.email || null, tenantId]
    );

    // Email the referrer — automated heads-up
    if (ref.email) {
      try {
        await sendEmail({
          to: ref.email,
          subject: '🎉 Rafiki yako ameingia kwenye ALFEAN ENTERPRISES POS!',
          html: referralEmail({
            title: 'Rafiki yako ameingia!',
            lines: [
              `<strong>${mine.name || 'Rafiki yako'}</strong> amejiunga na ALFEAN ENTERPRISES POS kwa link yako.`,
              `Akilipia package yoyote utapata commission ya <strong>${cfg.percent}%</strong> ya kiasi atakacholipa — mara moja.`,
              'Ingia kwenye dashboard → <strong>Alika Rafiki</strong> kufuatilia.',
            ],
            cta: `${APP_URL}/invite`,
            ctaLabel: 'Fungua Alika Rafiki',
          }),
          templateKey: 'referral_signup',
        });
      } catch { /* email is best-effort */ }
    }

    return { success: true };
  } catch (e: any) {
    console.error('[Referral] claim error:', e.message);
    return { success: false, reason: 'error' };
  }
}

// ─── Commission (one-time, when the referred user pays) ──────────────────────

export async function awardReferralCommission(opts: { tenantId: string; amountPaid: number; paymentId?: string }): Promise<void> {
  try {
    const cfg = await getReferralConfig();
    if (!cfg.enabled || cfg.percent <= 0) return;

    // Referred user = the owner user of the paying tenant
    const u = await pool.query(
      `SELECT id FROM "user" WHERE tenant_id = $1 AND role IN ('admin','owner') ORDER BY created_at ASC LIMIT 1`,
      [opts.tenantId]
    );
    if (u.rows.length === 0) return;
    const referredUserId = u.rows[0].id;

    // One-time: only referrals still in 'signed_up' state are eligible
    const refQ = await pool.query(
      `SELECT * FROM referrals WHERE referred_user_id = $1 AND status = 'signed_up' LIMIT 1`,
      [referredUserId]
    );
    if (refQ.rows.length === 0) return;
    const referral = refQ.rows[0];

    const commission = Math.round(Number(opts.amountPaid || 0) * (cfg.percent / 100));
    if (commission <= 0) return;

    await pool.query(
      `UPDATE referrals SET status = 'paid', commission_tzs = $1, commission_paid_at = NOW() WHERE id = $2`,
      [commission, referral.id]
    );
    await addReferralLedger(
      referral.referrer_user_id,
      commission,
      'commission',
      `Commission ${cfg.percent}% — ${referral.referred_name || 'rafiki'} amelipia`,
      referral.id
    );

    // Email the referrer — automated payout notice
    const referrer = await pool.query(`SELECT name, email FROM "user" WHERE id = $1`, [referral.referrer_user_id]);
    const r = referrer.rows[0];
    if (r?.email) {
      try {
        await sendEmail({
          to: r.email,
          subject: `💰 Umepokea ${fmtTZS(commission)} kama commission ya rafiki!`,
          html: referralEmail({
            title: 'Umepokea commission! 🎉',
            lines: [
              `Rafiki yako <strong>${referral.referred_name || ''}</strong> amelipia package ya ALFEAN ENTERPRISES POS.`,
              `Umepokea <strong>${fmtTZS(commission)}</strong> kama zawadi (${cfg.percent}% ya malipo yake).`,
              'Unaweza <strong>kutoa pesa taslimu</strong> (withdraw) au <strong>kutumia kama punguzo</strong> unapolipia mfumo mwezi ujao.',
              'Ingia kwenye dashboard → <strong>Alika Rafiki</strong> kuchagua unataka kuitumiaje.',
            ],
            cta: `${APP_URL}/invite`,
            ctaLabel: 'Chukua Zawadi Yako',
          }),
          templateKey: 'referral_commission',
        });
      } catch { /* best-effort */ }
    }
  } catch (e: any) {
    console.error('[Referral] commission error:', e.message);
  }
}

// ─── Shared email shell ──────────────────────────────────────────────────────

function referralEmail({ title, lines, cta, ctaLabel }: { title: string; lines: string[]; cta: string; ctaLabel: string }) {
  return `
  <div style="margin:0;padding:0;background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:24px 12px;">
      <div style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e9f0;">
        <div style="background:linear-gradient(135deg,#047857,#10b981);padding:22px 24px;">
          <p style="margin:0;color:#ffffff;font-size:20px;font-weight:bold;">ALFEAN ENTERPRISES</p>
          <p style="margin:4px 0 0;color:#d1fae5;font-size:12px;">Alika Rafiki — Referral Program</p>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 12px;font-size:17px;font-weight:bold;color:#0f172a;">${title}</p>
          ${lines.map(l => `<p style="margin:0 0 10px;font-size:13.5px;color:#475569;line-height:1.7;">${l}</p>`).join('')}
          <div style="text-align:center;padding:10px 0 4px;">
            <a href="${cta}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:13px 28px;border-radius:12px;">${ctaLabel}</a>
          </div>
        </div>
        <div style="background:#f9fafb;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">ALFEAN ENTERPRISES — Mfumo wa Mauzo Tanzania</p>
        </div>
      </div>
    </div>
  </div>`;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const referralRoutes = new Hono();

// Current user: code, link, referrals, totals
referralRoutes.get('/me', authMiddleware, requirePermission('referral:read'), async (c: any) => {
  try {
    const userId = c.get('userId') as string;
    const cfg = await getReferralConfig();
    const code = await ensureUserReferralCode(userId);

    const referrals = await pool.query(
      `SELECT id, referred_name, referred_email, status, commission_tzs, created_at, commission_paid_at
       FROM referrals WHERE referrer_user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );

    const earned = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_earnings WHERE user_id = $1 AND amount > 0`,
      [userId]
    );
    const withdrawn = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_withdrawals WHERE user_id = $1 AND status = 'paid'`,
      [userId]
    );
    const pending = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_withdrawals WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    const withdrawals = await pool.query(
      `SELECT id, amount, phone, name, status, created_at, processed_at FROM referral_withdrawals
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );

    const totalEarned = Number(earned.rows[0].total) || 0;
    const totalWithdrawn = Number(withdrawn.rows[0].total) || 0;
    const pendingWithdrawals = Number(pending.rows[0].total) || 0;
    const available = await getAvailableBalance(userId);

    return c.json({
      success: true,
      data: {
        enabled: cfg.enabled,
        percent: cfg.percent,
        min_withdrawal: cfg.min_withdrawal,
        code,
        link: code ? `${APP_URL}/register?ref=${code}` : null,
        referrals: referrals.rows.map((r: any) => ({
          id: r.id,
          name: r.referred_name,
          email: r.referred_email,
          status: r.status,
          commission: Number(r.commission_tzs) || 0,
          createdAt: r.created_at,
          paidAt: r.commission_paid_at,
        })),
        totals: { earned: totalEarned, available, pending: pendingWithdrawals, withdrawn: totalWithdrawn },
        withdrawals: withdrawals.rows.map((w: any) => ({
          id: w.id, amount: Number(w.amount) || 0, phone: w.phone, name: w.name,
          status: w.status, createdAt: w.created_at, processedAt: w.processed_at,
        })),
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Link the signed-in user to a referrer (called right after signup)
referralRoutes.post('/claim', authMiddleware, async (c: any) => {
  try {
    const userId = c.get('userId') as string;
    const { code } = await c.req.json();
    const result = await claimReferral(userId, code);
    return c.json({ success: result.success, reason: result.reason });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Request a withdrawal (admin reviews + marks paid)
referralRoutes.post('/withdraw', authMiddleware, requirePermission('referral:read'), async (c: any) => {
  try {
    const userId = c.get('userId') as string;
    const { amount, phone, name } = await c.req.json();
    const cfg = await getReferralConfig();

    const amt = Number(amount) || 0;
    if (!phone || !name) return c.json({ success: false, error: 'Jina na namba ya simu vinahitajika' }, 400);
    if (amt < cfg.min_withdrawal) {
      return c.json({ success: false, error: `Kiwango cha chini cha kutoa ni ${fmtTZS(cfg.min_withdrawal)}` }, 400);
    }
    const available = await getAvailableBalance(userId);
    if (amt > available) {
      return c.json({ success: false, error: `Salio lako la kutosha ni ${fmtTZS(available)}` }, 400);
    }

    await pool.query(
      `INSERT INTO referral_withdrawals (user_id, amount, phone, name) VALUES ($1, $2, $3, $4)`,
      [userId, amt, String(phone).slice(0, 20), String(name).slice(0, 255)]
    );
    return c.json({ success: true, message: 'Ombi lako limetumwa — admin atalithibitisha na kulipa' });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// ── Developer management ─────────────────────────────────────────────────────

const requireDeveloper = async (c: any, next: any) => {
  const role = c.get('userRole') as string;
  if (role !== 'developer') return c.json({ success: false, error: 'Developer only' }, 403);
  await next();
};

referralRoutes.get('/admin/overview', authMiddleware, requireDeveloper, async (c: any) => {
  try {
    const cfg = await getReferralConfig();

    const stats = await pool.query(`
      SELECT
        COUNT(*)::int AS total_referrals,
        COUNT(*) FILTER (WHERE status = 'signed_up')::int AS signed_up,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
        COALESCE(SUM(commission_tzs), 0)::float8 AS total_commission
      FROM referrals
    `);

    const earnings = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::float8 AS earned,
        COALESCE(SUM(-amount) FILTER (WHERE type = 'discount_used'), 0)::float8 AS used_discounts,
        COALESCE(SUM(-amount) FILTER (WHERE type = 'withdrawal_paid'), 0)::float8 AS paid_out
      FROM referral_earnings
    `);

    const referrals = await pool.query(`
      SELECT r.*,
        COALESCE(ru.name, ru.email, '-') AS referrer_name,
        COALESCE(ru.email, '-') AS referrer_email
      FROM referrals r
      LEFT JOIN "user" ru ON ru.id = r.referrer_user_id
      ORDER BY r.created_at DESC LIMIT 200
    `);

    const withdrawals = await pool.query(`
      SELECT w.*, COALESCE(u.name, u.email, '-') AS user_name, u.email
      FROM referral_withdrawals w
      LEFT JOIN "user" u ON u.id = w.user_id
      ORDER BY CASE WHEN w.status = 'pending' THEN 0 ELSE 1 END, w.created_at DESC
      LIMIT 200
    `);

    return c.json({
      success: true,
      data: {
        config: cfg,
        stats: stats.rows[0],
        earnings: earnings.rows[0],
        referrals: referrals.rows.map((r: any) => ({
          id: r.id,
          referrer: r.referrer_name,
          referrerEmail: r.referrer_email,
          referred: r.referred_name,
          referredEmail: r.referred_email,
          status: r.status,
          commission: Number(r.commission_tzs) || 0,
          createdAt: r.created_at,
          paidAt: r.commission_paid_at,
        })),
        withdrawals: withdrawals.rows.map((w: any) => ({
          id: w.id, userName: w.user_name, email: w.email, amount: Number(w.amount) || 0,
          phone: w.phone, name: w.name, status: w.status, createdAt: w.created_at, processedAt: w.processed_at,
        })),
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

referralRoutes.put('/admin/config', authMiddleware, requireDeveloper, async (c: any) => {
  try {
    const body = await c.req.json();
    const cfg = await saveReferralConfig(body);
    return c.json({ success: true, data: cfg });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

referralRoutes.post('/admin/withdrawals/:id/paid', authMiddleware, requireDeveloper, async (c: any) => {
  try {
    const id = c.req.param('id');
    const developerId = c.get('userId') as string;
    const w = await pool.query(`SELECT * FROM referral_withdrawals WHERE id = $1`, [id]);
    if (w.rows.length === 0) return c.json({ success: false, error: 'Withdrawal not found' }, 404);
    if (w.rows[0].status === 'paid') return c.json({ success: true, message: 'Already paid' });

    await pool.query(
      `UPDATE referral_withdrawals SET status = 'paid', processed_at = NOW(), processed_by = $1 WHERE id = $2`,
      [developerId, id]
    );
    await addReferralLedger(w.rows[0].user_id, -Number(w.rows[0].amount), 'withdrawal_paid', `Withdrawal ya ${fmtTZS(w.rows[0].amount)} imelipwa`);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

referralRoutes.post('/admin/withdrawals/:id/reject', authMiddleware, requireDeveloper, async (c: any) => {
  try {
    const id = c.req.param('id');
    const developerId = c.get('userId') as string;
    await pool.query(
      `UPDATE referral_withdrawals SET status = 'rejected', processed_at = NOW(), processed_by = $1 WHERE id = $2 AND status = 'pending'`,
      [developerId, id]
    );
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

export default referralRoutes;
