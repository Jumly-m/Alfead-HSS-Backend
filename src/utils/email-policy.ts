/**
 * Shared email-verification policy.
 *
 * Verification is OFF by default: creating an account signs the user in
 * immediately, and no verification email is sent. Operators who want to enforce
 * it can set REQUIRE_EMAIL_VERIFICATION=true (the email provider must be
 * configured so the link can actually be delivered).
 *
 * Existing accounts are grandfathered as verified once by the startup backfill
 * in index.ts, so enabling this never locks out users who registered earlier.
 */
export const EMAIL_PROVIDER_CONFIGURED = Boolean(process.env.RESEND_API_KEY);

export const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
