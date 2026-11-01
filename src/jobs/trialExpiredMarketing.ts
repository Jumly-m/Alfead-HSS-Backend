import cron from 'node-cron';
import { sendTrialExpiredMarketing } from '../services/trial-marketing.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

/**
 * 7-day win-back campaign for tenants whose free trial has expired.
 * Sends one AI-written SMS + one AI-written email per day, for 7 days after
 * expiry, at 8:00 AM Tanzania time (EAT = UTC+3 → 05:00 UTC).
 */
export function startTrialExpiredMarketingCron() {
  cron.schedule('0 5 * * *', async () => {
    if (!(await isSmsAutomationEnabled('trial_expired_marketing'))) {
      console.log('[cron] Trial-expired marketing paused by developer — skipped');
      return;
    }
    console.log('[cron] Running 7-day trial-expired AI marketing (SMS + email)...');
    try {
      const result = await sendTrialExpiredMarketing();
      console.log('[cron] Trial marketing result:', result);
    } catch (e: any) {
      console.error('[cron] Trial marketing error:', e.message);
    }
  });

  console.log('[cron] Trial-expired AI marketing job registered (8:00 AM EAT, days 1-7)');
}
