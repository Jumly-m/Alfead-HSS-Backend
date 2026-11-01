import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { initiateSubscriptionPayment } from '../../services/snippe.service.js';
import { getAvailableBalance } from '../referrals/referral.routes.js';
import { activateSubscriptionByReference } from '../../services/subscription-activation.service.js';
import { sendFreeTrialStarted } from '../../services/email.service.js';
import { FEATURE_CATALOG, getEntitlements, getTrialSettings, getUsage } from '../../services/plan-limits.service.js';

const subscriptionRoutes = new Hono();

async function getTrialDays(): Promise<number> {
  try {
    const settings = await getTrialSettings();
    return settings.defaultDays ?? 14;
  } catch {}
  return 14;
}

async function buildEntitlements(tenantId: string) {
  try {
    const ent = await getEntitlements(tenantId);
    const usage = await getUsage(tenantId);
    return { ...ent, usage };
  } catch (e: any) {
    console.error('[Entitlements] Error:', e.message);
    return null;
  }
}

const PAYMENT_TYPE_MAP: Record<string, string> = {
  mobile: 'mobile',
  mpesa: 'mobile',
  mixx: 'mobile',
  halopesa: 'mobile',
  airtel: 'mobile',
  card: 'card',
  'dynamic-qr': 'dynamic_qr',
  dynamic_qr: 'dynamic_qr',
};

subscriptionRoutes.get('/feature-catalog', (c) => {
  return c.json({ success: true, data: FEATURE_CATALOG });
});

subscriptionRoutes.get('/plans', async (c) => {
  try {
    const result = await pool.query(`
      SELECT id, name, price_tzs, full_price_tzs, discount_percent,
             duration_days, max_shops, max_sellers, max_products, max_admins, features,
             description, badge, is_active, created_at
      FROM subscription_plans
      WHERE is_active = true
      ORDER BY duration_days ASC
    `);
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// GET /subscriptions/offers — list active offers for current tenant
subscriptionRoutes.get('/offers', authMiddleware, async (c: any) => {
  try {
    const tenantId = c.get('tenantId');
    const result = await pool.query(`
      SELECT id, title, description, offer_type, discount_percent, bonus_days,
             max_uses, used_count, expires_at, is_active
      FROM subscription_offers
      WHERE is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses IS NULL OR used_count < max_uses)
        AND (tenant_ids IS NULL OR cardinality(tenant_ids) = 0 OR $1 = ANY(tenant_ids))
      ORDER BY discount_percent DESC, bonus_days DESC
    `, [tenantId]);
    return c.json({ success: true, data: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

subscriptionRoutes.get('/status', authMiddleware, async (c: any) => {
  const tenantId = c.get('tenantId');
  const userRole = c.get('userRole');
  try {
    // Developers and users without a tenant always get full access — never a paywall
    if (!tenantId || userRole === 'developer') {
      return c.json({
        success: true,
        data: {
          status: 'active',
          message: userRole === 'developer' ? 'Developer access — full access' : 'Full access',
          subscription_enabled: false,
          subscription_required: false,
          trial: null,
          subscription: null,
        }
      });
    }

    // Check global subscription enabled flag
    let globalSubscriptionEnabled = false;
    try {
      const globalResult = await pool.query(`SELECT value FROM system_settings WHERE key = 'subscription'`);
      if (globalResult.rows.length > 0) {
        const val = typeof globalResult.rows[0].value === 'string' ? JSON.parse(globalResult.rows[0].value) : globalResult.rows[0].value;
        globalSubscriptionEnabled = val?.enabled ?? false;
      }
    } catch {}

    // If subscription system is globally disabled, return free-tier response
    if (!globalSubscriptionEnabled) {
      return c.json({
        success: true,
        data: {
          status: 'active',
          message: 'Subscription system is disabled — full access',
          subscription_enabled: false,
          subscription_required: false,
          trial: null,
          subscription: null,
        }
      });
    }

    // Auto-activate trial if not yet activated
    let tenantSettings: any = {};
    try {
      const tenantRes = await pool.query(`
        SELECT subscription_enabled, subscription_required, trial_start, trial_end, trial_activated
        FROM tenants WHERE id = $1
      `, [tenantId]);
      tenantSettings = tenantRes.rows[0] || {};
    } catch (e: any) {
      console.log(`[Status] Trial columns may not exist, adding them: ${e.message}`);
      try {
        await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_start TIMESTAMP`);
        await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_end TIMESTAMP`);
        await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_activated BOOLEAN DEFAULT FALSE`);
        const tenantRes = await pool.query(`
          SELECT subscription_enabled, subscription_required, trial_start, trial_end, trial_activated
          FROM tenants WHERE id = $1
        `, [tenantId]);
        tenantSettings = tenantRes.rows[0] || {};
      } catch (e2: any) {
        console.error(`[Status] Failed to add trial columns: ${e2.message}`);
      }
    }
    
    if (!tenantSettings.trial_activated) {
      const days = await getTrialDays();
      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setDate(trialEnd.getDate() + days);
      await pool.query(`
        UPDATE tenants SET trial_start = $1, trial_end = $2, trial_activated = true, updated_at = NOW()
        WHERE id = $3
      `, [now, trialEnd, tenantId]);
      tenantSettings.trial_activated = true;
      tenantSettings.trial_start = now;
      tenantSettings.trial_end = trialEnd;
      console.log(`[Status] Auto-activated ${days}-day trial for tenant ${tenantId}`);
    }
    
    const subscriptionEnabled = tenantSettings.subscription_enabled ?? false;
    const subscriptionRequired = tenantSettings.subscription_required ?? false;
    const trialStart = tenantSettings.trial_start ? new Date(tenantSettings.trial_start) : null;
    const trialEnd = tenantSettings.trial_end ? new Date(tenantSettings.trial_end) : null;
    const trialActivated = tenantSettings.trial_activated ?? false;
    const now = new Date();
    const isTrialActive = trialActivated && trialEnd && trialEnd > now;
    const isTrialExpired = trialActivated && trialEnd && trialEnd <= now;
    
    // Check for ANY active paid subscription (not just the latest record)
    // This prevents a newer 'pending' record from hiding an older 'active' one
    const activeResult = await pool.query(`
      SELECT ts.id, ts.status, ts.current_period_start, ts.current_period_end,
             ts.snippe_reference, ts.plan_id,
             sp.name as plan_name, sp.duration_days, sp.price_tzs, sp.full_price_tzs, sp.discount_percent,
             sp.max_shops, sp.max_sellers
      FROM tenant_subscriptions ts
      LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
      WHERE ts.tenant_id = $1 AND ts.status = 'active' AND ts.current_period_end > NOW()
      ORDER BY ts.created_at DESC
      LIMIT 1
    `, [tenantId]);
    
    let subData = activeResult.rows[0];
    let hasActivePaid = !!subData;

    // SELF-HEAL: if the tenant has no active subscription but has a pending one
    // with a Snippe reference, verify the payment directly with Snippe and
    // activate it on the spot. This makes unlock REAL TIME even when the Snippe
    // webhook is delayed or lost — the user who already paid stops seeing the
    // paywall on the very next status check, no manual intervention needed.
    if (!hasActivePaid) {
      try {
        const pendingRes = await pool.query(`
          SELECT ts.snippe_reference FROM tenant_subscriptions ts
          WHERE ts.tenant_id = $1 AND ts.status = 'pending' AND ts.snippe_reference IS NOT NULL
          ORDER BY ts.created_at DESC
          LIMIT 5
        `, [tenantId]);
        for (const row of pendingRes.rows) {
          const activation = await activateSubscriptionByReference({ reference: row.snippe_reference });
          if (activation.activated) {
            console.log(`[Status] Self-heal: activated subscription ${row.snippe_reference} for tenant ${tenantId}`);
            const healed = await pool.query(`
              SELECT ts.id, ts.status, ts.current_period_start, ts.current_period_end,
                     ts.snippe_reference, ts.plan_id,
                     sp.name as plan_name, sp.duration_days, sp.price_tzs, sp.full_price_tzs, sp.discount_percent,
                     sp.max_shops, sp.max_sellers
              FROM tenant_subscriptions ts
              LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
              WHERE ts.tenant_id = $1 AND ts.status = 'active' AND ts.current_period_end > NOW()
              ORDER BY ts.created_at DESC
              LIMIT 1
            `, [tenantId]);
            if (healed.rows.length > 0) {
              subData = healed.rows[0];
              hasActivePaid = true;
            }
            break;
          }
        }
      } catch (e: any) {
        console.error('[Status] Payment self-heal error:', e.message);
      }
    }

    // Determine overall status
    let status = 'free';
    let message = 'No active subscription';
    
    if (hasActivePaid) {
      status = 'active';
      message = 'Active paid subscription';
    } else if (isTrialActive) {
      status = 'trial';
      message = 'Free trial active';
    } else if (isTrialExpired && !hasActivePaid) {
      status = 'trial_expired';
      message = 'Free trial expired. Please subscribe to continue.';
    } else if (!trialActivated) {
      status = 'trial_available';
      message = 'Free trial available';
    }

    return c.json({ 
      success: true, 
      data: { 
        status,
        message,
        entitlements: await buildEntitlements(tenantId),
        current_period_end: hasActivePaid ? subData.current_period_end : (isTrialActive ? trialEnd : null),
        subscription_enabled: true,
        subscription_required: subscriptionRequired,
        trial: trialActivated ? {
          activated: true,
          startDate: trialStart,
          endDate: trialEnd,
          isActive: isTrialActive,
          isExpired: isTrialExpired,
          daysRemaining: isTrialActive ? Math.ceil((trialEnd!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 0,
        } : {
          activated: false,
          available: true,
          trialDays: await getTrialDays(),
        },
        subscription: hasActivePaid ? {
          ...subData,
          isActive: true,
          daysRemaining: Math.ceil((new Date(subData.current_period_end).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
          max_shops: subData.max_shops ?? null,
          max_sellers: subData.max_sellers ?? null,
        } : (isTrialActive ? {
          plan_name: 'Free Trial',
          status: 'trial',
          isActive: true,
          daysRemaining: Math.ceil((trialEnd!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
          current_period_end: trialEnd,
          max_shops: null,
          max_sellers: null,
        } : null),
      } 
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// GET /subscriptions/billing - User's billing info
subscriptionRoutes.get('/billing', authMiddleware, requirePermission('subscription:read'), async (c: any) => {
  const tenantId = c.get('tenantId');
  const userRole = c.get('userRole');

  // Developers and users without a tenant get a free-tier response
  if (!tenantId || userRole === 'developer') {
    return c.json({
      success: true,
      data: {
        subscription_enabled: false,
        subscription: null,
        trial: null,
        payments: [],
      }
    });
  }

  // Check global subscription enabled flag
  let globalSubscriptionEnabled = false;
  try {
    const globalResult = await pool.query(`SELECT value FROM system_settings WHERE key = 'subscription'`);
    if (globalResult.rows.length > 0) {
      const val = typeof globalResult.rows[0].value === 'string' ? JSON.parse(globalResult.rows[0].value) : globalResult.rows[0].value;
      globalSubscriptionEnabled = val?.enabled ?? false;
    }
  } catch {}

  // If subscription system is globally disabled, return free-tier response
  if (!globalSubscriptionEnabled) {
    return c.json({
      success: true,
      data: {
        subscription_enabled: false,
        subscription: null,
        trial: null,
        payments: [],
      }
    });
  }

  try {
    // Auto-activate trial if not yet activated
    let tenant = null;
    try {
      const tenantRes = await pool.query(`
        SELECT trial_activated, trial_start, trial_end
        FROM tenants WHERE id = $1
      `, [tenantId]);
      tenant = tenantRes.rows[0];
    } catch (e: any) {
      console.log(`[Billing] Trial columns may not exist yet, adding them: ${e.message}`);
      try {
        await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_start TIMESTAMP`);
        await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_end TIMESTAMP`);
        await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_activated BOOLEAN DEFAULT FALSE`);
        const tenantRes = await pool.query(`
          SELECT trial_activated, trial_start, trial_end
          FROM tenants WHERE id = $1
        `, [tenantId]);
        tenant = tenantRes.rows[0];
      } catch (e2: any) {
        console.error(`[Billing] Failed to add trial columns: ${e2.message}`);
      }
    }

    if (tenant && !tenant.trial_activated) {
      const days = await getTrialDays();
      const now = new Date();
      const trialEnd = new Date(now);
      trialEnd.setDate(trialEnd.getDate() + days);
      await pool.query(`
        UPDATE tenants SET trial_start = $1, trial_end = $2, trial_activated = true, updated_at = NOW()
        WHERE id = $3
      `, [now, trialEnd, tenantId]);
      tenant.trial_activated = true;
      tenant.trial_start = now;
      tenant.trial_end = trialEnd;
      console.log(`[Billing] Auto-activated ${days}-day trial for tenant ${tenantId}`);
    }

    // Get current subscription — check for active first, fall back to latest
    const subResult = await pool.query(`
      SELECT ts.id, ts.status, ts.current_period_start, ts.current_period_end,
             ts.snippe_reference, ts.plan_id,
             sp.name as plan_name, sp.price_tzs, sp.duration_days,
             CASE WHEN ts.current_period_end IS NOT NULL
               THEN ts.current_period_end - NOW()
               ELSE NULL
             END as time_remaining
      FROM tenant_subscriptions ts
      LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
      WHERE ts.tenant_id = $1
      ORDER BY CASE WHEN ts.status = 'active' AND ts.current_period_end > NOW() THEN 0 ELSE 1 END, ts.created_at DESC
      LIMIT 1
    `, [tenantId]);

    const subscription = subResult.rows[0] || null;
    // Days remaining computed from the actual expiry timestamp. (The old code
    // parsed the Postgres INTERVAL `time_remaining` with new Date(), which is
    // invalid in JS and produced NaN → null → "—" in the UI.)
    let daysRemaining = null;
    if (subscription?.current_period_end) {
      const endMs = new Date(subscription.current_period_end).getTime();
      if (!Number.isNaN(endMs)) {
        daysRemaining = Math.max(0, Math.ceil((endMs - Date.now()) / (1000 * 60 * 60 * 24)));
      }
    }

    // Get trial info
    const now = new Date();
    let trialInfo = null;
    if (tenant?.trial_activated && tenant.trial_end) {
      const trialEnd = new Date(tenant.trial_end);
      const trialStart = tenant.trial_start ? new Date(tenant.trial_start) : null;
      const isTrialActive = trialEnd > now;
      const trialDaysRemaining = isTrialActive ? Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      trialInfo = {
        activated: true,
        startDate: trialStart,
        endDate: trialEnd,
        isActive: isTrialActive,
        isExpired: !isTrialActive,
        daysRemaining: trialDaysRemaining,
      };
    }

    // Get payment history
    const paymentsResult = await pool.query(`
      SELECT sp.id, sp.snippe_reference, sp.amount_tzs, sp.status,
             sp.payment_channel, sp.payment_type, sp.customer_phone,
             sp.paid_at, sp.created_at,
             spl.name as plan_name
      FROM subscription_payments sp
      LEFT JOIN tenant_subscriptions ts ON ts.id = sp.subscription_id
      LEFT JOIN subscription_plans spl ON spl.id = ts.plan_id
      WHERE sp.tenant_id = $1
      ORDER BY sp.created_at DESC
      LIMIT 50
    `, [tenantId]);

    // Determine effective subscription status
    const hasActivePaid = subscription?.status === 'active' && subscription.current_period_end && new Date(subscription.current_period_end) > now;
    const trialActive = trialInfo?.isActive;

    return c.json({
      success: true,
      data: {
        subscription_enabled: true,
        entitlements: await buildEntitlements(tenantId),
        subscription: hasActivePaid ? {
          ...subscription,
          days_remaining: daysRemaining,
          time_remaining: undefined,
          max_shops: subscription.max_shops ?? null,
          max_sellers: subscription.max_sellers ?? null,
        } : (trialActive && trialInfo ? {
          plan_name: 'Free Trial',
          status: 'trial',
          days_remaining: trialInfo.daysRemaining,
          current_period_end: trialInfo.endDate,
          max_shops: null,
          max_sellers: null,
        } : null),
        trial: trialInfo,
        payments: paymentsResult.rows,
      }
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

subscriptionRoutes.post('/initiate', authMiddleware, requirePermission('subscription:read'), async (c: any) => {
  const tenantId = c.get('tenantId');
  const user = c.get('user') as any;

  try {
    if (!tenantId) {
      return c.json({ error: 'Unable to determine your tenant. Please contact support.' }, 400);
    }

    const { planId, phone, paymentType, offerId, couponCode, useReferralBalance } = await c.req.json();

    if (!planId) return c.json({ error: 'planId is required' }, 400);
    if (!phone) return c.json({ error: 'phone is required' }, 400);

    // Early renewal is allowed: if the tenant still has a running package, the
    // new payment is queued as a renewal and its period will START when the
    // current one ends (see subscription-activation.service.ts) — so the user
    // never loses access and never loses paid days.
    const existingActive = await pool.query(`
      SELECT id, current_period_end FROM tenant_subscriptions
      WHERE tenant_id = $1 AND status = 'active' AND current_period_end > NOW()
      ORDER BY current_period_end DESC
      LIMIT 1
    `, [tenantId]);
    const renewalBaseEnd: Date | null = existingActive.rows.length > 0
      ? new Date(existingActive.rows[0].current_period_end)
      : null;

    const planResult = await pool.query(`
      SELECT id, name, price_tzs, duration_days
      FROM subscription_plans WHERE id = $1 AND is_active = true
    `, [planId]);

    if (planResult.rows.length === 0) {
      return c.json({ error: 'Plan not found or inactive' }, 404);
    }

    const plan = planResult.rows[0];
    const tenantResult = await pool.query(`
      SELECT id, name, email FROM tenants WHERE id = $1
    `, [tenantId]);

    const tenant = tenantResult.rows[0] ?? { name: 'Customer', email: user?.email ?? 'customer@example.com' };

    // Check for active offer and apply discount/bonus
    let bonusDays = 0;
    let appliedOfferId = null;
    let offerDiscountPercent = 0;

    // A typed coupon code is resolved to its offer here (server-side
    // verification against our system; expiry and usage cap enforced).
    let resolvedOfferId = offerId;
    if (!resolvedOfferId && couponCode) {
      const codeRes = await pool.query(`
        SELECT id FROM subscription_offers
        WHERE UPPER(code) = $1 AND is_active = true
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses IS NULL OR used_count < max_uses)
        LIMIT 1
      `, [String(couponCode).trim().toUpperCase()]);
      if (codeRes.rows.length > 0) resolvedOfferId = codeRes.rows[0].id;
    }

    if (resolvedOfferId) {
      const offerResult = await pool.query(`
        SELECT * FROM subscription_offers
        WHERE id = $1 AND is_active = true
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses IS NULL OR used_count < max_uses)
      `, [resolvedOfferId]);

      if (offerResult.rows.length > 0) {
        const offer = offerResult.rows[0];
        // Check tenant targeting (NULL = all tenants)
        if (!offer.tenant_ids || offer.tenant_ids.length === 0 || offer.tenant_ids.includes(tenantId)) {
          bonusDays = offer.bonus_days ?? 0;
          offerDiscountPercent = offer.discount_percent ?? 0;
          appliedOfferId = resolvedOfferId;

          // Increment usage count
          await pool.query(`
            UPDATE subscription_offers SET used_count = used_count + 1 WHERE id = $1
          `, [resolvedOfferId]);
        }
      }
    }

    // Calculate final price with offer discount
    let finalPrice = Number(plan.price_tzs);
    if (offerDiscountPercent > 0) {
      finalPrice = Math.round(finalPrice * (1 - offerDiscountPercent / 100));
    }

    // Referral commission balance — spend earned commission as a discount.
    // The balance is only deducted once the payment actually completes
    // (subscription-activation.service.ts), never on failed attempts.
    let referralUsed = 0;
    let referralUserId: string | null = null;
    if (useReferralBalance && user?.id) {
      const balance = await getAvailableBalance(user.id);
      referralUserId = user.id;
      if (balance > 0 && finalPrice > 1) {
        referralUsed = Math.min(balance, finalPrice - 1);
        finalPrice -= referralUsed;
      }
    }

    const subResult = await pool.query(`
      INSERT INTO tenant_subscriptions (tenant_id, plan_id, status)
      VALUES ($1, $2, 'pending')
      RETURNING id
    `, [tenantId, planId]);

    const subId = subResult.rows[0].id;
    const idempotencyKey = `sub-${subId.slice(0, 8)}-${Date.now().toString(36)}`.slice(0, 30);

    const nameParts = String(tenant.name).split(' ');
    const snippePaymentType = PAYMENT_TYPE_MAP[paymentType] ?? 'mobile';

    const metadata: Record<string, string> = {
      tenant_id: tenantId,
      subscription_id: subId,
      plan_id: planId,
      plan_name: plan.name,
      duration_days: String(plan.duration_days),
    };
    if (appliedOfferId) {
      metadata.offer_id = appliedOfferId;
      metadata.offer_discount = String(offerDiscountPercent);
      metadata.bonus_days = String(bonusDays);
    }
    if (referralUsed > 0 && referralUserId) {
      metadata.referral_used = String(referralUsed);
      metadata.referral_user_id = referralUserId;
    }
    if (renewalBaseEnd) {
      metadata.renewal = 'true';
      metadata.renewal_base_end = renewalBaseEnd.toISOString();
    }

    const payment = await initiateSubscriptionPayment({
      amountTzs: finalPrice,
      phone,
      firstName: nameParts[0] ?? 'Customer',
      lastName: nameParts.slice(1).join(' ') || 'User',
      email: tenant.email,
      idempotencyKey,
      paymentType: snippePaymentType as any,
      redirectUrl: `${process.env.APP_URL}/payment-success`,
      cancelUrl: `${process.env.APP_URL}/payment-cancel`,
      metadata,
    });

    await pool.query(`
      UPDATE tenant_subscriptions
      SET snippe_reference = $1, updated_at = NOW()
      WHERE id = $2
    `, [payment.reference, subId]);

    await pool.query(`
      INSERT INTO subscription_payments
        (tenant_id, subscription_id, snippe_reference, amount_tzs, status, payment_type, customer_phone, metadata)
      VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
    `, [tenantId, subId, payment.reference, finalPrice, snippePaymentType, phone, JSON.stringify(metadata)]);

    let message = 'USSD push sent. Enter your PIN to complete payment.';
    if (snippePaymentType === 'card') message = 'Redirect to payment_url to complete card payment.';
    else if (snippePaymentType === 'dynamic_qr') message = 'Scan the QR code with your mobile money app.';

    return c.json({
      success: true,
      data: {
        subscriptionId: subId,
        snippeReference: payment.reference,
        status: payment.status,
        paymentUrl: payment.paymentUrl,
        paymentQr: payment.paymentQr,
        originalPrice: Number(plan.price_tzs),
        finalPrice,
        discountApplied: offerDiscountPercent > 0 ? offerDiscountPercent : null,
        referralUsed,
        renewalStartsAt: renewalBaseEnd ? renewalBaseEnd.toISOString() : null,
        bonusDays,
        message,
      },
    }, 201);
  } catch (e: any) {
    console.error('[/subscriptions/initiate] Error:', e.message);
    return c.json({ success: false, error: e.message }, 400);
  }
});

// POST /subscriptions/trial/activate — Activate free trial
subscriptionRoutes.post('/trial/activate', authMiddleware, async (c: any) => {
  const tenantId = c.get('tenantId');
  const user = c.get('user') as any;
  const trialDays = await getTrialDays();

  try {
    const checkResult = await pool.query(`
      SELECT t.trial_activated, t.trial_end,
             ts.status as sub_status, ts.current_period_end
      FROM tenants t
      LEFT JOIN LATERAL (
        SELECT status, current_period_end FROM tenant_subscriptions
        WHERE tenant_id = t.id ORDER BY created_at DESC LIMIT 1
      ) ts ON true
      WHERE t.id = $1
    `, [tenantId]);

    const existing = checkResult.rows[0];
    if (!existing) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }

    if (existing.sub_status === 'active' && existing.current_period_end && new Date(existing.current_period_end) > new Date()) {
      return c.json({ success: false, error: 'You already have an active subscription' }, 400);
    }

    if (existing.trial_activated) {
      const trialEnd = existing.trial_end ? new Date(existing.trial_end) : null;
      if (trialEnd && trialEnd > new Date()) {
        return c.json({ success: false, error: 'Free trial already active', data: { trialEnd } }, 400);
      }
      return c.json({ success: false, error: 'Free trial has already expired' }, 400);
    }

    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    await pool.query(`
      UPDATE tenants SET trial_start = $1, trial_end = $2, trial_activated = true, updated_at = NOW()
      WHERE id = $3
    `, [now, trialEnd, tenantId]);

    const tenantResult = await pool.query(`SELECT name, email FROM tenants WHERE id = $1`, [tenantId]);
    const tenant = tenantResult.rows[0];
    if (tenant?.email) {
      await sendFreeTrialStarted({
        to: tenant.email,
        tenantName: tenant.name || 'User',
        startDate: now,
        endDate: trialEnd,
      });
    }

    return c.json({
      success: true,
      data: {
        status: 'trial',
        trialStart: now,
        trialEnd,
        trialDays,
        message: `Your ${trialDays}-day free trial is now active!`,
      },
    }, 201);
  } catch (e: any) {
    console.error('[Trial Activate] Error:', e.message);
    return c.json({ success: false, error: e.message }, 400);
  }
});

export default subscriptionRoutes;
