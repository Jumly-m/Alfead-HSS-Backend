import { pool } from '../config/drizzle.js';
import { invalidateCacheByPrefix } from '../utils/cache.js';
import { getPaymentStatus } from './snippe.service.js';
import { addReferralLedger, awardReferralCommission } from '../modules/referrals/referral.routes.js';

const PAID_STATUSES = ['completed', 'success', 'paid', 'succeeded', 'captured'];

export interface SubscriptionActivationData {
  tenantId: string;
  tenantName: string;
  tenantEmail: string | null;
  planName: string;
  durationDays: number;
  priceTzs: number;
  fullPriceTzs: number | null;
  discountPercent: number | null;
  periodEnd: Date;
  subscriptionId: string;
}

export interface SubscriptionActivationResult {
  activated: boolean;
  reason?: string;
  data?: SubscriptionActivationData;
}

/**
 * Activates a tenant subscription from its Snippe reference — the single source
 * of truth used by BOTH the Snippe webhook and the /subscriptions/status
 * self-heal check. This guarantees a user who paid (STK push confirmed by
 * Snippe) is unlocked in real time even if the webhook is delayed or lost:
 * the next status check verifies the payment directly with Snippe and
 * activates the subscription + clears the guard cache immediately.
 */
export async function activateSubscriptionByReference(opts: {
  reference: string;
  eventId?: string | null;
  channel?: string | null;
  verifyWithSnippe?: boolean;
}): Promise<SubscriptionActivationResult> {
  const { reference } = opts;
  const verifyWithSnippe = opts.verifyWithSnippe ?? true;

  // 1. Find the pending payment row
  const payRes = await pool.query(`
    SELECT sp.id, sp.tenant_id, sp.subscription_id, sp.status, sp.metadata
    FROM subscription_payments sp
    WHERE sp.snippe_reference = $1
  `, [reference]);

  if (payRes.rows.length === 0) {
    return { activated: false, reason: 'no_payment_row' };
  }
  const pay = payRes.rows[0];
  if (pay.status === 'completed') {
    return { activated: false, reason: 'already_completed' };
  }

  // 2. Confirm with Snippe that the payment actually completed (unless the
  // caller already has authoritative proof — the signed webhook payload).
  let channel = opts.channel ?? null;
  if (verifyWithSnippe) {
    try {
      const payment = await getPaymentStatus(reference);
      const raw = String(payment?.status || '').toLowerCase();
      const isPaid =
        PAID_STATUSES.includes(raw) ||
        raw.includes('complete') ||
        raw.includes('success');
      if (!isPaid) {
        return { activated: false, reason: `not_paid:${raw || 'unknown'}` };
      }
      channel = channel || payment?.channel?.provider || null;
    } catch (e: any) {
      return { activated: false, reason: `snippe_error:${e.message}` };
    }
  }

  // 3. Plan duration + bonus days from offer metadata
  const planRes = await pool.query(`
    SELECT sp.duration_days, sp.name as plan_name, sp.price_tzs, sp.full_price_tzs, sp.discount_percent,
           ts.tenant_id, t.name as tenant_name, t.email as tenant_email
    FROM tenant_subscriptions ts
    JOIN subscription_plans sp ON sp.id = ts.plan_id
    JOIN tenants t ON t.id = ts.tenant_id
    WHERE ts.id = $1
  `, [pay.subscription_id]);

  if (planRes.rows.length === 0) {
    return { activated: false, reason: 'no_subscription' };
  }
  const plan = planRes.rows[0];
  let durationDays = plan.duration_days ?? 30;
  if (pay.metadata) {
    try {
      const meta = typeof pay.metadata === 'string' ? JSON.parse(pay.metadata) : pay.metadata;
      if (meta?.bonus_days) {
        durationDays += parseInt(meta.bonus_days, 10);
      }
    } catch {
      // ignore malformed metadata
    }
  }

  const now = new Date();
  // Early renewal: if another subscription of this tenant is still running,
  // the newly-paid period STARTS when that one ends — the user keeps using
  // their current package and the paid days are never lost.
  let periodStart = now;
  try {
    const running = await pool.query(
      `SELECT current_period_end FROM tenant_subscriptions
       WHERE tenant_id = $1 AND id <> $2 AND status = 'active' AND current_period_end > NOW()
       ORDER BY current_period_end DESC LIMIT 1`,
      [plan.tenant_id, pay.subscription_id]
    );
    if (running.rows.length > 0) periodStart = new Date(running.rows[0].current_period_end);
  } catch { /* fall back to starting now */ }
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + durationDays);

  // 4. Mark the payment completed (idempotent — event id de-dupes webhook replays)
  await pool.query(`
    UPDATE subscription_payments
    SET status = 'completed',
        snippe_event_id = COALESCE($1, snippe_event_id),
        payment_channel = COALESCE($2, payment_channel),
        paid_at = COALESCE(paid_at, NOW())
    WHERE id = $3
  `, [opts.eventId ?? null, channel, pay.id]);

  // 5. Activate the subscription
  await pool.query(`
    UPDATE tenant_subscriptions
    SET status = 'active',
        current_period_start = $1,
        current_period_end = $2,
        updated_at = NOW()
    WHERE id = $3
  `, [periodStart, periodEnd, pay.subscription_id]);

  // 6. End the free trial if still running (it is superseded by the paid plan)
  await pool.query(`
    UPDATE tenants SET trial_end = $1, updated_at = NOW()
    WHERE id = $2 AND trial_activated = true AND trial_end > NOW()
  `, [now, plan.tenant_id]);

  // 7. Clear the guard's cached tenant state so restricted features unlock
  // immediately — no waiting on the 30s cache TTL.
  invalidateCacheByPrefix(`tenant:subscription:${plan.tenant_id}`);

  // 8. Notify the shop owner
  try {
    await pool.query(`
      INSERT INTO notifications (tenant_id, user_id, title, message, type, action_url)
      VALUES ($1, NULL, $2, $3, 'payment', '/subscription')
    `, [
      plan.tenant_id,
      `Malipo Yamethibitishwa - ${plan.plan_name}`,
      `Usajili wako wa ${plan.plan_name} umeamilishwa. Unasalia na siku ${durationDays}. Unaisha ${periodEnd.toLocaleDateString()}.`,
    ]);
  } catch {
    // notification failure must never block activation
  }

  // 9. Referral system — two automated actions, both fire-and-forget so they
  //    can never block or fail an activation:
  //    a) consume the referral discount the buyer chose at checkout (record
  //       the ledger only now that the money actually arrived), and
  //    b) award the referrer a ONE-TIME commission on this first payment.
  try {
    let amountPaid = Number(plan.price_tzs) || 0;
    try {
      const amtRes = await pool.query(`SELECT amount_tzs FROM subscription_payments WHERE id = $1`, [pay.id]);
      if (amtRes.rows[0]?.amount_tzs != null) amountPaid = Number(amtRes.rows[0].amount_tzs);
    } catch { /* fall back to plan price */ }

    let meta: any = null;
    try {
      meta = pay.metadata ? (typeof pay.metadata === 'string' ? JSON.parse(pay.metadata) : pay.metadata) : null;
    } catch { /* ignore malformed metadata */ }

    if (meta?.referral_used && meta?.referral_user_id && Number(meta.referral_used) > 0) {
      await addReferralLedger(
        meta.referral_user_id,
        -Number(meta.referral_used),
        'discount_used',
        `Punguzo la commission kwenye malipo ya ${plan.plan_name}`
      );
    }

    await awardReferralCommission({ tenantId: plan.tenant_id, amountPaid, paymentId: pay.id });
  } catch {
    // referral bookkeeping must never block activation
  }

  return {
    activated: true,
    data: {
      tenantId: plan.tenant_id,
      tenantName: plan.tenant_name,
      tenantEmail: plan.tenant_email,
      planName: plan.plan_name,
      durationDays,
      priceTzs: Number(plan.price_tzs),
      fullPriceTzs: plan.full_price_tzs != null ? Number(plan.full_price_tzs) : null,
      discountPercent: plan.discount_percent != null ? Number(plan.discount_percent) : null,
      periodEnd,
      subscriptionId: pay.subscription_id,
    },
  };
}