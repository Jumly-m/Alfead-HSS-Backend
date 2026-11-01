/**
 * ─── AUTOMATED SMS CONTROL (developer kill switches) ─────────────────────────
 *
 * Every automatic / marketing SMS or email send in the system is registered
 * here with a stable key. The developer portal can pause any of them (or all
 * of them) instantly — the cron jobs read these settings before every run.
 *
 * Stored in the global `settings` table (key = 'sms_automation', shop_id IS
 * NULL) as JSON, so it survives restarts and replays across instances.
 *
 * Manual sends are never blocked by these switches: the developer's
 * "Test/Trigger now" buttons, manual SMS, broadcasts and a shop's own SMS
 * Center keep working. This only stops the AUTOMATIC runs.
 */
import { pool } from '../config/drizzle.js';

export interface SmsAutomationSettings {
  /** Master switch: when false, every automatic job below is skipped. */
  master_enabled: boolean;
  trial_expiry_sms: boolean;
  subscription_expiry_sms: boolean;
  expiry_invoice: boolean;
  promo_5day: boolean;
  trial_expired_marketing: boolean;
  daily_marketing_email: boolean;
  payment_followup: boolean;
  daily_sales_report: boolean;
  shop_auto_sms: boolean;
  scheduled_campaigns: boolean;
}

export type SmsAutomationJobKey = Exclude<keyof SmsAutomationSettings, 'master_enabled'>;

export const SMS_AUTOMATION_DEFAULTS: SmsAutomationSettings = {
  master_enabled: true,
  trial_expiry_sms: true,
  subscription_expiry_sms: true,
  expiry_invoice: true,
  promo_5day: true,
  trial_expired_marketing: true,
  daily_marketing_email: true,
  payment_followup: true,
  daily_sales_report: true,
  shop_auto_sms: true,
  scheduled_campaigns: true,
};

// Job metadata for the developer UI. Times are Tanzania time (EAT) in the
// standard deployment (UTC container); the cron expressions themselves are
// unchanged — this only describes when the jobs actually run.
export const SMS_AUTOMATION_JOBS: Array<{
  key: SmsAutomationJobKey;
  label: string;
  schedule: string;
  description: string;
}> = [
  { key: 'trial_expired_marketing', label: 'Trial-Expired Win-Back', schedule: 'Daily 08:00 EAT', description: 'AI-written SMS + email for 7 days after a trial expires' },
  { key: 'daily_marketing_email', label: 'Daily Marketing Email', schedule: 'Daily 08:00 EAT', description: 'Daily promotional email to tenants' },
  { key: 'shop_auto_sms', label: 'Shop Auto-SMS', schedule: 'Daily 08:00 + 11:00 EAT + every 5 min', description: 'Debt reminders, invoice reminders, low-stock alerts, daily summary and product-expiry alerts for shop owners' },
  { key: 'promo_5day', label: '5-Day Promo Blast', schedule: 'Daily 12:30 EAT', description: '50% win-back promo SMS + email, one per day for 5 days (non-subscribers)' },
  { key: 'expiry_invoice', label: 'Expiry Invoice Reminders', schedule: 'Daily 13:30 EAT', description: 'Invoice + SMS 5 days before a package/trial expires' },
  { key: 'trial_expiry_sms', label: 'Trial Expiring SMS', schedule: 'Daily 15:00 EAT', description: 'Reminder SMS to users whose free trial ends in 3 days' },
  { key: 'subscription_expiry_sms', label: 'Subscription Expiring SMS', schedule: 'Daily 16:00 EAT', description: 'Reminder SMS to users whose paid package ends in 3 days' },
  { key: 'payment_followup', label: 'Payment Follow-Ups', schedule: 'Every 2 hours', description: 'SMS + email for pending/failed subscription payments' },
  { key: 'daily_sales_report', label: 'Daily Sales Reports', schedule: 'Daily 22:00 EAT', description: 'Sales summary SMS + email to each shop (their own data)' },
  { key: 'scheduled_campaigns', label: 'Scheduled Campaigns', schedule: 'Every 5 min', description: 'Marketing campaigns YOU prepared and scheduled in AI Marketing Campaigns' },
];

// Small cache so jobs that run every 5 minutes don't hit the DB on each run,
// while a pause still takes effect within ~30 seconds of saving.
let cache: { at: number; data: SmsAutomationSettings } | null = null;
const CACHE_MS = 30 * 1000;

export async function getSmsAutomationSettings(): Promise<SmsAutomationSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  let stored: Partial<SmsAutomationSettings> = {};
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'sms_automation' AND shop_id IS NULL LIMIT 1`);
    if (r.rows[0]?.value) {
      stored = typeof r.rows[0].value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0].value;
    }
  } catch (e: any) {
    console.warn('[SMS automation] Failed to read settings — using defaults:', e.message);
  }
  const data: SmsAutomationSettings = { ...SMS_AUTOMATION_DEFAULTS, ...stored };
  cache = { at: Date.now(), data };
  return data;
}

export async function saveSmsAutomationSettings(patch: Partial<SmsAutomationSettings>): Promise<SmsAutomationSettings> {
  const current = await getSmsAutomationSettings();
  const merged: SmsAutomationSettings = { ...SMS_AUTOMATION_DEFAULTS, ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in SMS_AUTOMATION_DEFAULTS && typeof v === 'boolean') {
      (merged as any)[k] = v;
    }
  }
  await pool.query(`DELETE FROM settings WHERE key = 'sms_automation' AND shop_id IS NULL`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('sms_automation', $1)`, [JSON.stringify(merged)]);
  cache = { at: Date.now(), data: merged };
  return merged;
}

/**
 * True when the given automatic job may run: the master switch is on AND the
 * job's own switch is on. Fail-open on unexpected errors is avoided on purpose
 * — a paused system must stay paused — but a DB hiccup falls back to defaults
 * (everything enabled), which is the pre-existing behaviour.
 */
export async function isSmsAutomationEnabled(job: SmsAutomationJobKey): Promise<boolean> {
  try {
    const s = await getSmsAutomationSettings();
    return s.master_enabled !== false && s[job] !== false;
  } catch {
    return true;
  }
}

export function clearSmsAutomationCache(): void {
  cache = null;
}
