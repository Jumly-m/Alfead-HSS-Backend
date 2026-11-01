import { Context, Next } from 'hono';

// ─────────────────────────────────────────────────────────────────────────────
// Subscription billing is switched OFF for this deployment.
//
// These guards used to lock business features when a tenant's free trial or
// package expired. They are now deliberate pass-throughs: every authenticated
// user has full access to the system, and the only paid service left is SMS
// credits (handled entirely inside the SMS module). The subscription API and
// developer analytics screens remain available but no longer gate anything.
//
// Re-enabling subscriptions later only requires restoring the previous
// implementations of these two guards (price/feature logic still lives in
// services/plan-limits.service.ts).
// ─────────────────────────────────────────────────────────────────────────────

export async function subscriptionGuard(_c: Context, next: Next) {
  return await next();
}

export async function requireActiveSubscription(_c: Context, next: Next) {
  return await next();
}
